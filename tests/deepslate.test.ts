/**
 * Wiring tests for the Deepslate Opal realtime model.
 *
 * Constructing a `RealtimeModel` only validates options and stores them — it
 * makes no network request and opens no websocket, so these tests are free to
 * run and need no real credentials.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HostedTtsMode, RealtimeModel } from '@deepslate-labs/livekit';
import {
  DEFAULT_BASE_URL,
  DEEPSLATE_REQUIRED_ENV_VARS,
  createRealtimeModel,
  describeVoiceOutput,
  resolveDeepslateConfig,
  resolveTtsConfig,
  resolveVadOptions,
} from '../src/deepslate.ts';
import { ConfigError } from '../src/config.ts';

/** Complete, fake Deepslate + voice environment. */
const BASE_ENV: Record<string, string> = {
  DEEPSLATE_VENDOR_ID: 'vendor_test_0000000000000000',
  DEEPSLATE_ORGANIZATION_ID: 'org_test_0000000000000000',
  DEEPSLATE_API_KEY: 'ds_test_0000000000000000',
};

/** `BASE_ENV` plus a Deepslate-hosted voice. */
const HOSTED_ENV: Record<string, string> = {
  ...BASE_ENV,
  DEEPSLATE_VOICE_ID: 'voice_test_0000000000000000',
};

/** Run `fn` and return the ConfigError it throws (fails the test otherwise). */
function captureConfigError(fn: () => void): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError to be thrown');
}

describe('resolveVadOptions', () => {
  it('leaves every knob unset so Deepslate defaults apply', () => {
    assert.deepEqual(resolveVadOptions({}), {
      confidenceThreshold: undefined,
      minVolume: undefined,
      startDurationMs: undefined,
      stopDurationMs: undefined,
      backbufferDurationMs: undefined,
    });
  });

  it('honours documented overrides', () => {
    assert.deepEqual(
      resolveVadOptions({
        DEEPSLATE_VAD_CONFIDENCE_THRESHOLD: '0.6',
        DEEPSLATE_VAD_MIN_VOLUME: '0.02',
        DEEPSLATE_VAD_START_MS: '120',
        DEEPSLATE_VAD_STOP_MS: '600',
        DEEPSLATE_VAD_BACKBUFFER_MS: '800',
      }),
      {
        confidenceThreshold: 0.6,
        minVolume: 0.02,
        startDurationMs: 120,
        stopDurationMs: 600,
        backbufferDurationMs: 800,
      },
    );
  });

  it('ignores unparseable or negative values instead of applying a wrong number', () => {
    assert.deepEqual(
      resolveVadOptions({
        DEEPSLATE_VAD_CONFIDENCE_THRESHOLD: 'loud',
        DEEPSLATE_VAD_MIN_VOLUME: '-0.1',
        DEEPSLATE_VAD_START_MS: 'fast',
      }),
      {
        confidenceThreshold: undefined,
        minVolume: undefined,
        startDurationMs: undefined,
        stopDurationMs: undefined,
        backbufferDurationMs: undefined,
      },
    );
  });
});

describe('resolveTtsConfig', () => {
  it('fails with actionable guidance when no voice output is configured', () => {
    const error = captureConfigError(() => resolveTtsConfig({}));

    assert.match(error.message, /No voice output configured/);
    assert.match(error.message, /DEEPSLATE_VOICE_ID/);
    assert.match(error.message, /ELEVENLABS_API_KEY/);
    // Without server-side TTS the plugin reports audioOutput: false.
    assert.match(error.message, /text-only/);
  });

  it('infers the Deepslate-hosted provider from DEEPSLATE_VOICE_ID', () => {
    const config = resolveTtsConfig({ DEEPSLATE_VOICE_ID: 'voice_123' });

    assert.deepEqual(config, {
      provider: 'hosted',
      voiceId: 'voice_123',
      mode: HostedTtsMode.HIGH_QUALITY,
    });
  });

  it('supports hosted low-latency mode', () => {
    const config = resolveTtsConfig({
      DEEPSLATE_VOICE_ID: 'voice_123',
      DEEPSLATE_TTS_MODE: 'low_latency',
    });

    assert.equal(config.provider, 'hosted');
    assert.equal(config.provider === 'hosted' ? config.mode : undefined, HostedTtsMode.LOW_LATENCY);
  });

  it('rejects an unknown TTS provider or mode', () => {
    assert.match(
      captureConfigError(() =>
        resolveTtsConfig({ DEEPSLATE_TTS_PROVIDER: 'cartesia' }),
      ).message,
      /must be "hosted" or "eleven_labs"/,
    );
    assert.match(
      captureConfigError(() =>
        resolveTtsConfig({ DEEPSLATE_VOICE_ID: 'v', DEEPSLATE_TTS_MODE: 'fastest' }),
      ).message,
      /must be "high_quality" or "low_latency"/,
    );
  });

  it('requires a hosted voice id when that provider is selected explicitly', () => {
    const error = captureConfigError(() =>
      resolveTtsConfig({ DEEPSLATE_TTS_PROVIDER: 'hosted' }),
    );

    assert.match(error.message, /requires DEEPSLATE_VOICE_ID/);
  });

  it('infers ElevenLabs from its credentials and names anything missing', () => {
    const config = resolveTtsConfig({
      ELEVENLABS_API_KEY: 'el_test_0000000000000000',
      ELEVENLABS_VOICE_ID: 'voice_el',
      ELEVENLABS_MODEL_ID: 'eleven_turbo_v2',
    });

    assert.equal(config.provider, 'eleven_labs');
    if (config.provider === 'eleven_labs') {
      assert.equal(config.apiKey, 'el_test_0000000000000000');
      assert.equal(config.voiceId, 'voice_el');
      assert.equal(config.modelId, 'eleven_turbo_v2');
    }

    const error = captureConfigError(() =>
      resolveTtsConfig({
        DEEPSLATE_TTS_PROVIDER: 'eleven_labs',
        ELEVENLABS_API_KEY: 'el_test_0000000000000000',
      }),
    );
    assert.match(error.message, /ELEVENLABS_VOICE_ID/);
    assert.doesNotMatch(error.message, /el_test/);
  });

  it('prefers an explicit provider over inference', () => {
    const config = resolveTtsConfig({
      DEEPSLATE_TTS_PROVIDER: 'eleven_labs',
      DEEPSLATE_VOICE_ID: 'hosted_voice',
      ELEVENLABS_API_KEY: 'el_test_0000000000000000',
      ELEVENLABS_VOICE_ID: 'voice_el',
    });

    assert.equal(config.provider, 'eleven_labs');
  });
});

