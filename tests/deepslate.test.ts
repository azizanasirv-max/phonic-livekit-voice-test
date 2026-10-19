/**
 * Wiring tests for the Deepslate Opal realtime model.
 *
 * Constructing a `RealtimeModel` only validates options and stores them — it
 * makes no network request and opens no websocket (the plugin connects when an
 * `AgentSession` creates a realtime session), so these tests need no real
 * credentials and cost nothing.
 *
 * The assertions use the plugin's public `opts`, `vad`, `ttsConfig` and
 * `capabilities` fields, which is how the official Node.js guide documents the
 * configuration surface.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initializeLogger, voice } from '@livekit/agents';
import { ConfigError } from '../src/config.ts';
import {
  createRealtimeModel,
  describeTtsConfig,
  resolveOpalModel,
  resolveTtsConfig,
  resolveVadOptions,
} from '../src/deepslate.ts';
import { AGENT_INSTRUCTIONS } from '../src/instructions.ts';
import { createAgentSession } from '../src/session.ts';

// The SDK requires its logger before an AgentSession can be constructed.
initializeLogger({ pretty: false, level: 'silent' });

const BASE_ENV: Record<string, string> = {
  DEEPSLATE_VENDOR_ID: 'vendor_test_0000',
  DEEPSLATE_ORGANIZATION_ID: 'org_test_0000',
  DEEPSLATE_API_KEY: 'ds_test_0000000000000000',
  DEEPSLATE_HOSTED_VOICE_ID: 'hosted-voice-123',
};

/** Build a complete fake environment with optional overrides. */
function env(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const merged: Record<string, string> = { ...BASE_ENV };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** Capture the ConfigError thrown by `fn`. */
function captureConfigError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('createRealtimeModel', () => {
  it('constructs the documented Opal model with the resolved credentials', () => {
    const model = createRealtimeModel(env());

    assert.equal(model.opts.vendorId, BASE_ENV.DEEPSLATE_VENDOR_ID);
    assert.equal(model.opts.organizationId, BASE_ENV.DEEPSLATE_ORGANIZATION_ID);
    assert.equal(model.opts.apiKey, BASE_ENV.DEEPSLATE_API_KEY);
    assert.equal(model.opts.systemPrompt, AGENT_INSTRUCTIONS);
    // Unset means "platform default" (opal-v2.1 today), so no model is pinned.
    assert.equal(model.opts.model, undefined);
    assert.equal(model.model, 'deepslate-realtime');
  });

  it('declares audio output and turn detection, which a spoken test depends on', () => {
    const model = createRealtimeModel(env());

    assert.equal(model.capabilities.audioOutput, true);
    assert.equal(model.capabilities.turnDetection, true);
    assert.equal(model.capabilities.messageTruncation, true);
    // No overlapping-speech mode is advertised: LiveKit interrupts the active
    // response when Opal reports that the user started speaking.
    assert.notEqual(
      (model.capabilities as { supportsOverlappingSpeech?: boolean }).supportsOverlappingSpeech,
      true,
    );
  });

  it('pins DEEPSLATE_MODEL when set and passes the VAD overrides through', () => {
    const model = createRealtimeModel(
      env({
        DEEPSLATE_MODEL: 'opal-v3.0-preview',
        DEEPSLATE_VAD_START_MS: '120',
        DEEPSLATE_VAD_STOP_MS: '600',
        DEEPSLATE_VAD_CONFIDENCE: '0.7',
        DEEPSLATE_VAD_MIN_VOLUME: '0.02',
        DEEPSLATE_VAD_BACKBUFFER_MS: '800',
      }),
    );

    assert.equal(model.opts.model, 'opal-v3.0-preview');
    assert.deepEqual(model.vad, {
      startDurationMs: 120,
      stopDurationMs: 600,
      confidenceThreshold: 0.7,
      minVolume: 0.02,
      backbufferDurationMs: 800,
    });
  });

  it('plugs into a real AgentSession with the pinned turn policy', () => {
    const session = createAgentSession(createRealtimeModel(env()));

    assert.ok(session instanceof voice.AgentSession);
    assert.equal(session.sessionOptions.turnHandling.turnDetection, 'realtime_llm');
    assert.equal(session.sessionOptions.turnHandling.interruption.enabled, true);
    assert.equal(session.sessionOptions.turnHandling.interruption.resumeFalseInterruption, false);
  });

  it('fails clearly when required Deepslate credentials are missing', () => {
    const error = captureConfigError(() => createRealtimeModel({}));

    assert.match(error.message, /DEEPSLATE_VENDOR_ID/);
    assert.match(error.message, /DEEPSLATE_ORGANIZATION_ID/);
    assert.match(error.message, /DEEPSLATE_API_KEY/);
    assert.equal(error.missing.length, 3);
  });

  it('fails before connecting when no TTS backend can be resolved', () => {
    const error = captureConfigError(() =>
      createRealtimeModel(env({ DEEPSLATE_HOSTED_VOICE_ID: undefined })),
    );

    assert.match(error.message, /No audio output configured for Opal/);
    assert.match(error.message, /DEEPSLATE_HOSTED_VOICE_ID/);
    assert.match(error.message, /ELEVENLABS_API_KEY/);
    // The message names variables only; no credential value leaks into it.
    assert.doesNotMatch(error.message, /ds_test_0000000000000000/);
  });
});

describe('resolveOpalModel', () => {
  it('leaves the model unset unless an override is configured', () => {
    assert.equal(resolveOpalModel({}), undefined);
    assert.equal(resolveOpalModel({ DEEPSLATE_MODEL: '  ' }), undefined);
    assert.equal(resolveOpalModel({ DEEPSLATE_MODEL: ' opal-v2.1 ' }), 'opal-v2.1');
  });

describe('resolveVadOptions', () => {
  it('returns an empty object so Deepslate defaults apply', () => {
    assert.deepEqual(resolveVadOptions({}), {});
  });

  it('ignores invalid and out-of-range values instead of applying them', () => {
    assert.deepEqual(
      resolveVadOptions({
        DEEPSLATE_VAD_START_MS: 'soon',
        DEEPSLATE_VAD_CONFIDENCE: '1.5',
        DEEPSLATE_VAD_MIN_VOLUME: '2',
        DEEPSLATE_VAD_STOP_MS: '-1',
      }),
      {},
    );
  });

  it('keeps zero, which is a meaningful VAD value', () => {
    assert.deepEqual(resolveVadOptions({ DEEPSLATE_VAD_MIN_VOLUME: '0' }), { minVolume: 0 });
  });
});

describe('resolveTtsConfig', () => {
  it('prefers a Deepslate-hosted voice', () => {
    assert.deepEqual(resolveTtsConfig(env()), {
      provider: 'hosted',
      voiceId: BASE_ENV.DEEPSLATE_HOSTED_VOICE_ID,
    });
  });

  it('falls back to ElevenLabs with the documented env vars', () => {
    const tts = resolveTtsConfig(
      env({
        DEEPSLATE_HOSTED_VOICE_ID: undefined,
        ELEVENLABS_API_KEY: 'el_test_0000000000000000',
        ELEVENLABS_VOICE_ID: 'voice-abc',
        ELEVENLABS_MODEL_ID: 'eleven_turbo_v2',
      }),
    );

    assert.deepEqual(tts, {
      provider: 'eleven_labs',
      apiKey: 'el_test_0000000000000000',
      voiceId: 'voice-abc',
      modelId: 'eleven_turbo_v2',
    });
  });

  it('prefers the hosted voice when both backends are configured', () => {
    const tts = resolveTtsConfig(
      env({
        ELEVENLABS_API_KEY: 'el_test_0000000000000000',
        ELEVENLABS_VOICE_ID: 'voice-abc',
      }),
    );

    assert.equal(tts.provider, 'hosted');
  });

  it('explains the partial ElevenLabs configuration', () => {
    const error = captureConfigError(() =>
      resolveTtsConfig(
        env({
          DEEPSLATE_HOSTED_VOICE_ID: undefined,
          ELEVENLABS_API_KEY: 'el_test_0000000000000000',
        }),
      ),
    );

    assert.match(error.message, /ELEVENLABS_VOICE_ID is missing/);
    assert.doesNotMatch(error.message, /el_test_0000000000000000/);
  });
});

describe('describeTtsConfig', () => {
  it('summarises the backend without revealing an API key', () => {
    const hosted = describeTtsConfig(
      resolveTtsConfig(env({ DEEPSLATE_HOSTED_VOICE_ID: 'hosted-voice-123' })),
    );
    assert.match(hosted, /provider=hosted/);
    assert.match(hosted, /voiceId=hosted-voice-123/);

    const eleven = describeTtsConfig(
      resolveTtsConfig(
        env({
          DEEPSLATE_HOSTED_VOICE_ID: undefined,
          ELEVENLABS_API_KEY: 'el_test_0000000000000000',
          ELEVENLABS_VOICE_ID: 'voice-abc',
        }),
      ),
    );
    assert.match(eleven, /provider=eleven_labs/);
    assert.doesNotMatch(eleven, /el_test_0000000000000000/);
  });
});

});
