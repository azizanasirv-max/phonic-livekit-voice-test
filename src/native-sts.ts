/**
 * Native Deepslate Opal speech-to-speech (STS) capability observation.
 *
 * This module does **not** synthesize audio and does not pretend that the
 * current Deepslate Realtime API emits native Opal audio. It records what the
 * real server actually sends during a session that deliberately configures no
 * `tts_configuration`:
 *
 *   - `textFragment`  -> the server produced text;
 *   - `audioChunk`    -> the server produced model audio (the native-STS signal
 *                        we are looking for);
 *   - `responseEnd`   -> the turn finished.
 *
 * `scripts/probe-native-sts.ts` wires these callbacks to a real
 * `DeepslateSession`. The probe is the evidence needed before any production
 * adapter can claim native STS: if a completed response has text but zero audio
 * chunks while no TTS backend is configured, the server is text-only for that
 * session.
 *
 * The module is provider-independent and deliberately has no LiveKit or
 * Deepslate imports, so its behaviour can be unit-tested without a network or
 * credentials. The live probe itself cannot be validated without a Deepslate
 * account; see README "Native Opal STS status".
 */

/** Raised when a completed response produced no model audio. */
export class NativeStsUnavailableError extends Error {
  readonly textFragments: number;

  constructor(textFragments: number) {
    super(
      'Deepslate returned a completed text response but no model audio chunks ' +
        'without tts_configuration. Native Opal speech output is not exposed by ' +
        'this Realtime API session. See README "Native Opal STS status".',
    );
    this.name = 'NativeStsUnavailableError';
    this.textFragments = textFragments;
  }
}

export type NativeStsObservation = {
  /** Number of `audioChunk` callbacks received. */
  audioChunks: number;
  /** Total PCM bytes received. */
  audioBytes: number;
  /** Distinct sample rates reported with audio chunks. */
  sampleRates: number[];
  /** Distinct channel counts reported with audio chunks. */
  channels: number[];
  /** Distinct `sampleRate/channels` pairs, for diagnostics. */
  formats: string[];
  /** Number of text fragments received. */
  textFragments: number;
  /** Concatenated model text (kept for diagnostics; never includes credentials). */
  text: string;
  /** Number of `responseBegin` events. */
  responsesBegun: number;
  /** Number of `responseEnd` events. */
  responsesEnded: number;
  /** Fatal error text, if one ended the session. */
  fatalError?: string;
};

/**
 * Accumulate the observable signals from one session.
 *
 * This is intentionally a small state machine rather than an adapter: it makes
 * no claim about whether the server should send audio, it only reports whether
 * it did.
 */
export class NativeStsProbe {
  private audioChunkCount = 0;
  private audioByteCount = 0;
  private readonly sampleRateSet = new Set<number>();
  private readonly channelSet = new Set<number>();
  private readonly formatSet = new Set<string>();
  private textFragmentCount = 0;
  private textBuffer = '';
  private begun = 0;
  private ended = 0;
  private fatal: string | undefined;

  recordAudio(pcm: Uint8Array, sampleRate: number, channels: number): void {
    this.audioChunkCount += 1;
    this.audioByteCount += pcm.byteLength;
    this.sampleRateSet.add(sampleRate);
    this.channelSet.add(channels);
    this.formatSet.add(`${sampleRate}Hz/${channels}ch`);
  }

  recordText(text: string): void {
    this.textFragmentCount += 1;
    this.textBuffer += text;
  }

  beginResponse(): void {
    this.begun += 1;
  }

  endResponse(): void {
    this.ended += 1;
  }

  recordFatal(error: Error | string): void {
    this.fatal = error instanceof Error ? error.message : error;
  }

  get sawAudio(): boolean {
    return this.audioChunkCount > 0;
  }

  get observation(): NativeStsObservation {
    return {
      audioChunks: this.audioChunkCount,
      audioBytes: this.audioByteCount,
      sampleRates: [...this.sampleRateSet].sort((a, b) => a - b),
      channels: [...this.channelSet].sort((a, b) => a - b),
      formats: [...this.formatSet],
      textFragments: this.textFragmentCount,
      text: this.textBuffer,
      responsesBegun: this.begun,
      responsesEnded: this.ended,
      ...(this.fatal === undefined ? {} : { fatalError: this.fatal }),
    };
  }

  /**
   * Require a completed response that contains model audio.
   *
   * Throws when the session failed, when no response completed, or when a
   * completed response is text-only. This is the explicit guard that prevents
   * a caller from claiming native STS based on text alone.
   */
  assertNativeAudio(): NativeStsObservation {
    const observation = this.observation;

    if (observation.fatalError !== undefined) {
      throw new Error(`Deepslate session failed: ${observation.fatalError}`);
    }
    if (observation.responsesEnded === 0) {
      throw new Error(
        'No completed Deepslate response was observed; increase the probe timeout and check the credentials/network.',
      );
    }
    if (!this.sawAudio) {
      throw new NativeStsUnavailableError(observation.textFragments);
    }
    return observation;
  }
}

/** One-line, non-secret summary for the probe CLI. */
export function describeNativeStsObservation(observation: NativeStsObservation): string {
  const formats = observation.formats.length === 0 ? 'none' : observation.formats.join(', ');

  return (
    `audio chunks=${observation.audioChunks} bytes=${observation.audioBytes} ` +
    `formats=${formats} text fragments=${observation.textFragments} ` +
    `responses=${observation.responsesBegun}/${observation.responsesEnded}` +
    (observation.fatalError === undefined ? '' : ` fatal=${observation.fatalError}`)
  );
}
