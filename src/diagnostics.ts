/**
 * Stage 0 diagnostic instrumentation (read-only).
 *
 * Everything here is additive and opt-in via `DIAG_*` environment flags (see
 * `resolveDiagnosticsOptions`). It records timing metadata and WebRTC statistics
 * only — never credentials, raw audio, or transcript content — and never changes
 * turn detection, interruption handling, audio buffering, model configuration,
 * authentication, or session isolation.
 *
 * This module deliberately imports nothing from `@livekit/*` at runtime so it
 * can be unit-tested without the native media bindings. The session is treated
 * structurally, and the caller passes the SDK's own event-name constants so the
 * strings cannot silently drift from the installed SDK.
 */
import { randomUUID } from 'node:crypto';
import { describeError, logInfo } from './logging.ts';

/** A sink for diagnostic log lines; injectable so tests can capture raw fields. */
export type DiagLogSink = (message: string, fields: Record<string, unknown>) => void;

/** Default sink: the redacting logger from `logging.ts`. */
export const defaultDiagLog: DiagLogSink = (message, fields) => logInfo(message, fields);

/** A timestamped RTC statistics sample. */
export type RtcSample = {
  /** Monotonic milliseconds (`performance.now()`), for elapsed-time math. */
  t: number;
  /** Wall-clock milliseconds since epoch, for correlation with server logs. */
  wallMs: number;
  /** Session correlation id (not a credential). */
  sessionId: string;
  snapshot: RtcSnapshot;
  summary: RtcSummary;
};

/* ------------------------------------------------------------------------- *
 * WebRTC statistics
 *
 * `room.getRtcStats()` (verified on @livekit/rtc-node@1.1.0, `dist/room.d.ts`)
 * resolves a protobuf `GetSessionStatsCallback_Result` with
 * `publisherStats`/`subscriberStats` arrays of `RtcStats` messages. Each
 * `RtcStats` is a `oneof`: `stats.case` names the kind and `stats.value` holds
 * the nested message. The nesting below mirrors
 * `@livekit/rtc-ffi-bindings@0.12.73` `proto/stats_pb.d.ts`.
 * ------------------------------------------------------------------------- */

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRecord = Record<string, any>;

/** Audio/RTP stream statistics, normalized from the nested proto messages. */
export type RtcStreamSnapshot = {
  id?: string;
  ssrc?: number;
  kind?: string;
  packetsReceived?: number;
  packetsSent?: number;
  packetsLost?: number;
  /** Raw RTP jitter as reported by libwebrtc (seconds). */
  jitter?: number;
  jitterBufferDelay?: number;
  jitterBufferTargetDelay?: number;
  jitterBufferMinimumDelay?: number;
  jitterBufferEmittedCount?: number;
  nackCount?: number;
  retransmittedPacketsReceived?: number;
  retransmittedPacketsSent?: number;
  framesReceived?: number;
  framesDecoded?: number;
  framesDropped?: number;
  concealedSamples?: number;
  concealmentEvents?: number;
  /** Round-trip time in seconds (from `remoteInboundRtp`). */
  roundTripTime?: number;
  fractionLost?: number;
  targetBitrate?: number;
};

/** Transport / ICE / candidate-pair / peer-connection statistics. */
export type RtcConnectionSnapshot = {
  id?: string;
  /** Which proto message produced this entry. */
  type: 'transport' | 'candidatePair' | 'peerConnection';
  iceState?: string;
  dtlsState?: string;
  candidatePairState?: string;
  nominated?: boolean;
  /** Seconds. */
  currentRoundTripTime?: number;
  packetsSent?: number;
  packetsReceived?: number;
  bytesSent?: number;
  bytesReceived?: number;
  selectedCandidatePairChanges?: number;
  availableIncomingBitrate?: number;
  availableOutgoingBitrate?: number;
  dataChannelsOpened?: number;
  dataChannelsClosed?: number;
};

/** Audio playout statistics (underrun / concealment indicators). */
export type RtcPlayoutSnapshot = {
  id?: string;
  kind?: string;
  synthesizedSamplesDuration?: number;
  synthesizedSamplesEvents?: number;
  totalSamplesDuration?: number;
  totalPlayoutDelay?: number;
  totalSamplesCount?: number;
};

/** A compact, privacy-safe view of one `getRtcStats()` result. */
export type RtcSnapshot = {
  publisher: RtcStreamSnapshot[];
  subscriber: RtcStreamSnapshot[];
  connections: RtcConnectionSnapshot[];
  playout: RtcPlayoutSnapshot[];
  /** Entries whose `oneof` case is not handled above. */
  unknownEntries: number;
};

