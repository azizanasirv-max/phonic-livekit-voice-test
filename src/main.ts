/**
 * Agent entry point.
 *
 * Starts a LiveKit agent server that, for every dispatched room job, opens a
 * speech-to-speech session with Phonic via @livekit/agents-plugin-phonic.
 *
 * Usage:
 *   node src/main.ts dev      # development worker (also works with `lk agent dev`)
 *   node src/main.ts start    # production-style worker
 */
import { type JobContext, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.ts';
import { assertRequiredEnv, readEnv, resolveDiagnosticsOptions, safeEnvSummary } from './config.ts';
import { createSessionDiagnostics, newSessionId } from './diagnostics.ts';
import { GREETING_INSTRUCTIONS } from './instructions.ts';
import { describeError, logError, logInfo, logWarn } from './logging.ts';
import { createRealtimeModel, resolvePhonicOptions } from './phonic.ts';

// Load .env before anything reads process.env (ServerOptions resolves
// LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET when it is constructed).
// Resolved relative to this file rather than the current working directory, so
// the agent also picks up .env when launched from another directory (e.g. a
// process manager or `lk agent start`).
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // Phonic is the only credential this code reads directly. LiveKit's own
    // variables (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET) are
    // validated by the agent server with clear errors when it starts.
    assertRequiredEnv(process.env, ['PHONIC_API_KEY']);

    logInfo('job accepted', {
      room: ctx.room.name,
      voice: resolvePhonicOptions().voice,
    });

    const session = new voice.AgentSession({
      // Phonic replaces the STT/LLM/TTS pipeline with a single
      // speech-to-speech model. It reads PHONIC_API_KEY from the environment.
      llm: createRealtimeModel(process.env, (conversationId) => {
        logInfo('phonic conversation created', { conversationId });
      }),
    });

    // --- Stage 0 diagnostics (opt-in via DIAG_* env flags) ---
    // Read-only instrumentation: a per-turn event timeline and WebRTC statistics
    // snapshots. Disabled by default, and records metadata only — never
    // credentials, raw audio, or transcript content. It does not change turn
    // detection, interruption handling, buffering, or model configuration.
    const diagOptions = resolveDiagnosticsOptions(process.env);
    const diagnostics = createSessionDiagnostics({
      sessionId: newSessionId(),
      session,
      eventNames: {
        userStateChanged: voice.AgentSessionEventTypes.UserStateChanged,
        agentStateChanged: voice.AgentSessionEventTypes.AgentStateChanged,
        speechCreated: voice.AgentSessionEventTypes.SpeechCreated,
        conversationItemAdded: voice.AgentSessionEventTypes.ConversationItemAdded,
        error: voice.AgentSessionEventTypes.Error,
        close: voice.AgentSessionEventTypes.Close,
      },
      timeline: diagOptions.timeline,
      rtc: diagOptions.rtcStats
        ? { source: ctx.room, intervalMs: diagOptions.rtcIntervalMs }
        : undefined,
    });
    if (diagOptions.timeline || diagOptions.rtcStats) {
      logInfo('diagnostics enabled', {
        sessionId: diagnostics.sessionId,
        timeline: diagOptions.timeline,
        rtcStats: diagOptions.rtcStats,
        rtcIntervalMs: diagOptions.rtcIntervalMs,
      });
    }
    // Stop sampling when the session ends (covers disconnect and shutdown).
    session.on(voice.AgentSessionEventTypes.Close, () => {
      void diagnostics.stop();
    });

    // Surface session-level problems (connection drops, provider errors) with
    // redacted messages instead of letting them fail silently.
    session.on(voice.AgentSessionEventTypes.Error, (event) => {
      logError('session error', event.error);
    });

    await session.start({
      agent: createAgent(),
      room: ctx.room,
    });

    // Join the room, then speak first.
    await ctx.connect();
    logInfo('agent connected to room', { room: ctx.room.name });

    // Begin RTC sampling now that the room is connected (no-op when disabled).
    diagnostics.startRtcSampling();

    await session.generateReply({ instructions: GREETING_INSTRUCTIONS });
  },
});

// Run the agent server. The `agent` option points at this file so job
// subprocesses can import the default export above.
try {
  logInfo('starting agent server', safeEnvSummary());
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      // With LIVEKIT_AGENT_NAME unset, the SDK uses automatic dispatch: the
      // agent joins every new room in the project. That is the simplest setup
      // for a prototype. Setting it enables explicit dispatch (the room token
      // must then request this agent name, and `lk agent dev` uses it).
      agentName: readEnv('LIVEKIT_AGENT_NAME'),
    }),
  );
} catch (error) {
  // Most likely cause: bad credentials or an unreachable LIVEKIT_URL.
  logError('agent server failed to start', error);
  logWarn(`detail: ${describeError(error)}`);
  process.exitCode = 1;
}
