/**
 * Deepslate Opal realtime-model wiring.
 *
 * This is the only module that imports `@deepslate-labs/livekit`. Keeping it
 * separate from `session.ts` means the LiveKit lifecycle (room transport, turn
 * handling, interruption policy) stays provider-independent while Opal stays
 * replaceable.
 *
 * Verified against the official Node.js plugin documentation and the published
 * package `@deepslate-labs/livekit@0.1.23`:
 *   https://docs.deepslate.eu/livekit-node.md
 *
 * ### Audio output requires a TTS configuration
 *
 * The plugin only declares `audioOutput: true` when its `ttsConfig` option is
 * set (`RealtimeModel` constructor: `const audioOutput = options.ttsConfig !=
 * null`). With no TTS config Opal still understands speech and produces text,
 * but the agent sends no audio, so a spoken test cannot pass. This module
 * therefore refuses to start without either a Deepslate-hosted (cloned) voice
 * or an ElevenLabs voice/key pair.
 *
 * ### Interruption, in one paragraph
 *
 * Opal's server-side VAD emits a `playbackBufferClear` event when the caller
 * starts talking over the assistant. The plugin turns that into LiveKit's
 * `input_speech_started` and closes the active generation, so LiveKit
 * interrupts the active `SpeechHandle` and flushes its queued audio. The
 * plugin also declares `messageTruncation: true`; its `truncate()` method is a
 * no-op because the server tracks how much was actually spoken. Audio that has
 * already left the agent over RTP, or that is buffered in the caller's
 * playback path, cannot be recalled. See README "Interruption".
 */
import {
  RealtimeModel,
  type DeepslateModelId,
  type TtsConfig,
  type VadConfig,
} from '@deepslate-labs/livekit';
import {
  ConfigError,
  assertRequiredEnv,
  readEnv,
  readOptionalFloatEnv,
  readOptionalIntEnv,
  type EnvLike,
} from './config.ts';
import { AGENT_INSTRUCTIONS } from './instructions.ts';

/**
 * Variables this provider module validates. LiveKit's own credentials are
 * validated by the agent server (and by `main.ts`), so the provider test does
 * not need them.
 */
export const OPAL_REQUIRED_ENV_VARS = [
  'DEEPSLATE_VENDOR_ID',
  'DEEPSLATE_ORGANIZATION_ID',
  'DEEPSLATE_API_KEY',
] as const;

/** Resolved, non-secret Opal settings, suitable for startup logs. */
export type OpalOptions = {
  /** Pinned Opal model, or `undefined` for the platform default. */
  model: DeepslateModelId | undefined;
  /** Server-side VAD overrides; empty means "use Deepslate's defaults". */
  vad: VadConfig;
  /** TTS backend used for spoken output (never contains the API key in logs). */
  tts: TtsConfig;
};

/**
 * Read the optional Opal model override.
 *
 * Leaving `DEEPSLATE_MODEL` unset uses the platform default (currently
 * `opal-v2.1`), which is what the official documentation recommends.
 */
export function resolveOpalModel(env: EnvLike = process.env): DeepslateModelId | undefined {
  return readEnv('DEEPSLATE_MODEL', env);
}

/**
 * Read the optional server-side VAD overrides.
 *
 * Invalid or out-of-range values are treated as unset, so a typo can never
 * silently apply a nonsense threshold. All fields are optional and Deepslate's
 * documented defaults apply when omitted.
 */
export function resolveVadOptions(env: EnvLike = process.env): VadConfig {
  const vad: VadConfig = {};

  const startDurationMs = readOptionalIntEnv('DEEPSLATE_VAD_START_MS', env);
  if (startDurationMs !== undefined) vad.startDurationMs = startDurationMs;

  const stopDurationMs = readOptionalIntEnv('DEEPSLATE_VAD_STOP_MS', env);
  if (stopDurationMs !== undefined) vad.stopDurationMs = stopDurationMs;

  const backbufferDurationMs = readOptionalIntEnv('DEEPSLATE_VAD_BACKBUFFER_MS', env);
  if (backbufferDurationMs !== undefined) vad.backbufferDurationMs = backbufferDurationMs;

  // Confidence and volume are 0.0–1.0; anything outside that range is ignored.
  const confidenceThreshold = readOptionalFloatEnv('DEEPSLATE_VAD_CONFIDENCE', env);
  if (confidenceThreshold !== undefined && confidenceThreshold <= 1) {
    vad.confidenceThreshold = confidenceThreshold;
  }

  const minVolume = readOptionalFloatEnv('DEEPSLATE_VAD_MIN_VOLUME', env);
  if (minVolume !== undefined && minVolume <= 1) vad.minVolume = minVolume;

  return vad;
}

