/**
 * Test doubles for the Phonic ↔ LiveKit boundary.
 *
 * The interruption tests run against the **real** `AgentSession`,
 * `RealtimeModel`/`RealtimeSession` base classes and audio-output contract from
 * the installed `@livekit/agents`; only Phonic itself is replaced. The fake
 * reproduces exactly what the installed plugin
 * (`@livekit/agents-plugin-phonic@1.9.3`) does at that boundary and nothing
 * more, so the tests exercise LiveKit's real behaviour rather than invented
 * capabilities:
 *
 * - Declared capabilities are copied from the plugin's `super({...})` call
 *   (`src/realtime/realtime_model.ts`): `turnDetection: true`, `audioOutput:
 *   true`, `messageTruncation: false`, `supportsOverlappingSpeech` unset (so
 *   LiveKit treats the model as non-overlapping and interrupts it on
 *   `input_speech_started`).
 * - One assistant turn = one `GenerationCreatedEvent` carrying one message with
 *   an audio stream and a text stream (`startNewAssistantTurn`).
 * - `handleInputSpeechStarted`: Phonic's `user_started_speaking` emits
 *   `input_speech_started` **and then** closes the open turn
 *   (`closeCurrentGeneration({ interrupted: true })`). The emit happens first —
 *   that ordering is what lets LiveKit interrupt the in-flight response.
 * - `handleAudioChunk`: audio for a turn that is already closed is dropped, and
 *   audio arriving with no open turn does nothing unless it carries text (which
 *   starts a new turn).
 * - `interrupt()`, `clearAudio()` and `truncate()` are no-ops that only warn:
 *   the plugin does not cancel or truncate server-side audio, so tests must not
 *   pretend they do.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { llm, voice } from '@livekit/agents';
import { ReadableStream } from 'node:stream/web';

/** Phonic's output format is `pcm_24000`, mono (see the plugin's constants). */
export const PHONIC_SAMPLE_RATE = 24000;
/** 20 ms at 24 kHz — the chunk size Phonic streams. */
export const PHONIC_FRAME_SAMPLES = 480;

/** A silent 20 ms frame, enough for the playback path to accept it. */
export function pcmFrame(samples: number = PHONIC_FRAME_SAMPLES): AudioFrame {
  return new AudioFrame(new Int16Array(samples), PHONIC_SAMPLE_RATE, 1, samples);
}

type TurnCloseReason = 'interrupted' | 'completed';

type FakeTurn = {
  responseId: string;
  audio?: ReadableStreamDefaultController<AudioFrame>;
  text?: ReadableStreamDefaultController<string>;
  audioClosed: boolean;
  textClosed: boolean;
};

function closedStream<T>(): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      controller.close();
    },
  });
}

/** Close a stream controller, tolerating one that the consumer already closed. */
function closeController<T>(controller: ReadableStreamDefaultController<T> | undefined): void {
  if (controller === undefined) return;
  try {
    controller.close();
  } catch {
    // Already closed or cancelled by the consumer — nothing to do.
  }
}

/** Stand-in for the plugin's `RealtimeSession`. */
export class FakePhonicRealtimeSession extends llm.RealtimeSession {
  chatCtx: llm.ChatContext = llm.ChatContext.empty();
  tools: llm.ToolContext = llm.ToolContext.empty();

  /** Assistant turns opened so far. */
  turnsOpened = 0;
  /** Turns closed because Phonic reported user speech (an interruption). */
  turnsInterrupted = 0;
  /** Turns that ran to `assistant_finished_speaking`. */
  turnsCompleted = 0;
  /** Frames the fake handed to a turn that was still open. */
  framesDelivered = 0;
  /** Frames dropped because the turn they belonged to was already closed. */
  framesDropped = 0;
  /** LiveKit called the model's `clearAudio()` (a no-op in the plugin). */
  clearAudioCalls = 0;
  /** LiveKit called the model's `interrupt()` (a no-op in the plugin). */
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

  /** Mirrors the plugin's `generateReply()`: close any open turn, open a new one. */
  async generateReply(): Promise<llm.GenerationCreatedEvent> {
    if (this.closed) {
      throw new Error('session is closed');
    }
    this.#closeTurn('interrupted');
    return this.#openTurn({ userInitiated: true });
  }

