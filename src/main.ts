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
import { attachRoomLifecycle, SessionSupervisor } from './resilience.ts';
import {
  createAgentSession,
  describeTurnHandling,
  resolveRoomInputOptions,
  resolveRoomOutputOptions,
} from './session.ts';

// Load .env before anything reads process.env (ServerOptions resolves
// LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET when it is constructed).
// Resolved relative to this file rather than the current working directory, so
// the agent also picks up .env when launched from another directory (e.g. a
// process manager or `lk agent start`).
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // Detached when the job ends; assigned before the room is connected.
    let detachRoom = (): void => {};

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

      // One supervisor owns the (single) live AgentSession for this job. It
      // replaces a dead provider session at most twice, and only after the old
      // session has been closed, so a retry cannot duplicate audio.
      const supervisor = new SessionSupervisor({
        createSession: () => createAgentSession(createRealtimeModel(process.env)),
        startSession: async (session) => {
          // Interruption lifecycle, observed through public session events only.
          // Correlate these against a recording: `user state listening` (Opal
          // heard speech) should be followed by `agent state` leaving
          // `speaking`, then by `speech created` for the next turn.
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
            inputOptions: resolveRoomInputOptions(),
            outputOptions: resolveRoomOutputOptions(),
          });
        },
        onStarted: async (session, attempt) => {
          if (attempt === 0) {
            // Speak first so the participant can immediately confirm that real
            // audio is flowing in both directions.
            await session.generateReply({ instructions: GREETING_INSTRUCTIONS });
            logInfo('greeting requested');
          } else {
            // Do not replay the greeting after a recovery; the caller is
            // already in the conversation and can keep talking.
            logInfo('session restarted; greeting skipped', { attempt });
          }
        },
        isRoomConnected: () => ctx.room.isConnected,
        onGiveUp: (reason) => {
          // End the job once. Do not throw here: a failed job may be
          // redispatched, which would create a duplicate session.
          logWarn('ending the job because the voice session cannot recover', { reason });
          ctx.shutdown(reason);
        },
      });

      // LiveKit reconnects the room itself; these handlers only log and end
      // the job on a terminal disconnect. They never call `ctx.connect()`
      // again and never create a second session.
      detachRoom = attachRoomLifecycle(ctx.room, {
        onDisconnected: () => {
          void supervisor.stop('room_disconnected');
          ctx.shutdown('room disconnected');
        },
      });

      ctx.addShutdownCallback(async () => {
        detachRoom();
        await supervisor.stop('job_shutdown');
      });

      // Connect to the room before starting the session: this is the order the
      // official Opal quick start uses, and it guarantees audio output is
      // attached to a live room before Opal can speak.
      await ctx.connect();
      logInfo('agent connected to room', { room: ctx.room.name });

      await supervisor.start();
    } catch (error) {
      detachRoom();
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
