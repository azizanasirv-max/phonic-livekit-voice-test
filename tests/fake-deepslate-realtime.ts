/**
 * Test doubles for the Deepslate Opal ↔ LiveKit boundary.
 *
 * The interruption tests run against the **real** `AgentSession`,
 * `RealtimeModel`/`RealtimeSession` base classes and audio-output contract from
 * the installed `@livekit/agents`; only Deepslate itself is replaced. The fake
 * reproduces what `@deepslate-labs/livekit@0.1.23` does at that boundary (see
 * `src/realtime/model.ts` in the published package), and nothing more:
 *
 * - Capabilities are copied from the plugin's `super({...})` call:
 *   `messageTruncation: true`, `turnDetection: true`, `userTranscription: true`,
 *   `autoToolReplyGeneration: true`, `audioOutput: true` (a TTS config is
 *   configured), `manualFunctionCalls: false`, `perResponseToolChoice: false`.
 * - A response is one `GenerationCreatedEvent` with an audio stream and a text
 *   stream. The plugin opens one whenever the server begins a response
 *   (`responseBegin` / the first `audioChunk` / `textFragment`).
 * - `playbackBufferClear` (Deepslate's server-side VAD detected the caller
 *   speaking) emits `input_speech_started` and then closes the current
 *   generation — unless it is an `uninterruptable` direct-speech utterance,
 *   which the plugin deliberately leaves alone.
 * - `interrupt()` closes the current generation; `clearAudio()` is a no-op and
 *   `truncate()` is a no-op. Both only log in the plugin: Deepslate cancels and
 *   truncates server-side.
 * - Late `audioChunk`s are **not** filtered by the plugin. `ensureGeneration()`
 *   opens a new generation, so audio the server still had in flight can be
 *   scheduled again. Tests must not pretend otherwise.
 * - Provider errors are emitted with `recoverable: false`, which makes
 *   LiveKit tear the session down.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { llm, voice } from '@livekit/agents';
import { ReadableStream } from 'node:stream/web';

/** Deepslate session default input/output rate (24 kHz, mono). */
export const DEEPSLATE_SAMPLE_RATE = 24000;
/** 20 ms at 24 kHz. */
export const DEEPSLATE_FRAME_SAMPLES = 480;

/** A silent 20 ms frame, enough for the playback path to accept it. */
export function pcmFrame(samples: number = DEEPSLATE_FRAME_SAMPLES): AudioFrame {
  return new AudioFrame(new Int16Array(samples), DEEPSLATE_SAMPLE_RATE, 1, samples);
}

type TurnCloseReason = 'interrupted' | 'completed';

type FakeTurn = {
  responseId: string;
  audio?: ReadableStreamDefaultController<AudioFrame>;
  text?: ReadableStreamDefaultController<string>;
  audioClosed: boolean;
  textClosed: boolean;
  uninterruptable: boolean;
};

function closedStream<T>(): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      controller.close();
    },
  });
}

/** Close a stream controller, tolerating one the consumer already closed. */
function closeController<T>(controller: ReadableStreamDefaultController<T> | undefined): void {
  if (controller === undefined) return;
  try {
    controller.close();
  } catch {
    // Already closed or cancelled by the consumer — nothing to do.
  }
}

/** Stand-in for the plugin's `DeepslateRealtimeSession`. */
export class FakeDeepslateRealtimeSession extends llm.RealtimeSession {
  chatCtx: llm.ChatContext = llm.ChatContext.empty();
  tools: llm.ToolContext = llm.ToolContext.empty();

  /** Responses opened so far. */
  turnsOpened = 0;
  /** Responses closed because Deepslate reported user speech. */
  turnsInterrupted = 0;
  /** Responses that ran to `responseEnd`. */
  turnsCompleted = 0;
  /** Frames the fake handed to an open response. */
  framesDelivered = 0;
  /** Frames dropped because the consumer had cancelled the stream. */
  framesDropped = 0;
  /** LiveKit called the model's `clearAudio()` (a no-op in the plugin). */
  clearAudioCalls = 0;
  /** LiveKit called the model's `interrupt()` (closes the local generation). */
  interruptCalls = 0;
  /** LiveKit called the model's `truncate()` (a no-op in the plugin). */
  truncateCalls = 0;
  closed = false;

