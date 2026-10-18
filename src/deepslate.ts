/**
 * Deepslate Opal realtime-model wiring, isolated so it can be unit tested
 * without connecting to anything.
 *
 * Only options documented in the official plugin guide are used:
 * https://docs.deepslate.eu/livekit-node.md
 *
 * ### How audio flows
 *
 * LiveKit receives the participant's microphone audio, `AgentSession` pushes it
 * into `DeepslateRealtimeSession.pushAudio()`, and the plugin streams it to
 * Deepslate over the Opal WebSocket. Deepslate's server-side VAD detects turns
 * and interruptions; the plugin turns generated audio chunks into
 * `AudioFrame`s that LiveKit plays back into the room.
 *
 * ### Why a TTS config is required
 *
 * The plugin reports `audioOutput: false` and closes its audio stream when no
 * `ttsConfig` is supplied (see `RealtimeModel` in
 * `@deepslate-labs/livekit@0.1.23`). Deepslate's server-side TTS (a hosted
 * cloned voice or ElevenLabs) is what turns Opal's reply into PCM audio, so
 * without one the agent is text-only and the caller hears nothing. This module
 * therefore fails fast with a clear message when neither is configured.
 *
 * ### Interruption, in one paragraph
 *
 * Deepslate owns turn detection and barge-in: when its server-side VAD reports
 * that the caller started speaking, the plugin emits LiveKit's
 * `input_speech_started` and closes the current generation. LiveKit then
 * interrupts the active speech handle and clears the frames still queued for
 * playback. Audio already sent over RTP, or sitting in the caller's playback
 * buffer, cannot be recalled; see README section 6. The plugin's
 * `clearAudio()` is a no-op and `truncate()` only defers to Deepslate's own
 * server-side context truncation, so this code does not pretend to cancel
 * audio server-side.
 */
import {
  HostedTtsMode,
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
  type RequiredEnvVar,
} from './config.ts';

/** Deepslate credentials needed before a realtime session can be opened. */
export const DEEPSLATE_REQUIRED_ENV_VARS = [
  'DEEPSLATE_VENDOR_ID',
  'DEEPSLATE_ORGANIZATION_ID',
  'DEEPSLATE_API_KEY',
] as const satisfies readonly RequiredEnvVar[];

/** Default API base URL documented by Deepslate. */
export const DEFAULT_BASE_URL = 'https://app.deepslate.eu';

/** TTS providers supported by the plugin. */
export type TtsProvider = 'hosted' | 'eleven_labs';

/** Resolved, non-secret description of the configured voice output. */
export type VoiceOutput = {
  provider: TtsProvider;
  /** Hosted voice id, or the ElevenLabs voice id. Safe to log. */
  voiceId: string;
  /** Hosted mode, when the hosted provider is used. */
  mode?: HostedTtsMode;
};

/**
 * Read the optional Deepslate server-side VAD overrides.
 *
 * Invalid values are treated as unset (see `readOptionalIntEnv` /
 * `readOptionalFloatEnv`) so a typo cannot silently change turn taking.
 */
export function resolveVadOptions(env: EnvLike = process.env): VadConfig {
  return {
    confidenceThreshold: readOptionalFloatEnv('DEEPSLATE_VAD_CONFIDENCE_THRESHOLD', env),
    minVolume: readOptionalFloatEnv('DEEPSLATE_VAD_MIN_VOLUME', env),
    startDurationMs: readOptionalIntEnv('DEEPSLATE_VAD_START_MS', env),
    stopDurationMs: readOptionalIntEnv('DEEPSLATE_VAD_STOP_MS', env),
    backbufferDurationMs: readOptionalIntEnv('DEEPSLATE_VAD_BACKBUFFER_MS', env),
  };
}

/** Parse `DEEPSLATE_TTS_PROVIDER`, which is optional when another variable implies one. */
function resolveTtsProvider(env: EnvLike): TtsProvider | undefined {
  const raw = readEnv('DEEPSLATE_TTS_PROVIDER', env)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (raw === 'hosted') return 'hosted';
  if (raw === 'eleven_labs' || raw === 'elevenlabs' || raw === 'eleven-labs') {
    return 'eleven_labs';
  }
  throw new ConfigError(
    `DEEPSLATE_TTS_PROVIDER must be "hosted" or "eleven_labs" (got "${raw}"). ` +
      'Audio output is produced by Deepslate server-side TTS.',
  );
}

/** Parse `DEEPSLATE_TTS_MODE` for the hosted provider. */
function resolveHostedMode(env: EnvLike): HostedTtsMode {
  const raw = readEnv('DEEPSLATE_TTS_MODE', env)?.toLowerCase();
  if (raw === undefined) return HostedTtsMode.HIGH_QUALITY;
  if (raw === 'high_quality' || raw === 'high-quality') return HostedTtsMode.HIGH_QUALITY;
  if (raw === 'low_latency' || raw === 'low-latency') return HostedTtsMode.LOW_LATENCY;
  throw new ConfigError(
    `DEEPSLATE_TTS_MODE must be "high_quality" or "low_latency" (got "${raw}").`,
  );
}

