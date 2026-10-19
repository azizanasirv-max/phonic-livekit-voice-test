/**
 * Agent entry point.
 *
 * Starts a LiveKit agent server that, for every dispatched room job, opens a
 * speech-to-speech session with Deepslate Opal via `@deepslate-labs/livekit`.
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
import {
  createRealtimeModel,
  describeTtsConfig,
  resolveOpalOptions,
} from './deepslate.ts';
import { GREETING_INSTRUCTIONS } from './instructions.ts';
import { describeError, logError, logInfo, logWarn } from './logging.ts';
import { createAgentSession, describeTurnHandling } from './session.ts';

// Load .env before anything reads process.env (ServerOptions resolves
// LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET when it is constructed).
// Resolved relative to this file rather than the current working directory, so
// the agent also picks up .env when launched from another directory (e.g. a
// process manager or `lk agent start`).
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

export default defineAgent({
  entry: async (ctx: JobContext) => {
    try {
      // Deepslate needs its three IDs/key; LiveKit needs its URL/key/secret.
      // Validating here means a misconfigured job fails before any provider
      // connection or billable minute, with no credential values in the log.
      assertRequiredEnv(process.env);

      const opalOptions = resolveOpalOptions();

      logInfo('job accepted', {
        room: ctx.room.name,
        opalModel: opalOptions.model ?? '(platform default)',
        tts: describeTtsConfig(opalOptions.tts),
      });

      // The turn-handling policy is fixed (see src/session.ts). Log it once per
      // job so a run can be matched against the settings it was recorded with.
      logInfo('turn handling policy', { policy: describeTurnHandling() });

      // Opal replaces the STT/LLM/TTS pipeline with one realtime model. It is
      // given the same instructions as the LiveKit agent, so the first turn is
      // already shaped correctly.
      const session = createAgentSession(createRealtimeModel(process.env));

      // Surface session-level problems (connection drops, provider errors) with
      // redacted messages instead of letting them fail silently.
      session.on(voice.AgentSessionEventTypes.Error, (event) => {
        logError('session error', event.error);
      });

      // Interruption lifecycle, observed through public session events only.
      // Correlate these against a recording: `user state listening` (Opal heard
      // speech) should be followed by `agent state` leaving `speaking`, then by
      // `speech created` for the next turn.
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

      // Connect to the room before starting the session: this is the order the
      // official Opal quick start uses, and it guarantees audio output is
      // attached to a live room before Opal can speak.
      await ctx.connect();
      logInfo('agent connected to room', { room: ctx.room.name });

      await session.start({
        agent: createAgent(),
        room: ctx.room,
      });

      // Speak first so the participant can immediately confirm that real audio
      // is flowing in both directions.
      await session.generateReply({ instructions: GREETING_INSTRUCTIONS });
      logInfo('greeting requested');
    } catch (error) {
      // Config errors, provider connection failures and room failures all land
      // here. Re-throw so the LiveKit worker records the job as failed.
      logError('job failed', error, { room: ctx.room.name });
      logWarn(`detail: ${describeError(error)}`);
      throw error;
    }
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
