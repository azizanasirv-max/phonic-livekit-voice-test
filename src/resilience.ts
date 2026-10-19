/**
 * Runtime resilience for the LiveKit job/session lifecycle.
 *
 * Three failures are handled here, and nothing else:
 *
 * 1. **Provider/network loss.** `@deepslate-labs/livekit@0.1.23` already
 *    reconnects its own WebSocket (`@deepslate-labs/core` uses
 *    `maxRetries: 3` with exponential backoff). When those retries are
 *    exhausted it emits a non-recoverable `realtime_model_error` and the
 *    provider session is dead, even though LiveKit's `AgentSession` keeps
 *    running. This supervisor closes that dead session and starts a *new*
 *    `AgentSession` — at most `maxRestarts` times per job, with one restart
 *    in flight at a time, so a burst of errors cannot create duplicate
 *    sessions.
 *
 * 2. **Room loss.** `@livekit/rtc-node` reconnects the room itself and emits
 *    `RoomEvent.Reconnecting` / `Reconnected`. Those are logged only; the
 *    voice session is *not* restarted on a room reconnect, because the
 *    existing session and audio tracks stay valid and a second session would
 *    speak over the first. A terminal `RoomEvent.Disconnected` stops the
 *    supervisor and ends the job.
 *
 * 3. **Job shutdown.** The job runner invokes the registered shutdown
 *    callback, which closes the session before the process can be reused or
 *    the job retried. That prevents a stale session from outliving its job.
 *
 * There is deliberately no unbounded retry loop and no throw after a room
 * connection: a job that cannot recover ends once and reports through
 * `onGiveUp`, so LiveKit is not asked to redispatch and create duplicate
 * jobs.
 */
import { voice } from '@livekit/agents';
import { DisconnectReason, type Room, RoomEvent } from '@livekit/rtc-node';

import { describeError, logError, logInfo, logWarn } from './logging.ts';

/** Restarts allowed per job after the provider session is declared dead. */
export const DEFAULT_MAX_SESSION_RESTARTS = 2;

/**
 * Delay before each restart. The provider client already backs off for its
 * own three retries; these short pauses cover the gap between a dead session
 * being detected and a fresh one being created.
 */
export const DEFAULT_RESTART_BACKOFF_MS: readonly number[] = [500, 1500];

export type SessionSupervisorOptions = {
  /** Create a fresh `AgentSession` (and, in production, a fresh model). */
  createSession: () => voice.AgentSession;
  /** Start the session (room attachment, output options, etc.). */
  startSession: (session: voice.AgentSession) => Promise<void>;
  /**
   * Called after every successful start. `attempt` is 0 for the first
   * session and 1..N for recoveries, so callers can greet only once.
   */
  onStarted?: (session: voice.AgentSession, attempt: number) => Promise<void> | void;
  /** Whether the room can still carry a session. Defaults to `true`. */
  isRoomConnected?: () => boolean;
  /**
   * Called once when recovery is impossible. The caller should end the job
   * (for example with `JobContext.shutdown`) instead of throwing.
   */
  onGiveUp?: (reason: string) => void;
  maxRestarts?: number;
  backoffMs?: readonly number[];
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

/** True for the plugin's fatal provider error (`recoverable: false`). */
export function isFatalProviderError(error: voice.ErrorEvent['error']): boolean {
  return error.type === 'realtime_model_error' && error.recoverable === false;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });


/**
 * Owns exactly one live `AgentSession` at a time.
 *
 * `start()` must be called once. After that, fatal provider errors trigger a
 * bounded, serialized restart; `stop()` is idempotent and safe to call from a
 * job shutdown callback or a room-disconnect handler.
 */
export class SessionSupervisor {
  private readonly options: SessionSupervisorOptions;
  private readonly maxRestarts: number;
  private readonly backoffMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;

  private session: voice.AgentSession | undefined;
  private errorListener: ((event: voice.ErrorEvent) => void) | undefined;
  private closeListener: ((event: voice.CloseEvent) => void) | undefined;

  private started = false;
  private stopped = false;
  private restartCount = 0;
  private recovery: Promise<void> | undefined;

  constructor(options: SessionSupervisorOptions) {
    this.options = options;
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_SESSION_RESTARTS;
    this.backoffMs = options.backoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.sleep = options.sleep ?? realSleep;
  }

  /** The session that is currently allowed to run, if any. */
  get currentSession(): voice.AgentSession | undefined {
    return this.session;
  }

  /** Successful recoveries so far (0 means only the original session ran). */
  get restartAttempts(): number {
    return this.restartCount;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Create and start the first session. Throws if the initial start fails. */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('SessionSupervisor.start() may only be called once');
    }
    if (this.stopped) {
      throw new Error('SessionSupervisor cannot be started after stop()');
    }
    this.started = true;