  #turn?: FakeTurn;
  #audioCancelledByConsumer = false;

  async updateInstructions(): Promise<void> {}

  async updateChatCtx(chatCtx: llm.ChatContext): Promise<void> {
    this.chatCtx = chatCtx;
  }

  async updateTools(tools: llm.ToolContext): Promise<void> {
    this.tools = tools;
  }

  updateOptions(): void {}

  pushAudio(): void {}

  /** Mirrors the plugin's `generateReply()`: close any open response, open one. */
  async generateReply(): Promise<llm.GenerationCreatedEvent> {
    if (this.closed) {
      throw new Error('session is closed');
    }
    // The real plugin resolves when the server's response begins; the fake
    // opens it immediately so tests are deterministic.
    this.#closeTurn('completed');
    return this.#openTurn({ userInitiated: true, uninterruptable: false });
  }

  /** Mirrors a server-initiated response (reply to caller audio). */
  assistantTurnFromServer(): llm.GenerationCreatedEvent {
    return this.#openTurn({ userInitiated: false, uninterruptable: false });
  }

  /**
   * Mirrors the plugin's `audioChunk` handler, which calls
   * `ensureGeneration()`: audio arriving with no open response opens a new one.
   */
  pushAssistantAudio(text = ''): boolean {
    if (this.#turn === undefined) {
      this.#openTurn({ userInitiated: false, uninterruptable: false });
    }
    const turn = this.#turn!;
    if (turn.audioClosed) {
      this.framesDropped += 1;
      return false;
    }
    try {
      turn.audio!.enqueue(pcmFrame());
      if (text !== '') turn.text!.enqueue(text);
    } catch {
      // The consumer cancelled the stream, so nothing can be delivered.
      turn.audioClosed = true;
      this.framesDropped += 1;
      return false;
    }
    this.framesDelivered += 1;
    return true;
  }

  /** Mirrors `responseEnd` → `closeCurrentGeneration()`. */
  finishAssistantTurn(): void {
    this.#closeTurn('completed');
  }

  /**
   * Mirrors `playbackBufferClear` → `handleInputSpeechStarted()`: notify
   * LiveKit first, then close the response. An uninterruptable direct-speech
   * utterance is left playing, exactly as the plugin does.
   */
  userStartedSpeaking(): void {
    if (this.#turn?.uninterruptable === true) return;
    this.emit('input_speech_started', {});
    this.#closeTurn('interrupted');
  }

  /** Mirrors the plugin's user-turn boundary after an interruption. */
  userFinishedSpeaking(): void {
    this.emit('input_speech_stopped', { userTranscriptionEnabled: true });
  }

  /** Mirrors the plugin's `speakDirect()` for an uninterruptable utterance. */
  async speakDirectUninterruptable(text: string): Promise<void> {
    this.#openTurn({ userInitiated: false, uninterruptable: true });
    this.pushAssistantAudio(text);
  }

  /** Mirrors a non-recoverable provider error (plugin emits `recoverable: false`). */
  simulateProviderError(message = 'Deepslate connection failed'): void {
    this.#closeTurn('completed');
    this.emit('error', {
      type: 'realtime_model_error',
      timestamp: Date.now(),
      label: 'deepslate.RealtimeModel',
      error: new Error(message),
      recoverable: false,
    } satisfies llm.RealtimeModelError);
  }

  /** True while a response is open (the model is still speaking). */
  get turnOpen(): boolean {
    return this.#turn !== undefined;
  }

  /** True when LiveKit cancelled the open response's audio stream. */
  get audioStreamCancelled(): boolean {
    return this.#audioCancelledByConsumer;
  }

  override async close(): Promise<void> {
    this.closed = true;
    this.#closeTurn('completed');
    await super.close();
  }

  /** Mirrors the plugin: server-side VAD auto-commits audio. */
  async commitAudio(): Promise<void> {}

  /** Mirrors the plugin: logs a warning and does nothing. */
  async clearAudio(): Promise<void> {
    this.clearAudioCalls += 1;
  }

  /** Mirrors the plugin's `interrupt()`: closes the local generation. */
  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
    this.#closeTurn('interrupted');
  }