describe('resolveDeepslateConfig', () => {
  it('reports every missing credential without printing any value', () => {
    const error = captureConfigError(() => resolveDeepslateConfig({}));

    assert.deepEqual(error.missing, [...DEEPSLATE_REQUIRED_ENV_VARS]);
    assert.match(error.message, /DEEPSLATE_VENDOR_ID/);
    assert.match(error.message, /DEEPSLATE_ORGANIZATION_ID/);
    assert.match(error.message, /DEEPSLATE_API_KEY/);
    assert.doesNotMatch(error.message, /ds_test/);
  });

  it('applies the documented defaults', () => {
    const config = resolveDeepslateConfig(HOSTED_ENV);

    assert.equal(config.baseUrl, DEFAULT_BASE_URL);
    assert.equal(config.model, undefined);
    assert.deepEqual(config.vad, {
      confidenceThreshold: undefined,
      minVolume: undefined,
      startDurationMs: undefined,
      stopDurationMs: undefined,
      backbufferDurationMs: undefined,
    });
    assert.equal(config.ttsConfig.provider, 'hosted');
  });

  it('passes through an explicit model and base URL', () => {
    const config = resolveDeepslateConfig({
      ...HOSTED_ENV,
      DEEPSLATE_MODEL: 'opal-v3.0-preview',
      DEEPSLATE_BASE_URL: 'https://eu.example.test',
    });

    assert.equal(config.model, 'opal-v3.0-preview');
    assert.equal(config.baseUrl, 'https://eu.example.test');
  });
});

describe('createRealtimeModel', () => {
  it('builds a Deepslate model with credentials, VAD, and TTS options', () => {
    const model = createRealtimeModel({
      ...HOSTED_ENV,
      DEEPSLATE_VAD_STOP_MS: '500',
    });

    assert.equal(model.provider, 'deepslate');
    // The plugin does not override `label()`; the base class returns the class
    // name. `provider` is the stable identifier.
    assert.equal(model.label(), 'RealtimeModel');
    assert.equal(model.opts.vendorId, HOSTED_ENV.DEEPSLATE_VENDOR_ID);
    assert.equal(model.opts.organizationId, HOSTED_ENV.DEEPSLATE_ORGANIZATION_ID);
    assert.equal(model.opts.apiKey, HOSTED_ENV.DEEPSLATE_API_KEY);
    assert.equal(model.opts.baseUrl, DEFAULT_BASE_URL);
    assert.equal(model.vad?.stopDurationMs, 500);
    assert.equal(model.ttsConfig?.provider, 'hosted');
    // Audio output is only advertised when a TTS config is present.
    assert.equal(model.capabilities.audioOutput, true);
  });

  it('advertises server-side turn detection and truncation', () => {
    const model = createRealtimeModel(HOSTED_ENV);

    assert.equal(model.capabilities.turnDetection, true);
    assert.equal(model.capabilities.messageTruncation, true);
    assert.equal(model.capabilities.userTranscription, true);
  });

  it('fails loudly and without secrets when credentials are missing', () => {
    const error = captureConfigError(() => createRealtimeModel({}));

    assert.match(error.message, /Missing required environment variable/);
    assert.deepEqual(error.missing, [...DEEPSLATE_REQUIRED_ENV_VARS]);
  });
});

describe('plugin audio capability', () => {
  it('reports no audio output when no TTS config is supplied', () => {
    // This is the plugin's own behaviour, and the reason this repo requires a
    // voice output instead of letting the agent run silently.
    const model = new RealtimeModel({
      vendorId: BASE_ENV.DEEPSLATE_VENDOR_ID!,
      organizationId: BASE_ENV.DEEPSLATE_ORGANIZATION_ID!,
      apiKey: BASE_ENV.DEEPSLATE_API_KEY!,
    });

    assert.equal(model.capabilities.audioOutput, false);
  });
});

describe('describeVoiceOutput', () => {
  it('never includes an ElevenLabs API key', () => {
    const description = describeVoiceOutput({
      provider: 'eleven_labs',
      apiKey: 'el_test_0000000000000000',
      voiceId: 'voice_el',
    });

    assert.deepEqual(description, { provider: 'eleven_labs', voiceId: 'voice_el' });
    assert.doesNotMatch(JSON.stringify(description), /el_test/);
  });
});