/** Aggregated audio-quality figures for one sample (agent peer connection). */
export type RtcSummary = {
  audioInPacketsReceived?: number;
  audioInPacketsLost?: number;
  audioInJitterMs?: number;
  audioInJitterBufferAvgMs?: number;
  audioInNackCount?: number;
  audioInRetransmittedPacketsReceived?: number;
  audioInConcealedSamples?: number;
  audioInConcealmentEvents?: number;
  audioInFramesDropped?: number;
  audioOutPacketsSent?: number;
  audioOutNackCount?: number;
  audioOutRetransmittedPacketsSent?: number;
  rttMs?: number;
  iceState?: string;
  dtlsState?: string;
  candidatePairState?: string;
};

const ICE_STATE_NAMES: Record<number, string> = {
  0: 'new',
  1: 'checking',
  2: 'connected',
  3: 'completed',
  4: 'disconnected',
  5: 'failed',
  6: 'closed',
};
const DTLS_STATE_NAMES: Record<number, string> = {
  0: 'new',
  1: 'connecting',
  2: 'connected',
  3: 'closed',
  4: 'failed',
};
const PAIR_STATE_NAMES: Record<number, string> = {
  0: 'frozen',
  1: 'waiting',
  2: 'in-progress',
  3: 'failed',
  4: 'succeeded',
};