/**
 * Resolve the TTS backend that turns Opal's output into speech.
 *
 * Priority:
 *  1. `DEEPSLATE_HOSTED_VOICE_ID` → Deepslate-hosted (cloned) voice, no
 *     external TTS credentials;
 *  2. `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` → server-side ElevenLabs.
 *
 * Throws a {@link ConfigError} when neither is complete. The message names the
 * variables but never includes a value.
 */
export function resolveTtsConfig(env: EnvLike = process.env): TtsConfig {
  const hostedVoiceId = readEnv('DEEPSLATE_HOSTED_VOICE_ID', env);
  if (hostedVoiceId !== undefined) {
    return { provider: 'hosted', voiceId: hostedVoiceId };
  }

  const apiKey = readEnv('ELEVENLABS_API_KEY', env);
  const voiceId = readEnv('ELEVENLABS_VOICE_ID', env);

  if (apiKey !== undefined && voiceId !== undefined) {
    const modelId = readEnv('ELEVENLABS_MODEL_ID', env);
    return modelId === undefined
      ? { provider: 'eleven_labs', apiKey, voiceId }
      : { provider: 'eleven_labs', apiKey, voiceId, modelId };
  }

  const partial =
    apiKey !== undefined
      ? ' ELEVENLABS_API_KEY is set but ELEVENLABS_VOICE_ID is missing.'
      : '';

  throw new ConfigError(
    'No audio output configured for Opal. Set both ELEVENLABS_API_KEY and ' +
      'ELEVENLABS_VOICE_ID (this deployment uses server-side ElevenLabs TTS), ' +
      'or set DEEPSLATE_HOSTED_VOICE_ID if you have a Deepslate-hosted voice.' +
      partial,
  );
}

/** One-line description of the TTS backend for logs (never the API key). */
export function describeTtsConfig(tts: TtsConfig): string {
  if (tts.provider === 'hosted') {
    return `provider=hosted voiceId=${tts.voiceId} mode=${tts.mode ?? 'HIGH_QUALITY (default)'}`;
  }
  return (
    `provider=eleven_labs voiceId=${tts.voiceId} ` +
    `modelId=${tts.modelId ?? '(provider default)'}`
  );
}

/** Resolve every non-secret Opal option in one pass. */
export function resolveOpalOptions(env: EnvLike = process.env): OpalOptions {
  return {
    model: resolveOpalModel(env),
    vad: resolveVadOptions(env),
    tts: resolveTtsConfig(env),
  };
}

/** Read a required variable, throwing a {@link ConfigError} when it is blank. */
function required(name: string, env: EnvLike): string {
  const value = readEnv(name, env);
  if (value === undefined) {
    throw new ConfigError(`Missing required environment variable: ${name}.`);
  }
  return value;
}

/**
 * Create the Opal speech-to-speech model for an `AgentSession`.
 *
 * Credentials are resolved from the environment and passed explicitly; the
 * plugin also supports reading them from `process.env`, but passing them keeps
 * this function testable with a plain object and avoids a hidden global read.
 *
 * No network connection is opened here: the plugin connects when the
 * `AgentSession` creates its realtime session.
 */
export function createRealtimeModel(env: EnvLike = process.env): RealtimeModel {
  assertRequiredEnv(env, OPAL_REQUIRED_ENV_VARS);
  const options = resolveOpalOptions(env);

  return new RealtimeModel({
    vendorId: required('DEEPSLATE_VENDOR_ID', env),
    organizationId: required('DEEPSLATE_ORGANIZATION_ID', env),
    apiKey: required('DEEPSLATE_API_KEY', env),
    // Seed the server-side prompt with the same instructions the LiveKit agent
    // carries. The plugin also supports live `updateInstructions()` calls.
    systemPrompt: AGENT_INSTRUCTIONS,
    ...(options.model === undefined ? {} : { model: options.model }),
    vad: options.vad,
    ttsConfig: options.tts,
  });
}