  /** Mirrors the plugin: Deepslate truncates context server-side. */
  async truncate(): Promise<void> {
    this.truncateCalls += 1;
  }

  #closeTurn(reason: TurnCloseReason): void {
    const turn = this.#turn;
    if (turn === undefined) return;
    this.#turn = undefined;
    if (reason === 'interrupted') this.turnsInterrupted += 1;
    else this.turnsCompleted += 1;
    closeController(turn.audio);
    closeController(turn.text);
    turn.audioClosed = true;
    turn.textClosed = true;
  }

  #openTurn({
    userInitiated,
    uninterruptable,
  }: {
    userInitiated: boolean;
    uninterruptable: boolean;
  }): llm.GenerationCreatedEvent {
    this.#closeTurn('completed');
    this.turnsOpened += 1;
    const turn: FakeTurn = {
      responseId: `DS_fake_${this.turnsOpened}`,
      audioClosed: false,
      textClosed: false,
      uninterruptable,
    };
    this.#audioCancelledByConsumer = false;

    const audioStream = new ReadableStream<AudioFrame>({
      start: (controller) => {
        turn.audio = controller;
      },
      cancel: () => {
        this.#audioCancelledByConsumer = true;
      },
    });
    const textStream = new ReadableStream<string>({
      start: (controller) => {
        turn.text = controller;
      },
    });

    this.#turn = turn;

    const event: llm.GenerationCreatedEvent = {
      messageStream: new ReadableStream<llm.MessageGeneration>({
        start(controller) {
          controller.enqueue({
            messageId: turn.responseId,
            textStream,
            audioStream,
            modalities: Promise.resolve(['audio', 'text']),
          });
          controller.close();
        },
      }),
      functionStream: closedStream(),
      userInitiated,
      responseId: turn.responseId,
    };

    this.emit('generation_created', event);
    return event;
  }
}

/** Stand-in for the plugin's `RealtimeModel`. */
export class FakeDeepslateRealtimeModel extends llm.RealtimeModel {
  activeSession?: FakeDeepslateRealtimeSession;

  constructor() {
    super({
      // Copied from @deepslate-labs/livekit@0.1.23 `RealtimeModel`.
      messageTruncation: true,
      turnDetection: true,
      userTranscription: true,
      autoToolReplyGeneration: true,
      manualFunctionCalls: false,
      audioOutput: true,
      perResponseToolChoice: false,
    });
  }

  override get model(): string {
    return 'fake-deepslate';
  }

  override get provider(): string {
    return 'deepslate';
  }

  override session(): FakeDeepslateRealtimeSession {
    const session = new FakeDeepslateRealtimeSession(this);
    this.activeSession = session;
    return session;
  }

  override async close(): Promise<void> {}
}

/**
 * An `AudioOutput` that records what LiveKit hands to the playback path.
 *
 * It mirrors what the room output does at the boundary that matters here:
 * `captureFrame` counts a frame as scheduled for playback, and `clearBuffer`
 * reports the current segment as finished-and-interrupted. Nothing is actually
 * played, so the tests run without audio devices.
 */
export class RecordingAudioOutput extends voice.AudioOutput {
  /** Frames handed to the playback path. */
  framesCaptured = 0;
  /** Times LiveKit dropped queued audio (`clearBuffer()`). */
  clears = 0;
  /** Times LiveKit flushed the segment normally (`flush()`). */
  flushes = 0;

  constructor() {
    super(DEEPSLATE_SAMPLE_RATE, undefined, { pause: true });
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.framesCaptured += 1;
    this.onPlaybackStarted(Date.now());
  }

  override flush(): void {
    super.flush();
    this.flushes += 1;
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: false });
  }

  clearBuffer(): void {
    this.clears += 1;
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
  }

  override pause(): void {}

  override resume(): void {}
}
