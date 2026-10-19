/**
 * Recovery/resilience tests.
 *
 * These run the real `AgentSession` and LiveKit event machinery with the
 * provider replaced by `FakeRealtimeModel`, exactly like the interruption
 * suite. No network, credentials or audio devices are used.
 *
 * Covered:
 *  - a non-recoverable provider error closes the dead session and starts one
 *    fresh session (bounded);
 *  - a burst of errors cannot create duplicate sessions;
 *  - the restart budget is enforced and `onGiveUp` ends the job once;
 *  - a room that is already gone is never restarted;
 *  - room reconnecting/reconnected events do not create a second session;
 *  - the room listeners detach cleanly.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { initializeLogger, voice } from '@livekit/agents';
import { RoomEvent, type Room } from '@livekit/rtc-node';

import { createAgent } from '../src/agent.ts';
import {
  attachRoomLifecycle,
  isFatalProviderError,
  SessionSupervisor,
} from '../src/resilience.ts';
import { createAgentSession } from '../src/session.ts';
import { FakeRealtimeModel, RecordingAudioOutput } from './fake-realtime-model.ts';

initializeLogger({ pretty: false, level: 'silent' });

/** Let queued tasks and event propagation run to completion. */
async function settle(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

type Harness = {
  supervisor: SessionSupervisor;
  models: FakeRealtimeModel[];
  startedAttempts: number[];
  giveUps: string[];
  roomConnected: boolean;
};

/** Wire a supervisor to real AgentSessions over fake provider models. */
function harness(overrides: {
  maxRestarts?: number;
  backoffMs?: readonly number[];
} = {}): Harness {
  const models: FakeRealtimeModel[] = [];
  const startedAttempts: number[] = [];
  const giveUps: string[] = [];
  let roomConnected = true;

  const supervisor = new SessionSupervisor({
    createSession: () => {
      const model = new FakeRealtimeModel();
      models.push(model);
      return createAgentSession(model);
    },
    startSession: async (session) => {
      session.output.audio = new RecordingAudioOutput();
      await session.start({ agent: createAgent() });
    },
    onStarted: (_session, attempt) => {
      startedAttempts.push(attempt);
    },
    isRoomConnected: () => roomConnected,
    onGiveUp: (reason) => {
      giveUps.push(reason);
    },
    maxRestarts: overrides.maxRestarts,
    backoffMs: overrides.backoffMs ?? [0],
    sleep: async () => {},
  });

  return {
    supervisor,
    models,
    startedAttempts,
    giveUps,
    get roomConnected() {
      return roomConnected;
    },
    set roomConnected(value: boolean) {
      roomConnected = value;
    },
  } as Harness;
}

describe('SessionSupervisor', () => {
  it('replaces a dead provider session exactly once', async () => {
    const h = harness();
    await h.supervisor.start();
    assert.equal(h.models.length, 1);

    const first = h.models[0]!.activeSession!;
    first.simulateProviderDisconnect(1006);
    await settle();
    await h.supervisor.waitForRecovery();

    assert.equal(h.models.length, 2, 'exactly one replacement session');
    assert.equal(h.supervisor.restartAttempts, 1);
    assert.equal(first.closed, true, 'the dead session must be closed first');
    assert.deepEqual(h.startedAttempts, [0, 1], 'original start plus one recovery');
    assert.equal(h.supervisor.isStopped, false);
  });

  it('ignores a burst of fatal errors while a restart is in flight', async () => {
    const h = harness();
    await h.supervisor.start();

    const first = h.models[0]!.activeSession!;
    first.simulateProviderDisconnect(1006);
    first.simulateProviderDisconnect(1006);
    first.simulateProviderDisconnect(1006);
    await settle();
    await h.supervisor.waitForRecovery();

    assert.equal(h.models.length, 2, 'a burst must not create duplicate sessions');
    assert.equal(h.supervisor.restartAttempts, 1);
    assert.equal(h.startedAttempts.length, 2, 'one start per session, no duplicates');
  });

  it('gives up once after the restart budget is exhausted', async () => {
    const h = harness({ maxRestarts: 1 });
    await h.supervisor.start();

    h.models[0]!.activeSession!.simulateProviderDisconnect(1006);
    await settle();
    await h.supervisor.waitForRecovery();
    assert.equal(h.models.length, 2);

    h.models[1]!.activeSession!.simulateProviderDisconnect(1006);
    await settle();
    await h.supervisor.waitForRecovery();

    assert.equal(h.models.length, 2, 'no session beyond the restart budget');
    assert.equal(h.supervisor.isStopped, true);
    assert.equal(h.giveUps.length, 1, 'the job is ended exactly once');
    assert.match(h.giveUps[0]!, /no restarts left/);
  });

  it('never restarts when the room is already disconnected', async () => {
    const h = harness();
    await h.supervisor.start();

    h.roomConnected = false;
    h.models[0]!.activeSession!.simulateProviderDisconnect(1006);
    await settle();
    await h.supervisor.waitForRecovery();

    assert.equal(h.models.length, 1, 'no session may be created without a room');
    assert.equal(h.supervisor.isStopped, true);
    assert.equal(h.giveUps.length, 1);
    assert.match(h.giveUps[0]!, /room disconnected/);
  });

  it('stop() is idempotent and closes the live session', async () => {
    const h = harness();
    await h.supervisor.start();

    await h.supervisor.stop('test');
    await h.supervisor.stop('test-again');

    const session = h.models[0]!.activeSession!;
    assert.equal(session.closed, true);
    assert.equal(h.supervisor.isStopped, true);
  });

  it('start() cannot be called twice', async () => {
    const h = harness();
    await h.supervisor.start();
    await assert.rejects(() => h.supervisor.start(), /only be called once/);
  });
});


class FakeRoom extends EventEmitter {
  name = 'test-room';
  isConnected = true;
}

describe('attachRoomLifecycle', () => {
  it('logs and forwards room transitions without creating sessions', () => {
    const emitter = new FakeRoom();
    const room = emitter as unknown as Room;
    const seen: string[] = [];

    const detach = attachRoomLifecycle(room, {
      onReconnecting: () => seen.push('reconnecting'),
      onReconnected: () => seen.push('reconnected'),
      onDisconnected: () => seen.push('disconnected'),
    });

    emitter.emit(RoomEvent.Reconnecting);
    emitter.emit(RoomEvent.Reconnected);
    emitter.emit(RoomEvent.Disconnected, 1);

    assert.deepEqual(seen, ['reconnecting', 'reconnected', 'disconnected']);

    detach();
    emitter.emit(RoomEvent.Reconnecting);
    assert.deepEqual(seen, ['reconnecting', 'reconnected', 'disconnected']);
  });
});

describe('isFatalProviderError', () => {
  it('only treats a non-recoverable realtime model error as fatal', () => {
    const base = {
      type: 'realtime_model_error' as const,
      timestamp: Date.now(),
      label: 'realtime_model',
      error: new Error('connection lost'),
    };

    assert.equal(isFatalProviderError({ ...base, recoverable: false }), true);
    assert.equal(isFatalProviderError({ ...base, recoverable: true }), false);
  });
});