/** Coerce a proto numeric field (number or bigint) to a JS number. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

function asRecord(value: unknown): AnyRecord {
  return value !== null && typeof value === 'object' ? (value as AnyRecord) : {};
}

function enumName(names: Record<number, string>, value: unknown): string | undefined {
  const n = num(value);
  if (n === undefined) return undefined;
  return names[n] ?? String(n);
}

/** Drop keys whose value is `undefined`, so logs and assertions stay compact. */
function prune<T extends object>(input: T): T {
  const out: AnyRecord = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/** Extract a stream snapshot from an `inboundRtp` / `outboundRtp` / `remoteInboundRtp` value. */
function extractStream(value: AnyRecord): RtcStreamSnapshot {
  const rtc = asRecord(value.rtc);
  const stream = asRecord(value.stream);
  const received = asRecord(value.received);
  const inbound = asRecord(value.inbound);
  const sent = asRecord(value.sent);
  const outbound = asRecord(value.outbound);
  const remoteInbound = asRecord(value.remoteInbound);
  return prune<RtcStreamSnapshot>({
    id: typeof rtc.id === 'string' ? rtc.id : undefined,
    ssrc: num(stream.ssrc),
    kind: typeof stream.kind === 'string' ? stream.kind : undefined,
    packetsReceived: num(received.packetsReceived),
    packetsLost: num(received.packetsLost),
    jitter: num(received.jitter),
    packetsSent: num(sent.packetsSent),
    nackCount: num(inbound.nackCount) ?? num(outbound.nackCount),
    jitterBufferDelay: num(inbound.jitterBufferDelay),
    jitterBufferTargetDelay: num(inbound.jitterBufferTargetDelay),
    jitterBufferMinimumDelay: num(inbound.jitterBufferMinimumDelay),
    jitterBufferEmittedCount: num(inbound.jitterBufferEmittedCount),
    retransmittedPacketsReceived: num(inbound.retransmittedPacketsReceived),
    retransmittedPacketsSent: num(outbound.retransmittedPacketsSent),
    framesReceived: num(inbound.framesReceived),
    framesDecoded: num(inbound.framesDecoded),
    framesDropped: num(inbound.framesDropped),
    concealedSamples: num(inbound.concealedSamples),
    concealmentEvents: num(inbound.concealmentEvents),
    roundTripTime: num(remoteInbound.roundTripTime),
    fractionLost: num(remoteInbound.fractionLost),
    targetBitrate: num(outbound.targetBitrate),
  });
}

function extractConnection(
  type: RtcConnectionSnapshot['type'],
  value: AnyRecord,
): RtcConnectionSnapshot {
  const rtc = asRecord(value.rtc);
  const transport = asRecord(value.transport);
  const pair = asRecord(value.candidatePair);
  const pc = asRecord(value.pc);
  return prune<RtcConnectionSnapshot>({
    id: typeof rtc.id === 'string' ? rtc.id : undefined,
    type,
    iceState: enumName(ICE_STATE_NAMES, transport.iceState),
    dtlsState: enumName(DTLS_STATE_NAMES, transport.dtlsState),
    candidatePairState: enumName(PAIR_STATE_NAMES, pair.state),
    nominated: typeof pair.nominated === 'boolean' ? pair.nominated : undefined,
    currentRoundTripTime: num(pair.currentRoundTripTime),
    packetsSent: num(transport.packetsSent) ?? num(pair.packetsSent),
    packetsReceived: num(transport.packetsReceived) ?? num(pair.packetsReceived),
    bytesSent: num(transport.bytesSent),
    bytesReceived: num(transport.bytesReceived),
    selectedCandidatePairChanges: num(transport.selectedCandidatePairChanges),
    availableIncomingBitrate: num(pair.availableIncomingBitrate),
    availableOutgoingBitrate: num(pair.availableOutgoingBitrate),
    dataChannelsOpened: num(pc.dataChannelsOpened),
    dataChannelsClosed: num(pc.dataChannelsClosed),
  });
}

function extractPlayout(value: AnyRecord): RtcPlayoutSnapshot {
  const rtc = asRecord(value.rtc);
  const playout = asRecord(value.audioPlayout);
  return prune<RtcPlayoutSnapshot>({
    id: typeof rtc.id === 'string' ? rtc.id : undefined,
    kind: typeof playout.kind === 'string' ? playout.kind : undefined,
    synthesizedSamplesDuration: num(playout.synthesizedSamplesDuration),
    synthesizedSamplesEvents: num(playout.synthesizedSamplesEvents),
    totalSamplesDuration: num(playout.totalSamplesDuration),
    totalPlayoutDelay: num(playout.totalPlayoutDelay),
    totalSamplesCount: num(playout.totalSamplesCount),
  });
}

function entries(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? (value as AnyRecord[]) : [];
}

/**
 * Turn a raw `getRtcStats()` result into a compact snapshot. Defensive by
 * design: unknown/absent fields are dropped rather than throwing, so a partial
 * or version-skewed result still yields whatever is available.
 */
export function extractRtcSnapshot(result: unknown): RtcSnapshot {
  const root = asRecord(result);
  const snapshot: RtcSnapshot = {
    publisher: [],
    subscriber: [],
    connections: [],
    playout: [],
    unknownEntries: 0,
  };
  const collect = (list: unknown, target: RtcStreamSnapshot[]): void => {
    for (const entry of entries(list)) {
      const oneof = asRecord(entry.stats);
      const value = asRecord(oneof.value);
      switch (oneof.case) {
        case 'inboundRtp':
        case 'outboundRtp':
        case 'remoteInboundRtp':
          target.push(extractStream(value));
          break;
        case 'transport':
          snapshot.connections.push(extractConnection('transport', value));
          break;
        case 'candidatePair':
          snapshot.connections.push(extractConnection('candidatePair', value));
          break;
        case 'peerConnection':
          snapshot.connections.push(extractConnection('peerConnection', value));
          break;
        case 'mediaPlayout':
          snapshot.playout.push(extractPlayout(value));
          break;
        default:
          snapshot.unknownEntries += 1;
      }
    }
  };
  collect(root.publisherStats, snapshot.publisher);
  collect(root.subscriberStats, snapshot.subscriber);
  return snapshot;
}

/** Round to 2 decimals for readable logs. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** This is a voice agent, so any stream is expected to be audio. */
function isAudioStream(stream: RtcStreamSnapshot): boolean {
  return stream.kind === undefined || stream.kind === 'audio';
}

function sumField(streams: RtcStreamSnapshot[], key: keyof RtcStreamSnapshot): number {
  let total = 0;
  for (const stream of streams) {
    const value = stream[key];
    if (typeof value === 'number') total += value;
  }
  return total;
}

function maxField(streams: RtcStreamSnapshot[], key: keyof RtcStreamSnapshot): number | undefined {
  let best: number | undefined;
  for (const stream of streams) {
    const value = stream[key];
    if (typeof value === 'number' && (best === undefined || value > best)) best = value;
  }
  return best;
}

/**
 * Aggregate a snapshot into audio-quality figures. libwebrtc reports `jitter`,
 * `jitterBufferDelay`, and `roundTripTime` in **seconds**; those are converted
 * to milliseconds here. The raw seconds values remain in the snapshot.
 */
export function summarizeRtcSnapshot(snapshot: RtcSnapshot): RtcSummary {
  const streams = [...snapshot.publisher, ...snapshot.subscriber].filter(isAudioStream);
  const inbound = streams.filter(
    (s) => s.packetsReceived !== undefined || s.jitter !== undefined,
  );
  const outbound = streams.filter((s) => s.packetsSent !== undefined);
  const jitterBufferDelay = sumField(inbound, 'jitterBufferDelay');
  const jitterBufferEmitted = sumField(inbound, 'jitterBufferEmittedCount');
  const transport = snapshot.connections.find((c) => c.type === 'transport');
  const pair = snapshot.connections.find((c) => c.type === 'candidatePair');
  const jitterSec = maxField(inbound, 'jitter');
  const rttSec = maxField(streams, 'roundTripTime') ?? pair?.currentRoundTripTime;
  return prune<RtcSummary>({
    audioInPacketsReceived: inbound.length > 0 ? sumField(inbound, 'packetsReceived') : undefined,
    audioInPacketsLost: inbound.length > 0 ? sumField(inbound, 'packetsLost') : undefined,
    audioInJitterMs: jitterSec === undefined ? undefined : round(jitterSec * 1000),
    audioInJitterBufferAvgMs:
      jitterBufferEmitted > 0 ? round((jitterBufferDelay / jitterBufferEmitted) * 1000) : undefined,
    audioInNackCount: sumField(inbound, 'nackCount') || undefined,
    audioInRetransmittedPacketsReceived:
      sumField(inbound, 'retransmittedPacketsReceived') || undefined,
    audioInConcealedSamples: sumField(inbound, 'concealedSamples') || undefined,
    audioInConcealmentEvents: sumField(inbound, 'concealmentEvents') || undefined,
    audioInFramesDropped: sumField(inbound, 'framesDropped') || undefined,
    audioOutPacketsSent: sumField(outbound, 'packetsSent') || undefined,
    audioOutNackCount: sumField(outbound, 'nackCount') || undefined,
    audioOutRetransmittedPacketsSent: sumField(outbound, 'retransmittedPacketsSent') || undefined,
    rttMs: rttSec === undefined ? undefined : round(rttSec * 1000),
    iceState: transport?.iceState,
    dtlsState: transport?.dtlsState,
    candidatePairState: pair?.candidatePairState,
  });
}

/* ------------------------------------------------------------------------- *
 * Per-turn event timeline
 * ------------------------------------------------------------------------- */

/** Event-name strings, supplied by the caller from the SDK's own enum. */
export type SessionEventNames = {
  userStateChanged: string;
  agentStateChanged: string;
  speechCreated: string;
  conversationItemAdded: string;
  error: string;
  close: string;
};

/** Minimal structural view of the `AgentSession` emitter used here. */
export type SessionLike = {
  on(...args: any[]): unknown;
};

export type TimelineOptions = {
  sessionId: string;
  eventNames: SessionEventNames;
  now?: () => number;
  wallNow?: () => number;
  log?: DiagLogSink;
};

/**
 * Records a monotonic, per-turn event timeline. Emits metadata only: state
 * names, speech ids, conversation-item role/id, and error descriptions.
 * Transcript content is never read or logged.
 *
 * Timestamps: `t` is monotonic (`performance.now()`), `wallMs` is wall-clock for
 * correlating with server logs. Elapsed times are computed from `t` only.
 */
export class TurnTimeline {
  private readonly sessionId: string;
  private readonly eventNames: SessionEventNames;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly log: DiagLogSink;
  private turnId = 0;
  private lastUserSpeechStoppedAt: number | undefined;
  private agentSpeakingStartedAt: number | undefined;
  private attached = false;

  constructor(options: TimelineOptions) {
    this.sessionId = options.sessionId;
    this.eventNames = options.eventNames;
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.log = options.log ?? defaultDiagLog;
  }

  /** Current turn counter (0 = the greeting, before the user has spoken). */
  get currentTurn(): number {
    return this.turnId;
  }

  attach(session: SessionLike): void {
    if (this.attached) return;
    this.attached = true;
    session.on(this.eventNames.userStateChanged, (event: any) => this.onUserState(event));
    session.on(this.eventNames.agentStateChanged, (event: any) => this.onAgentState(event));
    session.on(this.eventNames.speechCreated, (event: any) => this.onSpeechCreated(event));
    session.on(this.eventNames.conversationItemAdded, (event: any) =>
      this.onConversationItem(event),
    );
    session.on(this.eventNames.error, (event: any) => this.onError(event));
    session.on(this.eventNames.close, (event: any) => this.onClose(event));
  }

  private emit(event: string, fields: Record<string, unknown>): void {
    this.log(`diag: ${event}`, {
      sessionId: this.sessionId,
      turn: this.turnId,
      t: round(this.now()),
      wallMs: this.wallNow(),
      ...fields,
    });
  }

  private onUserState(event: { newState?: string; oldState?: string }): void {
    const newState = event?.newState;
    if (newState === 'speaking') {
      this.turnId += 1;
      this.lastUserSpeechStoppedAt = undefined;
      this.emit('user_speech_started', { newState, oldState: event?.oldState });
      return;
    }
    if (newState === 'listening') {
      this.lastUserSpeechStoppedAt = this.now();
      this.emit('user_speech_stopped', { newState, oldState: event?.oldState });
      return;
    }
    this.emit('user_state', { newState, oldState: event?.oldState });
  }

  private onAgentState(event: { newState?: string; oldState?: string }): void {
    const newState = event?.newState;
    const oldState = event?.oldState;
    if (newState === 'speaking') {
      this.agentSpeakingStartedAt = this.now();
      const proxy =
        this.lastUserSpeechStoppedAt === undefined
          ? undefined
          : round(this.now() - this.lastUserSpeechStoppedAt);
      this.emit('agent_speaking_started', {
        oldState,
        // PROXY ONLY: agent state "speaking" means the agent began emitting
        // audio; it does NOT prove a frame was played on the phone.
        endOfUserSpeechToAgentSpeakingMs: proxy,
        latencyKind: 'proxy',
      });
      return;
    }
    if (oldState === 'speaking' && newState !== 'speaking') {
      const spokeMs =
        this.agentSpeakingStartedAt === undefined
          ? undefined
          : round(this.now() - this.agentSpeakingStartedAt);
      this.agentSpeakingStartedAt = undefined;
      this.emit('agent_speaking_ended', { newState, agentSpeakingMs: spokeMs });
      return;
    }
    this.emit('agent_state', { newState, oldState });
  }

  private onSpeechCreated(event: {
    source?: string;
    userInitiated?: boolean;
    speechHandle?: { id?: string };
  }): void {
    this.emit('speech_created', {
      source: event?.source,
      userInitiated: event?.userInitiated,
      speechId: event?.speechHandle?.id,
    });
  }

  private onConversationItem(event: {
    item?: { role?: string; id?: string; interrupted?: boolean };
  }): void {
    // Metadata only. `content` is deliberately never read.
    const item = event?.item ?? {};
    this.emit('conversation_item', {
      role: item.role,
      itemId: item.id,
      interrupted: item.interrupted,
    });
  }

  private onError(event: { error?: unknown }): void {
    this.emit('session_error', { error: describeError(event?.error) });
  }

  private onClose(event: { reason?: string }): void {
    this.emit('session_closed', { reason: event?.reason });
  }
}

/* ------------------------------------------------------------------------- *
 * RTC statistics sampler
 * ------------------------------------------------------------------------- */

/** Anything exposing the verified `getRtcStats()` method (e.g. `ctx.room`). */
export type RtcStatsSource = {
  getRtcStats(): Promise<unknown>;
};

export type RtcStatsSamplerOptions = {
  source: RtcStatsSource;
  sessionId: string;
  intervalMs: number;
  now?: () => number;
  wallNow?: () => number;
  log?: DiagLogSink;
  /** How many consecutive failures to log before going quiet (default 5). */
  maxLoggedErrors?: number;
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** Called with every successful sample; defaults to one compact log line. */
  onSample?: (sample: RtcSample) => void;
};

/**
 * Periodically samples `getRtcStats()` at a conservative interval. Never throws,
 * skips a tick when a previous sample is still running, and stops cleanly. The
 * interval handle is `unref()`ed so it cannot keep the process alive.
 */
export class RtcStatsSampler {
  private readonly source: RtcStatsSource;
  private readonly sessionId: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly log: DiagLogSink;
  private readonly maxLoggedErrors: number;
  private readonly setIntervalFn: (callback: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly onSample: (sample: RtcSample) => void;
  private handle: unknown;
  private inFlight: Promise<void> | undefined;
  private stopped = false;
  private consecutiveErrors = 0;
  private sampleCount = 0;

  constructor(options: RtcStatsSamplerOptions) {
    this.source = options.source;
    this.sessionId = options.sessionId;
    this.intervalMs = options.intervalMs;
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.log = options.log ?? defaultDiagLog;
    this.maxLoggedErrors = options.maxLoggedErrors ?? 5;
    this.setIntervalFn =
      options.setIntervalFn ??
      ((callback, ms) => setInterval(callback, ms) as unknown as NodeJS.Timeout);
    this.clearIntervalFn =
      options.clearIntervalFn ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
    this.onSample =
      options.onSample ??
      ((sample) =>
        this.log('diag: rtc_stats', {
          sessionId: sample.sessionId,
          t: round(sample.t),
          wallMs: sample.wallMs,
          ...sample.summary,
        }));
  }

  get isRunning(): boolean {
    return this.handle !== undefined && !this.stopped;
  }

  get samples(): number {
    return this.sampleCount;
  }

  start(): void {
    if (this.stopped || this.handle !== undefined) return;
    this.handle = this.setIntervalFn(() => {
      void this.tick();
    }, this.intervalMs);
    const handle = this.handle as { unref?: () => void } | undefined;
    if (handle !== undefined && typeof handle.unref === 'function') handle.unref();
  }

  /** Take one sample. Never rejects; returns `undefined` when unavailable. */
  async sampleOnce(): Promise<RtcSample | undefined> {
    try {
      const raw = await this.source.getRtcStats();
      const snapshot = extractRtcSnapshot(raw);
      const sample: RtcSample = {
        t: this.now(),
        wallMs: this.wallNow(),
        sessionId: this.sessionId,
        snapshot,
        summary: summarizeRtcSnapshot(snapshot),
      };
      this.consecutiveErrors = 0;
      this.sampleCount += 1;
      this.onSample(sample);
      return sample;
    } catch (error) {
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors <= this.maxLoggedErrors) {
        this.log('diag: rtc_stats_unavailable', {
          sessionId: this.sessionId,
          consecutiveErrors: this.consecutiveErrors,
          error: describeError(error),
        });
      }
      return undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight !== undefined) return; // previous sample still running
    const run = this.sampleOnce().then(() => undefined);
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  /** Stop sampling and await any in-flight sample. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.handle !== undefined) {
      this.clearIntervalFn(this.handle);
      this.handle = undefined;
    }
    if (this.inFlight !== undefined) {
      // `sampleOnce` never rejects, so this cannot throw.
      await this.inFlight;
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Session wiring
 * ------------------------------------------------------------------------- */

/** Short, non-secret id used to correlate log lines within one session. */
export function newSessionId(): string {
  return randomUUID().slice(0, 8);
}

export type SessionDiagnosticsOptions = {
  sessionId: string;
  session: SessionLike;
  eventNames: SessionEventNames;
  /** Attach the per-turn timeline only when true. */
  timeline: boolean;
  /** Enable RTC sampling only when provided. */
  rtc?: { source: RtcStatsSource; intervalMs: number };
  now?: () => number;
  wallNow?: () => number;
  log?: DiagLogSink;
};

export type SessionDiagnostics = {
  sessionId: string;
  timeline: TurnTimeline | undefined;
  sampler: RtcStatsSampler | undefined;
  /** Begin RTC sampling (call once the room is connected). */
  startRtcSampling(): void;
  /** Stop all sampling. Safe to call multiple times. */
  stop(): Promise<void>;
};

/**
 * Wire the Stage 0 diagnostics for one session. When `timeline` is false and
 * `rtc` is absent, nothing is attached and `stop()` is a no-op — the agent
 * behaves exactly as before.
 */
export function createSessionDiagnostics(options: SessionDiagnosticsOptions): SessionDiagnostics {
  const log = options.log ?? defaultDiagLog;
  let timeline: TurnTimeline | undefined;
  if (options.timeline) {
    timeline = new TurnTimeline({
      sessionId: options.sessionId,
      eventNames: options.eventNames,
      now: options.now,
      wallNow: options.wallNow,
      log,
    });
    timeline.attach(options.session);
  }
  let sampler: RtcStatsSampler | undefined;
  if (options.rtc !== undefined) {
    sampler = new RtcStatsSampler({
      source: options.rtc.source,
      sessionId: options.sessionId,
      intervalMs: options.rtc.intervalMs,
      now: options.now,
      wallNow: options.wallNow,
      log,
    });
  }
  return {
    sessionId: options.sessionId,
    timeline,
    sampler,
    startRtcSampling() {
      sampler?.start();
    },
    async stop() {
      await sampler?.stop();
    },
  };
}
