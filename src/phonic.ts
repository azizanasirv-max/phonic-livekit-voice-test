/**
 * Phonic realtime-model wiring, isolated so it can be unit tested without
 * connecting to anything.
 *
 * Only options documented in the official plugin guide/README are used:
 * https://docs.livekit.io/agents/models/realtime/plugins/phonic/
 *
 * ### Interruption, in one paragraph
 *
 * Phonic owns turn detection and interruption: the plugin forwards Phonic's
 * `user_started_speaking` event to LiveKit as `input_speech_started`, LiveKit
 * then interrupts the active speech and flushes the frames it has queued for
 * playback. Two things follow from that, and both are configured here:
 *
 * 1. The assistant keeps generating and streaming audio until Phonic decides the
 *    user has spoken enough words (`minWordsToInterrupt`) — see
 *    {@link DEFAULT_MIN_WORDS_TO_INTERRUPT}.
 * 2. The plugin hardcodes Phonic's `stream_ahead_of_real_time: true`, so the
 *    assistant's audio for a turn is generated far ahead of real time. LiveKit
 *    drops everything still queued in the agent when the interruption lands, but
 *    audio that has already left the agent over RTP, and audio sitting in the
 *    caller's playback/jitter buffer, cannot be recalled. That residual tail is
 *    the part this code cannot remove; see README section 5.
 */
import * as phonic from '@livekit/agents-plugin-phonic';
import { readEnv, readIntEnv, readOptionalIntEnv, type EnvLike } from './config.ts';

/** Voice used when PHONIC_VOICE is unset (a documented Phonic voice id). */
export const DEFAULT_VOICE = 'sabrina';

/**
 * Minimum user words needed to interrupt the agent.
 *
 * `1` is Phonic's own default and the earliest interruption the API supports: a
 * single recognized word ("stop", "wait", "actually") cuts the assistant off.
 *
 * The prototype originally shipped `2` to avoid false interruptions from
 * backchannel noises. That is a real trade-off, but it is the wrong default for
 * this agent: while Phonic waits for the second word it keeps generating and
 * streaming the assistant's audio, so the caller hears the agent talk over the
 * first word or two of every interruption. Raise this (or set
 * `PHONIC_MIN_WORDS_TO_INTERRUPT`) if your microphone or accent produces false
 * interruptions, and accept the longer overlap that comes with it.
 */
export const DEFAULT_MIN_WORDS_TO_INTERRUPT = 1;

/**
 * Optional Phonic server-side VAD tuning.
 *
 * These are the only supported knobs that move *when* Phonic reports
 * `user_started_speaking` (and therefore when LiveKit can stop the assistant),
 * short of changing `minWordsToInterrupt`. Every field is left unset by default
 * so Phonic's own tuned values apply; only set them when you are tuning against
 * real recordings. See README section 5 for a starting point.
 */
export type PhonicVadOptions = {
  /** Audio kept before speech onset, in ms (`vad_prebuffer_duration_ms`). */
  vadPrebufferDurationMs?: number;
  /** How much speech must accumulate before it counts as speech onset, in ms. */
  vadMinSpeechDurationMs?: number;
  /** Silence needed before speech is considered finished, in ms. */
  vadMinSilenceDurationMs?: number;
  /** VAD sensitivity threshold. */
  vadThreshold?: number;
};

/** Resolved, non-secret Phonic options. */
export type PhonicOptions = {
  voice: string;
  minWordsToInterrupt: number;
  isWelcomeMessageInterruptible: boolean;
} & PhonicVadOptions;

/**
 * Read the optional Phonic VAD overrides. Invalid values are treated as unset
 * (see {@link readOptionalIntEnv}) so a typo cannot change turn taking.
 */
export function resolvePhonicVadOptions(env: EnvLike = process.env): PhonicVadOptions {
  return {
    vadPrebufferDurationMs: readOptionalIntEnv('PHONIC_VAD_PREBUFFER_MS', env),
    vadMinSpeechDurationMs: readOptionalIntEnv('PHONIC_VAD_MIN_SPEECH_MS', env),
    vadMinSilenceDurationMs: readOptionalIntEnv('PHONIC_VAD_MIN_SILENCE_MS', env),
    vadThreshold: readOptionalIntEnv('PHONIC_VAD_THRESHOLD', env),
  };
}

/** Resolve Phonic options from the environment, applying documented defaults. */
export function resolvePhonicOptions(env: EnvLike = process.env): PhonicOptions {
  return {
    voice: readEnv('PHONIC_VOICE', env) ?? DEFAULT_VOICE,
    minWordsToInterrupt: readIntEnv(
      'PHONIC_MIN_WORDS_TO_INTERRUPT',
      DEFAULT_MIN_WORDS_TO_INTERRUPT,
      env,
    ),
    // Let the user talk over the opening greeting.
    isWelcomeMessageInterruptible: true,
    ...resolvePhonicVadOptions(env),
  };
}

/**
 * Create the Phonic speech-to-speech model for an `AgentSession`.
 *
 * The API key is read from `PHONIC_API_KEY` by the plugin itself (never logged
 * here). The plugin throws immediately if no key is configured.
 */
export function createRealtimeModel(
  env: EnvLike = process.env,
  onConversationCreated?: (conversationId: string) => void,
): phonic.realtime.RealtimeModel {
  return new phonic.realtime.RealtimeModel({
    ...resolvePhonicOptions(env),
    onConversationCreated,
  });
}
