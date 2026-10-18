/**
 * Agent entry point.
 *
 * Starts a LiveKit agent server that, for every dispatched room job, opens a
 * realtime session with Deepslate Opal via @deepslate-labs/livekit.
 *
 * Usage:
 *   node src/main.ts dev      # development worker (also works with `lk agent dev`)
 *   node src/main.ts start    # production-style worker
 */
import { type JobContext, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.ts';
import { readEnv, safeEnvSummary } from './config.ts';
import {
  createRealtimeModel,
  describeVoiceOutput,
  resolveDeepslateConfig,
} from './deepslate.ts';
import { GREETING_INSTRUCTIONS } from './instructions.ts';
import { describeError, logError, logInfo } from './logging.ts';
import { createAgentSession, describeTurnHandling } from './session.ts';

// Load .env before anything reads process.env (ServerOptions resolves
// LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET when it is constructed).
// Resolved relative to this file rather than the current working directory, so
// the agent also picks up .env when launched from another directory (e.g. a
// process manager or `lk agent start`).
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // Deepslate credentials and the server-side TTS config are validated here,
    // before a session is opened, so a missing value fails one job with a clear
    // message instead of surfacing as a dropped connection. LiveKit's own
    // variables are validated by the agent server with clear errors when it
    // starts.
    const config = resolveDeepslateConfig();
    const voiceOutput = describeVoiceOutput(config.ttsConfig);

    logInfo('job accepted', {
      room: ctx.room.name,
      provider: 'deepslate',
      model: config.model ?? '(platform default)',
      voiceProvider: voiceOutput.provider,
      voiceId: voiceOutput.voiceId,
    });

    // The turn-handling policy is fixed (see src/session.ts). Log it once per
    // job so a run can be matched against the settings it was recorded with.
    logInfo('turn handling policy', { policy: describeTurnHandling() });

    const session = createAgentSession(
      // Opal replaces the STT/LLM/TTS pipeline with one realtime model. Audio
      // output is produced by Deepslate's server-side TTS configured above.
      createRealtimeModel(process.env),
    );

    // Surface session-level problems (connection drops, provider errors) with
    // redacted messages instead of letting them fail silently.
    session.on(voice.AgentSessionEventTypes.Error, (event) => {
      logError('session error', event.error);
    });

    // Interruption lifecycle, observed through public session events only. These
    // lines are what you correlate against a recording to measure how long the
    // assistant kept talking after the user started: `user_state listening`
    // (Deepslate's VAD heard speech) should be immediately followed by
    // `agent_state` leaving `speaking`, and by `speech created` for the next
    // turn.
    session.on(voice.AgentSessionEventTypes.SpeechCreated, (event) => {
      logInfo('speech created', {
        speechId: event.speechHandle.id,
        source: event.source,
        userInitiated: event.userInitiated,
      });
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
      logInfo('agent state', { oldState: event.oldState, newState: event.newState });
    });

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
      logInfo('user state', { oldState: event.oldState, newState: event.newState });
    });

    // Join the room first (as in Deepslate's official LiveKit example), then
    // start the session so Opal's first turn has somewhere to play.
    await ctx.connect();
    logInfo('agent connected to room', { room: ctx.room.name });

    await session.start({
      agent: createAgent(),
      room: ctx.room,
    });

    await session.generateReply({ instructions: GREETING_INSTRUCTIONS });
  },
});

// Run the agent server. The `agent` option points at this file so job
// subprocesses can import the default export above.
try {
  // Fail fast on missing Deepslate credentials or voice output, before the
  // server starts retrying a connection. Messages never include values.
  const startupConfig = resolveDeepslateConfig();
  const startupVoice = describeVoiceOutput(startupConfig.ttsConfig);
  logInfo('starting agent server', {
    ...safeEnvSummary(),
    voiceProvider: startupVoice.provider,
    voiceId: startupVoice.voiceId,
  });
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
  // Most likely cause: missing/invalid Deepslate credentials or voice output,
  // or an unreachable LIVEKIT_URL.
  logError('agent server failed to start', error);
  logInfo('startup failure detail', { detail: describeError(error) });
  process.exitCode = 1;
}