  /** Mirrors `handleAudioChunk` opening a turn for a Phonic-initiated reply. */
  assistantTurnFromPhonic(): llm.GenerationCreatedEvent {
    return this.#openTurn({ userInitiated: false });
  }

  /**
   * Mirrors `handleAudioChunk`: deliver one frame (and optional text) to the
   * open turn. Returns false when there is no open turn or it is already
   * closed, which is what the plugin does for late chunks.
   */
  pushAssistantAudio(text = ''): boolean {
    const turn = this.#turn;
    if (turn === undefined || turn.audioClosed) {
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

  /** Mirrors `assistant_finished_speaking` → `finishAssistantTurn()`. */
  finishAssistantTurn(): void {
    this.#closeTurn('completed');
  }

  /**
   * Mirrors Phonic's `user_started_speaking` → `handleInputSpeechStarted()`:
   * notify LiveKit first, then close the turn.
   */
  userStartedSpeaking(): void {
    this.emit('input_speech_started', {});
    this.#closeTurn('interrupted');
  }

  /** Mirrors `user_finished_speaking` → `handleInputSpeechStopped()`. */
  userFinishedSpeaking(): void {
    this.emit('input_speech_stopped', { userTranscriptionEnabled: true });
  }

  /**
   * Reports user speech *without* closing the generation — the worst case a
   * provider can present: frames already buffered in the generation's audio
   * stream stay readable, so LiveKit itself has to stop scheduling them.
   */
  userStartedSpeakingKeepingTurnOpen(): void {
    this.emit('input_speech_started', {});
  }

  /**
   * Mirrors the plugin's socket `close` handler: drop the open generation and
   * report an abnormal close as an error (1000 is a normal close).
   */
  simulateSocketClose(code = 1006): void {
    this.#closeTurn('completed');
    if (!this.closed && code !== 1000) {
      this.emit('error', {
        type: 'realtime_model_error',
        timestamp: Date.now(),
        label: 'phonic_realtime',
        error: new Error(`Phonic STS socket closed with code ${code}`),
        recoverable: false,
      } satisfies llm.RealtimeModelError);
    }
  }

  /** True while an assistant turn is open (Phonic is still speaking). */
  get turnOpen(): boolean {
    return this.#turn !== undefined;
  }

  /** True when LiveKit cancelled the open turn's audio stream. */
  get audioStreamCancelled(): boolean {
    return this.#audioCancelledByConsumer;
  }

  override async close(): Promise<void> {
    this.closed = true;
    this.#closeTurn('completed');
    await super.close();
  }

  /** No-op, exactly like the plugin (which only logs a warning). */
  async commitAudio(): Promise<void> {}

  /** No-op, exactly like the plugin. */
  async clearAudio(): Promise<void> {
    this.clearAudioCalls += 1;
  }

  /** No-op, exactly like the plugin. */
  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  /** No-op, exactly like the plugin. */
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

  #openTurn({ userInitiated }: { userInitiated: boolean }): llm.GenerationCreatedEvent {
    this.turnsOpened += 1;
    const turn: FakeTurn = {
      responseId: `PS_fake_${this.turnsOpened}`,
      audioClosed: false,
      textClosed: false,
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

    // The plugin emits `generation_created` for every turn; LiveKit ignores the
    // ones it already knows about because it created the speech handle itself.
    this.emit('generation_created', event);
    return event;
  }
}

/** Stand-in for the plugin's `RealtimeModel`. */
export class FakePhonicRealtimeModel extends llm.RealtimeModel {
  activeSession?: FakePhonicRealtimeSession;

  constructor() {
    super({
      // Copied from @livekit/agents-plugin-phonic@1.9.3 `RealtimeModel`:
      messageTruncation: false,
      turnDetection: true,
      userTranscription: true,
      autoToolReplyGeneration: true,
      manualFunctionCalls: false,
      audioOutput: true,
      midSessionChatCtxUpdate: true,
      midSessionInstructionsUpdate: true,
      midSessionToolsUpdate: true,
      perResponseToolChoice: false,
    });
  }

  override get model(): string {
    return 'fake-phonic';
  }

  override session(): FakePhonicRealtimeSession {
    const session = new FakePhonicRealtimeSession(this);
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
    super(PHONIC_SAMPLE_RATE, undefined, { pause: true });
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
