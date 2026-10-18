/**
 * Unit tests for environment handling and credential redaction.
 * Pure functions only — no network, no credentials, no cost.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConfigError,
  assertRequiredEnv,
  getMissingEnvVars,
  maskSecret,
  readEnv,
  readIntEnv,
  readOptionalFloatEnv,
  readOptionalIntEnv,
  redactSecrets,
  safeEnvSummary,
  validateLivekitUrl,
} from '../src/config.ts';

/** A complete, fake environment. Values here are obviously not real keys. */
const FULL_ENV: Record<string, string> = {
  DEEPSLATE_VENDOR_ID: 'vendor_test_0000000000000000',
  DEEPSLATE_ORGANIZATION_ID: 'org_test_0000000000000000',
  DEEPSLATE_API_KEY: 'ds_test_0000000000000000',
  LIVEKIT_URL: 'wss://example.livekit.cloud',
  LIVEKIT_API_KEY: 'API0000000000000',
  LIVEKIT_API_SECRET: 'secret_0000000000000000',
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

describe('readEnv', () => {
  it('returns undefined for missing and blank values', () => {
    assert.equal(readEnv('DEEPSLATE_API_KEY', {}), undefined);
    assert.equal(readEnv('DEEPSLATE_API_KEY', { DEEPSLATE_API_KEY: '   ' }), undefined);
  });

  it('trims surrounding whitespace', () => {
    assert.equal(readEnv('DEEPSLATE_MODEL', { DEEPSLATE_MODEL: ' opal-v2.1 ' }), 'opal-v2.1');
  });
});

describe('getMissingEnvVars / assertRequiredEnv', () => {
  it('reports every missing variable when the environment is empty', () => {
    assert.deepEqual(getMissingEnvVars({}), [
      'DEEPSLATE_VENDOR_ID',
      'DEEPSLATE_ORGANIZATION_ID',
      'DEEPSLATE_API_KEY',
      'LIVEKIT_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
    ]);
  });

  it('reports nothing when the environment is complete', () => {
    assert.deepEqual(getMissingEnvVars(FULL_ENV), []);
    assert.doesNotThrow(() => assertRequiredEnv(FULL_ENV));
  });

  it('throws a ConfigError naming the missing variables but no values', () => {
    const error = captureConfigError(() => assertRequiredEnv({ ...FULL_ENV, DEEPSLATE_API_KEY: '' }));

    assert.deepEqual(error.missing, ['DEEPSLATE_API_KEY']);
    assert.match(error.message, /DEEPSLATE_API_KEY/);
    assert.doesNotMatch(error.message, /ds_test/);
    assert.match(error.message, /\.env\.example/);
  });
});

describe('maskSecret', () => {
  it('never reveals the middle of a credential', () => {
    const masked = maskSecret('ds_test_0000000000000000');
    assert.ok(!masked.includes('0000000000'));
    assert.equal(masked, 'ds_t…0000');
  });

  it('fully hides short values and labels unset values', () => {
    assert.equal(maskSecret('short'), '****');
    assert.equal(maskSecret(undefined), '(not set)');
    assert.equal(maskSecret('  '), '(not set)');
  });
});

describe('redactSecrets', () => {
  it('removes every configured credential from arbitrary text', () => {
    const text = `connect failed for key ${FULL_ENV.DEEPSLATE_API_KEY} using ${FULL_ENV.LIVEKIT_API_SECRET}`;
    const redacted = redactSecrets(text, FULL_ENV);

    assert.doesNotMatch(redacted, /ds_test_0000000000000000/);
    assert.doesNotMatch(redacted, /secret_0000000000000000/);
    assert.match(redacted, /connect failed/);
  });

  it('leaves text untouched when no secrets are configured', () => {
    assert.equal(redactSecrets('nothing to hide', {}), 'nothing to hide');
  });
});

describe('safeEnvSummary', () => {
  it('contains no raw secret values', () => {
    const summary = JSON.stringify(safeEnvSummary(FULL_ENV));

    assert.doesNotMatch(summary, /ds_test_0000000000000000/);
    assert.doesNotMatch(summary, /secret_0000000000000000/);
    // The non-secret URL is fine to show.
    assert.match(summary, /wss:\/\/example\.livekit\.cloud/);
  });
});

describe('readIntEnv', () => {
  it('parses integers and falls back on unset/invalid/negative values', () => {
    assert.equal(readIntEnv('DEEPSLATE_VAD_START_MS', 150, {}), 150);
    assert.equal(readIntEnv('DEEPSLATE_VAD_START_MS', 150, { DEEPSLATE_VAD_START_MS: '120' }), 120);
    assert.equal(readIntEnv('DEEPSLATE_VAD_START_MS', 150, { DEEPSLATE_VAD_START_MS: 'abc' }), 150);
    assert.equal(readIntEnv('DEEPSLATE_VAD_START_MS', 150, { DEEPSLATE_VAD_START_MS: '-1' }), 150);
  });
});

describe('readOptionalFloatEnv', () => {
  it('parses decimals and treats invalid or negative values as unset', () => {
    assert.equal(readOptionalFloatEnv('DEEPSLATE_VAD_MIN_VOLUME', {}), undefined);
    assert.equal(readOptionalFloatEnv('DEEPSLATE_VAD_MIN_VOLUME', { DEEPSLATE_VAD_MIN_VOLUME: '0.02' }), 0.02);
    assert.equal(readOptionalFloatEnv('DEEPSLATE_VAD_MIN_VOLUME', { DEEPSLATE_VAD_MIN_VOLUME: 'loud' }), undefined);
    assert.equal(readOptionalFloatEnv('DEEPSLATE_VAD_MIN_VOLUME', { DEEPSLATE_VAD_MIN_VOLUME: '-0.1' }), undefined);
  });
});

describe('readOptionalIntEnv', () => {
  it('returns a parsed value only when one is configured', () => {
    assert.equal(readOptionalIntEnv('DEEPSLATE_VAD_CONFIDENCE_THRESHOLD', {}), undefined);
    assert.equal(readOptionalIntEnv('DEEPSLATE_VAD_CONFIDENCE_THRESHOLD', { DEEPSLATE_VAD_CONFIDENCE_THRESHOLD: '  ' }), undefined);
    assert.equal(readOptionalIntEnv('DEEPSLATE_VAD_CONFIDENCE_THRESHOLD', { DEEPSLATE_VAD_CONFIDENCE_THRESHOLD: '0' }), 0);
    assert.equal(readOptionalIntEnv('DEEPSLATE_VAD_CONFIDENCE_THRESHOLD', { DEEPSLATE_VAD_CONFIDENCE_THRESHOLD: '250' }), 250);
  });

  it('treats invalid values as unset so a typo cannot change behaviour', () => {
    assert.equal(readOptionalIntEnv('DEEPSLATE_VAD_CONFIDENCE_THRESHOLD', { DEEPSLATE_VAD_CONFIDENCE_THRESHOLD: 'abc' }), undefined);
    assert.equal(readOptionalIntEnv('DEEPSLATE_VAD_CONFIDENCE_THRESHOLD', { DEEPSLATE_VAD_CONFIDENCE_THRESHOLD: '-5' }), undefined);
    assert.equal(readOptionalIntEnv('DEEPSLATE_VAD_CONFIDENCE_THRESHOLD', { DEEPSLATE_VAD_CONFIDENCE_THRESHOLD: '1.5' }), 1);
  });
});

describe('validateLivekitUrl', () => {
  it('accepts a LiveKit Cloud wss:// URL', () => {
    const check = validateLivekitUrl('wss://my-project.livekit.cloud');
    assert.equal(check.ok, true);
    assert.deepEqual(check.problems, []);
    assert.equal(check.scheme, 'wss:');
    assert.equal(check.host, 'my-project.livekit.cloud');
  });

  it('accepts a local self-hosted ws:// URL but warns it cannot be LiveKit Cloud', () => {
    const check = validateLivekitUrl('ws://127.0.0.1:7880');
    assert.equal(check.ok, true);
    assert.equal(check.warnings.length, 1);
    assert.match(check.warnings[0]!, /cannot reach LiveKit Cloud/);
  });

  it('rejects an http(s):// URL', () => {
    const check = validateLivekitUrl('https://my-project.livekit.cloud');
    assert.equal(check.ok, false);
    assert.match(check.problems[0]!, /needs a WebSocket URL/);
  });

  it('rejects insecure ws:// for a remote host', () => {
    const check = validateLivekitUrl('ws://my-project.livekit.cloud');
    assert.equal(check.ok, false);
    assert.match(check.problems[0]!, /requires "wss:\/\//);
  });

  it('rejects missing and unparseable values', () => {
    assert.equal(validateLivekitUrl(undefined).ok, false);
    assert.match(validateLivekitUrl(undefined).problems[0]!, /not set/);
    assert.equal(validateLivekitUrl('my-project.livekit.cloud').ok, false);
    assert.match(validateLivekitUrl('my-project.livekit.cloud').problems[0]!, /not a valid URL/);
  });

  it('warns about a non-cloud wss:// host', () => {
    const check = validateLivekitUrl('wss://livekit.internal.example.com');
    assert.equal(check.ok, true);
    assert.match(check.warnings[0]!, /not a \*\.livekit\.cloud host/);
  });
});
