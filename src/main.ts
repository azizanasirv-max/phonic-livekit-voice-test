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
import { assertRequiredEnv, readEnv, safeEnvSummary } from './config.ts';
import { GREETING_INSTRUCTIONS } from './instructions.ts';
import { describeError, logError, logInfo, logWarn } from './logging.ts';
import { createRealtimeModel, resolvePhonicOptions } from './phonic.ts';
import { createAgentSession, describeTurnHandling } from './session.ts';

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

    const phonicOptions = resolvePhonicOptions();

    logInfo('job accepted', {
      room: ctx.room.name,
      voice: phonicOptions.voice,
    });

    // The turn-handling policy is fixed (see src/session.ts). Log it once per
    // job so a run can be matched against the settings it was recorded with.
    logInfo('turn handling policy', { policy: describeTurnHandling() });

    if (phonicOptions.minWordsToInterrupt > 1) {
      logWarn('Phonic will not stop the assistant until the user has spoken this many words', {
        minWordsToInterrupt: phonicOptions.minWordsToInterrupt,
        effect: "the assistant keeps speaking over the start of the user's interruption",
      });
    }

    const session = createAgentSession(
      // Phonic replaces the STT/LLM/TTS pipeline with a single
      // speech-to-speech model. It reads PHONIC_API_KEY from the environment.
      createRealtimeModel(process.env, (conversationId) => {
        logInfo('phonic conversation created', { conversationId });
      }),
    );

    // Surface session-level problems (connection drops, provider errors) with
    // redacted messages instead of letting them fail silently.
    session.on(voice.AgentSessionEventTypes.Error, (event) => {
      logError('session error', event.error);
    });

    // Interruption lifecycle, observed through public session events only. These
    // lines are what you correlate against a recording to measure how long the
    // assistant kept talking after the user started: `user_state listening`
    // (Phonic heard speech) should be immediately followed by `agent_state`
    // leaving `speaking`, and by `speech created` for the next turn.
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

    await session.start({
      agent: createAgent(),
      room: ctx.room,
    });

    // Join the room, then speak first.
    await ctx.connect();
    logInfo('agent connected to room', { room: ctx.room.name });

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
