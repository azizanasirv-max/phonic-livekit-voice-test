/**
 * Tests for the Stage 0 diagnostics instrumentation.
 *
 * Pure/unit only: no network, no LiveKit imports, no native media bindings.
 * The `getRtcStats()` result is exercised as a plain object shaped like the
 * protobuf message, which is exactly how the code reads it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractRtcSnapshot,
  summarizeRtcSnapshot,
  RtcStatsSampler,
  TurnTimeline,
  createSessionDiagnostics,
  type DiagLogSink,
  type SessionEventNames,
} from '../src/diagnostics.ts';
import {
  DEFAULT_RTC_INTERVAL_MS,
  MAX_RTC_INTERVAL_MS,
  MIN_RTC_INTERVAL_MS,
  readBoolEnv,
  resolveDiagnosticsOptions,
} from '../src/config.ts';

const NAMES: SessionEventNames = {
  userStateChanged: 'user_state_changed',
  agentStateChanged: 'agent_state_changed',
  speechCreated: 'speech_created',
  conversationItemAdded: 'conversation_item_added',
  error: 'error',
  close: 'close',
};

type LogLine = { message: string; fields: Record<string, unknown> };

function captureLog(): { log: DiagLogSink; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return { log: (message, fields) => lines.push({ message, fields }), lines };
}

/** Minimal EventEmitter-shaped stand-in for `AgentSession`. */
class FakeSession {
  readonly handlers = new Map<string, Array<(event: any) => void>>();
  onCount = 0;
  on(type: string, handler: (event: any) => void): this {
    this.onCount += 1;
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    return this;
  }
  emit(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

/** A controllable interval scheduler for deterministic sampler tests. */
function makeScheduler() {
  let callback: (() => void) | undefined;
  let clearedCount = 0;
  return {
    setIntervalFn: (cb: () => void, _ms: number): { unref: () => void } => {
      callback = cb;
      return { unref: () => undefined };
    },
    clearIntervalFn: (): void => {
      clearedCount += 1;
      callback = undefined;
    },
    fire: (): void => callback?.(),
    get clearedCount(): number {
      return clearedCount;
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A realistic `getRtcStats()` result with one entry per handled oneof case. */
function statsFixture() {
  return {
    publisherStats: [
      {
        stats: {
          case: 'outboundRtp',
          value: {
            rtc: { id: 'O1' },
            stream: { ssrc: 42, kind: 'audio' },
            sent: { packetsSent: 1200n },
            outbound: { nackCount: 3, retransmittedPacketsSent: 7n, targetBitrate: 32000 },
          },
        },
      },
      {
        stats: {
          case: 'transport',
          value: {
            rtc: { id: 'T1' },
            transport: {
              packetsSent: 1200n,
              packetsReceived: 900n,
              dtlsState: 2,
              iceState: 3,
              selectedCandidatePairChanges: 1,
            },
          },
        },
      },
    ],
    subscriberStats: [
      {
        stats: {
          case: 'inboundRtp',
          value: {
            rtc: { id: 'I1' },
            stream: { ssrc: 7, kind: 'audio' },
            received: { packetsReceived: 900n, packetsLost: 4n, jitter: 0.012 },
            inbound: {
              nackCount: 1,
              jitterBufferDelay: 1.5,
              jitterBufferEmittedCount: 100n,
              concealedSamples: 240n,
              concealmentEvents: 2n,
              framesDropped: 1,
            },
          },
        },
      },
      {
        stats: {
          case: 'remoteInboundRtp',
          value: {
            rtc: { id: 'R1' },
            stream: { ssrc: 7, kind: 'audio' },
            remoteInbound: { roundTripTime: 0.085, fractionLost: 0.01 },
          },
        },
      },
      {
        stats: {
          case: 'candidatePair',
          value: {
            rtc: { id: 'P1' },
            candidatePair: {
              state: 4,
              nominated: true,
              currentRoundTripTime: 0.09,
              availableIncomingBitrate: 400000,
            },
          },
        },
      },
      {
        stats: {
          case: 'peerConnection',
          value: { rtc: { id: 'PC1' }, pc: { dataChannelsOpened: 1, dataChannelsClosed: 0 } },
        },
      },
      {
        stats: {
          case: 'mediaPlayout',
          value: {
            rtc: { id: 'MP1' },
            audioPlayout: { kind: 'audio', synthesizedSamplesEvents: 2, totalSamplesCount: 48000n },
          },
        },
      },
      { stats: { case: 'certificate', value: { rtc: { id: 'C1' } } } },
    ],
  };
}

describe('extractRtcSnapshot', () => {
  it('normalizes each handled oneof case and converts bigint counters', () => {
    const snapshot = extractRtcSnapshot(statsFixture());

    assert.equal(snapshot.publisher.length, 1);
    assert.equal(snapshot.subscriber.length, 2);
    assert.equal(snapshot.connections.length, 3);
    assert.equal(snapshot.playout.length, 1);
    assert.equal(snapshot.unknownEntries, 1);

    const inbound = snapshot.subscriber.find((s) => s.id === 'I1');
    assert.equal(inbound?.packetsReceived, 900);
    assert.equal(inbound?.packetsLost, 4);
    assert.equal(inbound?.jitter, 0.012);
    assert.equal(inbound?.nackCount, 1);
    assert.equal(inbound?.concealedSamples, 240);

    const outbound = snapshot.publisher.find((s) => s.id === 'O1');
    assert.equal(outbound?.packetsSent, 1200);
    assert.equal(outbound?.nackCount, 3);
    assert.equal(outbound?.retransmittedPacketsSent, 7);

    const transport = snapshot.connections.find((c) => c.type === 'transport');
    assert.equal(transport?.iceState, 'completed');
    assert.equal(transport?.dtlsState, 'connected');
    const pair = snapshot.connections.find((c) => c.type === 'candidatePair');
    assert.equal(pair?.candidatePairState, 'succeeded');
    assert.equal(pair?.nominated, true);
    assert.equal(snapshot.playout[0]?.totalSamplesCount, 48000);
  });

  it('returns an empty snapshot for missing, empty, or malformed input', () => {
    for (const input of [undefined, null, {}, { publisherStats: 'nope' }, 42]) {
      const snapshot = extractRtcSnapshot(input);
      assert.deepEqual(snapshot, {
        publisher: [],
        subscriber: [],
        connections: [],
        playout: [],
        unknownEntries: 0,
      });
    }
  });

  it('drops absent fields instead of throwing (version-skew tolerance)', () => {
    const snapshot = extractRtcSnapshot({
      subscriberStats: [{ stats: { case: 'inboundRtp', value: { rtc: { id: 'x' } } } }],
    });
    assert.equal(snapshot.subscriber.length, 1);
    assert.equal(snapshot.subscriber[0]?.id, 'x');
    assert.equal(snapshot.subscriber[0]?.packetsLost, undefined);
  });
});

describe('summarizeRtcSnapshot', () => {
  it('converts seconds to ms and aggregates audio quality fields', () => {
    const summary = summarizeRtcSnapshot(extractRtcSnapshot(statsFixture()));

    assert.equal(summary.audioInPacketsReceived, 900);
    assert.equal(summary.audioInPacketsLost, 4);
    assert.equal(summary.audioInJitterMs, 12); // 0.012 s
    assert.equal(summary.audioInJitterBufferAvgMs, 15); // (1.5 / 100) s
    assert.equal(summary.audioInNackCount, 1);
    assert.equal(summary.audioInConcealedSamples, 240);
    assert.equal(summary.audioInConcealmentEvents, 2);
    assert.equal(summary.audioInFramesDropped, 1);
    assert.equal(summary.audioOutPacketsSent, 1200);
    assert.equal(summary.audioOutNackCount, 3);
    assert.equal(summary.audioOutRetransmittedPacketsSent, 7);
    assert.equal(summary.rttMs, 85); // 0.085 s from remoteInboundRtp
    assert.equal(summary.iceState, 'completed');
    assert.equal(summary.dtlsState, 'connected');
    assert.equal(summary.candidatePairState, 'succeeded');
  });

  it('preserves a zero packet-loss figure (0 is meaningful)', () => {
    const summary = summarizeRtcSnapshot(
      extractRtcSnapshot({
        subscriberStats: [
          {
            stats: {
              case: 'inboundRtp',
              value: {
                rtc: { id: 'I' },
                stream: { kind: 'audio' },
                received: { packetsReceived: 500n, packetsLost: 0n },
              },
            },
          },
        ],
      }),
    );
    assert.equal(summary.audioInPacketsLost, 0);
  });

  it('returns no fields when nothing was available', () => {
    assert.deepEqual(summarizeRtcSnapshot(extractRtcSnapshot({})), {});
  });
});

describe('RtcStatsSampler', () => {
  it('samples on the interval and logs a compact summary', async () => {
    const scheduler = makeScheduler();
    const { log, lines } = captureLog();
    const sampler = new RtcStatsSampler({
      source: { getRtcStats: async () => statsFixture() },
      sessionId: 's1',
      intervalMs: 5000,
      now: () => 1234,
      wallNow: () => 1700000000000,
      log,
      setIntervalFn: scheduler.setIntervalFn,
      clearIntervalFn: scheduler.clearIntervalFn,
    });
    sampler.start();
    assert.equal(sampler.isRunning, true);
    sampler.start(); // idempotent
    scheduler.fire();
    await flush();
    scheduler.fire();
    await flush();
    assert.equal(sampler.samples, 2);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.message, 'diag: rtc_stats');
    assert.equal(lines[0]?.fields.sessionId, 's1');
    assert.equal(lines[0]?.fields.audioInPacketsLost, 4);
    await sampler.stop();
  });

  it('skips a tick while a previous sample is still in flight', async () => {
    const scheduler = makeScheduler();
    let calls = 0;
    let resolveStats: ((value: unknown) => void) | undefined;
    const sampler = new RtcStatsSampler({
      source: {
        getRtcStats: () => {
          calls += 1;
          return new Promise((resolve) => {
            resolveStats = resolve;
          });
        },
      },
      sessionId: 's1',
      intervalMs: 1000,
      log: captureLog().log,
      setIntervalFn: scheduler.setIntervalFn,
      clearIntervalFn: scheduler.clearIntervalFn,
    });
    sampler.start();
    scheduler.fire();
    scheduler.fire(); // still in flight -> skipped
    await flush();
    assert.equal(calls, 1);
    resolveStats?.(statsFixture());
    await flush();
    scheduler.fire();
    await flush();
    assert.equal(calls, 2);
    resolveStats?.(statsFixture());
    await sampler.stop();
  });

  it('handles sampling errors without throwing and rate-limits the log', async () => {
    const { log, lines } = captureLog();
    const sampler = new RtcStatsSampler({
      source: {
        getRtcStats: async () => {
          throw new Error('getRtcStats requires a connected room');
        },
      },
      sessionId: 's1',
      intervalMs: 1000,
      log,
      maxLoggedErrors: 3,
    });
    for (let i = 0; i < 5; i += 1) {
      assert.equal(await sampler.sampleOnce(), undefined);
    }
    assert.equal(lines.length, 3);
    assert.equal(lines[0]?.message, 'diag: rtc_stats_unavailable');
    assert.match(String(lines[0]?.fields.error), /connected room/);
    assert.equal(sampler.samples, 0);
  });

  it('recovers after a transient error', async () => {
    const { log, lines } = captureLog();
    let failing = true;
    const sampler = new RtcStatsSampler({
      source: {
        getRtcStats: async () => {
          if (failing) throw new Error('transient');
          return statsFixture();
        },
      },
      sessionId: 's1',
      intervalMs: 1000,
      log,
    });
    await sampler.sampleOnce();
    failing = false;
    assert.ok(await sampler.sampleOnce());
    assert.equal(sampler.samples, 1);
    assert.equal(lines.filter((l) => l.message === 'diag: rtc_stats_unavailable').length, 1);
  });

  it('stops cleanly and idempotently', async () => {
    const scheduler = makeScheduler();
    const sampler = new RtcStatsSampler({
      source: { getRtcStats: async () => statsFixture() },
      sessionId: 's1',
      intervalMs: 1000,
      log: captureLog().log,
      setIntervalFn: scheduler.setIntervalFn,
      clearIntervalFn: scheduler.clearIntervalFn,
    });
    sampler.start();
    await sampler.stop();
    assert.equal(sampler.isRunning, false);
    assert.equal(scheduler.clearedCount, 1);
    await sampler.stop();
    assert.equal(scheduler.clearedCount, 1);
    sampler.start(); // after stop -> no-op
    assert.equal(sampler.isRunning, false);
  });
});

describe('TurnTimeline', () => {
  it('assigns a turn id and records proxy latency and speaking duration', () => {
    const session = new FakeSession();
    const { log, lines } = captureLog();
    let clock = 1000;
    const timeline = new TurnTimeline({
      sessionId: 's1',
      eventNames: NAMES,
      now: () => clock,
      wallNow: () => 1700000000000,
      log,
    });
    timeline.attach(session);
    assert.equal(session.onCount, 6);

    session.emit(NAMES.userStateChanged, { newState: 'speaking', oldState: 'listening' });
    clock = 1100;
    session.emit(NAMES.userStateChanged, { newState: 'listening', oldState: 'speaking' });
    clock = 1300;
    session.emit(NAMES.agentStateChanged, { newState: 'speaking', oldState: 'thinking' });
    clock = 1800;
    session.emit(NAMES.agentStateChanged, { newState: 'listening', oldState: 'speaking' });

    assert.equal(timeline.currentTurn, 1);
    const started = lines.find((l) => l.message === 'diag: agent_speaking_started');
    assert.equal(started?.fields.turn, 1);
    assert.equal(started?.fields.endOfUserSpeechToAgentSpeakingMs, 200);
    assert.equal(started?.fields.latencyKind, 'proxy');
    const ended = lines.find((l) => l.message === 'diag: agent_speaking_ended');
    assert.equal(ended?.fields.agentSpeakingMs, 500);
  });

  it('never records transcript content', () => {
    const session = new FakeSession();
    const { log, lines } = captureLog();
    const timeline = new TurnTimeline({ sessionId: 's1', eventNames: NAMES, log });
    timeline.attach(session);

    session.emit(NAMES.conversationItemAdded, {
      item: { role: 'assistant', id: 'item_1', content: 'SECRET_TRANSCRIPT' },
    });
    session.emit(NAMES.speechCreated, {
      source: 'generate_reply',
      userInitiated: true,
      speechHandle: { id: 'speech_1' },
    });

    assert.doesNotMatch(JSON.stringify(lines), /SECRET_TRANSCRIPT/);
    const item = lines.find((l) => l.message === 'diag: conversation_item');
    assert.equal(item?.fields.role, 'assistant');
    assert.equal(item?.fields.itemId, 'item_1');
    const speech = lines.find((l) => l.message === 'diag: speech_created');
    assert.equal(speech?.fields.speechId, 'speech_1');
  });

  it('records errors via describeError and closes cleanly', () => {
    const session = new FakeSession();
    const { log, lines } = captureLog();
    const timeline = new TurnTimeline({ sessionId: 's1', eventNames: NAMES, log });
    timeline.attach(session);

    session.emit(NAMES.error, { error: new Error('room session transport is closed') });
    session.emit(NAMES.close, { reason: 'job_shutdown' });

    assert.match(
      String(lines.find((l) => l.message === 'diag: session_error')?.fields.error),
      /room session transport is closed/,
    );
    assert.equal(lines.find((l) => l.message === 'diag: session_closed')?.fields.reason, 'job_shutdown');
  });

  it('attaches only once', () => {
    const session = new FakeSession();
    const timeline = new TurnTimeline({ sessionId: 's1', eventNames: NAMES, log: captureLog().log });
    timeline.attach(session);
    timeline.attach(session);
    assert.equal(session.onCount, 6);
  });
});

describe('createSessionDiagnostics', () => {
  it('attaches nothing and stops cleanly when disabled', async () => {
    const session = new FakeSession();
    const diag = createSessionDiagnostics({
      sessionId: 's1',
      session,
      eventNames: NAMES,
      timeline: false,
    });
    assert.equal(diag.timeline, undefined);
    assert.equal(diag.sampler, undefined);
    assert.equal(session.onCount, 0);
    diag.startRtcSampling();
    await diag.stop();
  });

  it('wires the timeline and sampler when enabled', async () => {
    const session = new FakeSession();
    const diag = createSessionDiagnostics({
      sessionId: 's1',
      session,
      eventNames: NAMES,
      timeline: true,
      rtc: { source: { getRtcStats: async () => statsFixture() }, intervalMs: 2000 },
      log: captureLog().log,
    });
    assert.ok(diag.timeline);
    assert.ok(diag.sampler);
    assert.equal(session.onCount, 6);
    diag.startRtcSampling();
    assert.equal(diag.sampler?.isRunning, true);
    await diag.stop();
    assert.equal(diag.sampler?.isRunning, false);
  });
});

describe('diagnostics flags', () => {
  it('reads boolean flags with sane fallbacks', () => {
    for (const value of ['1', 'true', 'YES', 'on']) {
      assert.equal(readBoolEnv('DIAG_RTC_STATS', false, { DIAG_RTC_STATS: value }), true);
    }
    for (const value of ['0', 'false', 'no', 'OFF']) {
      assert.equal(readBoolEnv('DIAG_RTC_STATS', true, { DIAG_RTC_STATS: value }), false);
    }
    assert.equal(readBoolEnv('DIAG_RTC_STATS', false, {}), false);
    assert.equal(readBoolEnv('DIAG_RTC_STATS', true, { DIAG_RTC_STATS: 'maybe' }), true);
  });

  it('is disabled by default and clamps the sampling interval', () => {
    assert.deepEqual(resolveDiagnosticsOptions({}), {
      timeline: false,
      rtcStats: false,
      rtcIntervalMs: DEFAULT_RTC_INTERVAL_MS,
    });
    assert.equal(
      resolveDiagnosticsOptions({ DIAG_RTC_INTERVAL_MS: '10' }).rtcIntervalMs,
      MIN_RTC_INTERVAL_MS,
    );
    assert.equal(
      resolveDiagnosticsOptions({ DIAG_RTC_INTERVAL_MS: '999999' }).rtcIntervalMs,
      MAX_RTC_INTERVAL_MS,
    );
    const enabled = resolveDiagnosticsOptions({ DIAG_TURN_TIMELINE: '1', DIAG_RTC_STATS: '1' });
    assert.equal(enabled.timeline, true);
    assert.equal(enabled.rtcStats, true);
  });
});