/**
 * Resolve the server-side TTS configuration that makes Opal's replies audible.
 *
 * A provider is required: the LiveKit plugin only advertises audio output when
 * one is configured. If `DEEPSLATE_TTS_PROVIDER` is unset, the provider is
 * inferred from the credentials present (hosted voice id, then ElevenLabs).
 */
export function resolveTtsConfig(env: EnvLike = process.env): TtsConfig {
  const explicit = resolveTtsProvider(env);
  const hostedVoiceId = readEnv('DEEPSLATE_VOICE_ID', env);
  const elevenKey = readEnv('ELEVENLABS_API_KEY', env);
  const elevenVoiceId = readEnv('ELEVENLABS_VOICE_ID', env);

  const provider =
    explicit ??
    (hostedVoiceId !== undefined
      ? 'hosted'
      : elevenKey !== undefined || elevenVoiceId !== undefined
        ? 'eleven_labs'
        : undefined);

  if (provider === undefined) {
    throw new ConfigError(
      'No voice output configured. Deepslate Opal audio is synthesized by server-side TTS, ' +
        'so set either DEEPSLATE_VOICE_ID (a Deepslate-hosted cloned voice) or ' +
        'ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID. Without one the agent runs text-only ' +
        'and the caller hears nothing. See .env.example.',
    );
  }

  if (provider === 'hosted') {
    if (hostedVoiceId === undefined) {
      throw new ConfigError(
        'DEEPSLATE_TTS_PROVIDER=hosted requires DEEPSLATE_VOICE_ID ' +
          '(the id of a voice cloned and hosted in Deepslate).',
      );
    }
    return {
      provider: 'hosted',
      voiceId: hostedVoiceId,
      mode: resolveHostedMode(env),
    };
  }

  const missing: string[] = [];
  if (elevenKey === undefined) missing.push('ELEVENLABS_API_KEY');
  if (elevenVoiceId === undefined) missing.push('ELEVENLABS_VOICE_ID');
  if (elevenKey === undefined || elevenVoiceId === undefined) {
    throw new ConfigError(
      `DEEPSLATE_TTS_PROVIDER=eleven_labs requires ${missing.join(' and ')}.`,
    );
  }

  return {
    provider: 'eleven_labs',
    apiKey: elevenKey,
    voiceId: elevenVoiceId,
    modelId: readEnv('ELEVENLABS_MODEL_ID', env),
  };
}

/** Build a log-safe description of the configured voice output. */
export function describeVoiceOutput(ttsConfig: TtsConfig): VoiceOutput {
  return ttsConfig.provider === 'hosted'
    ? { provider: 'hosted', voiceId: ttsConfig.voiceId, mode: ttsConfig.mode }
    : { provider: 'eleven_labs', voiceId: ttsConfig.voiceId };
}

/** Options resolved from the environment before constructing the model. */
export type DeepslateModelConfig = {
  vendorId: string;
  organizationId: string;
  apiKey: string;
  model?: DeepslateModelId;
  baseUrl: string;
  vad: VadConfig;
  ttsConfig: TtsConfig;
};

/**
 * Validate Deepslate credentials and resolve model/voice options.
 *
 * Throws a {@link ConfigError} naming missing variables, never their values.
 */
export function resolveDeepslateConfig(env: EnvLike = process.env): DeepslateModelConfig {
  assertRequiredEnv(env, DEEPSLATE_REQUIRED_ENV_VARS);

  return {
    // assertRequiredEnv has already proven these are present.
    vendorId: readEnv('DEEPSLATE_VENDOR_ID', env)!,
    organizationId: readEnv('DEEPSLATE_ORGANIZATION_ID', env)!,
    apiKey: readEnv('DEEPSLATE_API_KEY', env)!,
    // DeepslateModelId accepts arbitrary model ids, so preview models work too.
    model: readEnv('DEEPSLATE_MODEL', env),
    baseUrl: readEnv('DEEPSLATE_BASE_URL', env) ?? DEFAULT_BASE_URL,
    vad: resolveVadOptions(env),
    ttsConfig: resolveTtsConfig(env),
  };
}

/**
 * Create the Deepslate Opal realtime model for an `AgentSession`.
 *
 * Credentials are passed explicitly (validated first) rather than left for the
 * plugin to read, so a missing value produces one clear, redacted error. The
 * model constructor opens no socket; the session connects when the agent starts.
 */
export function createRealtimeModel(env: EnvLike = process.env): RealtimeModel {
  const config = resolveDeepslateConfig(env);

  return new RealtimeModel({
    vendorId: config.vendorId,
    organizationId: config.organizationId,
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    vad: config.vad,
    ttsConfig: config.ttsConfig,
  });
}