    const session = this.createAndWatch();
    try {
      await this.options.startSession(session);
      await this.options.onStarted?.(session, 0);
    } catch (error) {
      await this.closeSession(session);
      throw error;
    }
  }

  /** Await the restart currently in flight, if any. Used by tests. */
  async waitForRecovery(): Promise<void> {
    const recovery = this.recovery;
    if (recovery !== undefined) await recovery;
  }

  /**
   * Stop the supervisor and close the live session.
   *
   * Idempotent. Does not wait for an in-flight recovery loop to finish: that
   * loop re-checks `stopped` after every await and will not create a session
   * once this has run.
   */
  async stop(reason = 'stopped'): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    logInfo('session supervisor stopping', { reason, restarts: this.restartCount });
    await this.closeCurrent();
  }

  /** Attach listeners and make this the one current session. */
  private createAndWatch(): voice.AgentSession {
    const session = this.options.createSession();
    this.session = session;

    this.errorListener = (event: voice.ErrorEvent) => {
      if (session !== this.session) return;
      if (event.error.type === 'realtime_model_error' && !event.error.recoverable) {
        logError('fatal provider error', event.error.error, {
          recoverable: event.error.recoverable,
        });
        this.handleFatal('provider_error');
        return;
      }
      // Non-fatal provider notifications stay on the same session.
      const detail =
        event.error.type === 'realtime_model_error'
          ? event.error.error
          : new Error(`session error: ${event.error.type}`);
      logWarn('provider error (non-fatal)', { error: describeError(detail) });
    };

    this.closeListener = (event: voice.CloseEvent) => {
      if (session !== this.session) return;
      if (event.error !== null || event.reason === voice.CloseReason.ERROR) {
        logWarn('session closed with an error', { reason: String(event.reason) });
        this.handleFatal('session_closed');
      }
    };

    session.on(voice.AgentSessionEventTypes.Error, this.errorListener);
    session.on(voice.AgentSessionEventTypes.Close, this.closeListener);
    return session;
  }

  /** Detach the listeners belonging to a session. */
  private detach(session: voice.AgentSession): void {
    if (this.errorListener !== undefined) {
      session.off(voice.AgentSessionEventTypes.Error, this.errorListener);
    }
    if (this.closeListener !== undefined) {
      session.off(voice.AgentSessionEventTypes.Close, this.closeListener);
    }
    this.errorListener = undefined;
    this.closeListener = undefined;
  }

  private async closeCurrent(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session !== undefined) await this.closeSession(session);
  }

  private async closeSession(session: voice.AgentSession): Promise<void> {
    this.detach(session);
    try {
      await session.close();
    } catch (error) {
      // A session whose provider socket already died can fail during close.
      logWarn('closing the voice session failed', { error: describeError(error) });
    }
  }

  private handleFatal(reason: string): void {
    if (this.stopped || this.session === undefined) return;

    if (this.restartCount >= this.maxRestarts) {
      this.giveUp(`no restarts left after ${reason}`);
      return;
    }

    this.scheduleRecovery(reason);
  }


  /**
   * Serialize recovery. A second fatal error while a restart is already in
   * flight is ignored, which is what prevents duplicate sessions.
   */
  private scheduleRecovery(reason: string): void {
    if (this.stopped || this.recovery !== undefined) return;

    const attempt = this.restartCount + 1;
    const delay =
      this.backoffMs[this.restartCount] ?? this.backoffMs[this.backoffMs.length - 1] ?? 0;

    logWarn('scheduling provider session recovery', { reason, attempt, delayMs: delay });

    this.recovery = (async () => {
      if (delay > 0) await this.sleep(delay);
      if (!this.canRestart()) {
        this.giveUp('room disconnected before restart');
        return;
      }

      // The old session must be fully closed before a new one is created.
      await this.closeCurrent();
      if (!this.canRestart()) {
        this.giveUp('room disconnected while restarting');
        return;
      }

      const session = this.createAndWatch();
      await this.options.startSession(session);
      if (this.stopped) {
        await this.closeSession(session);
        return;
      }

      this.restartCount = attempt;
      await this.options.onStarted?.(session, attempt);
      if (this.stopped) return;

      logInfo('provider session recovered', {
        attempt,
        restarts: this.restartCount,
      });
    })()
      .catch((error) => {
        logError('provider session recovery failed', error, { attempt });
        this.giveUp('restart failed');
      })
      .finally(() => {
        this.recovery = undefined;
      });
  }

  private canRestart(): boolean {
    if (this.stopped) return false;
    return this.options.isRoomConnected?.() ?? true;
  }

  private giveUp(reason: string): void {
    if (this.stopped) return;
    logError('voice session cannot recover', new Error(reason), {
      restarts: this.restartCount,
    });
    this.options.onGiveUp?.(reason);
    void this.stop(reason);
  }
}


export type RoomLifecycleHandlers = {
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onDisconnected?: (reason: DisconnectReason) => void;
};

/**
 * Log LiveKit room connection transitions and surface the terminal one.
 *
 * `@livekit/rtc-node` owns reconnection; this helper must never call
 * `room.connect()` again. The returned function detaches every listener.
 */
export function attachRoomLifecycle(room: Room, handlers: RoomLifecycleHandlers = {}): () => void {
  const onReconnecting = (): void => {
    logWarn('room reconnecting', { room: room.name });
    handlers.onReconnecting?.();
  };
  const onReconnected = (): void => {
    logInfo('room reconnected', { room: room.name });
    handlers.onReconnected?.();
  };
  const onDisconnected = (reason: DisconnectReason): void => {
    logWarn('room disconnected', {
      room: room.name,
      reason: DisconnectReason[reason] ?? String(reason),
    });
    handlers.onDisconnected?.(reason);
  };

  room.on(RoomEvent.Reconnecting, onReconnecting);
  room.on(RoomEvent.Reconnected, onReconnected);
  room.on(RoomEvent.Disconnected, onDisconnected);

  return () => {
    room.off(RoomEvent.Reconnecting, onReconnecting);
    room.off(RoomEvent.Reconnected, onReconnected);
    room.off(RoomEvent.Disconnected, onDisconnected);
  };
}

