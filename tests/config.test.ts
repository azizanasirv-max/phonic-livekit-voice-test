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
  readOptionalIntEnv,
  redactSecrets,
  safeEnvSummary,
  validateLivekitUrl,
} from '../src/config.ts';

/** A complete, fake environment. Values here are obviously not real keys. */
const FULL_ENV: Record<string, string> = {
  PHONIC_API_KEY: 'ph_test_0000000000000000',
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
    assert.equal(readEnv('PHONIC_API_KEY', {}), undefined);
    assert.equal(readEnv('PHONIC_API_KEY', { PHONIC_API_KEY: '   ' }), undefined);
  });

  it('trims surrounding whitespace', () => {
    assert.equal(readEnv('PHONIC_VOICE', { PHONIC_VOICE: ' sabrina ' }), 'sabrina');
  });
});

describe('getMissingEnvVars / assertRequiredEnv', () => {
  it('reports every missing variable when the environment is empty', () => {
    assert.deepEqual(getMissingEnvVars({}), [
      'PHONIC_API_KEY',
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
    const error = captureConfigError(() => assertRequiredEnv({ ...FULL_ENV, PHONIC_API_KEY: '' }));

    assert.deepEqual(error.missing, ['PHONIC_API_KEY']);
    assert.match(error.message, /PHONIC_API_KEY/);
    assert.doesNotMatch(error.message, /ph_test/);
    assert.match(error.message, /\.env\.example/);
  });
});

describe('maskSecret', () => {
  it('never reveals the middle of a credential', () => {
    const masked = maskSecret('ph_test_0000000000000000');
    assert.ok(!masked.includes('0000000000'));
    assert.equal(masked, 'ph_t…0000');
  });

  it('fully hides short values and labels unset values', () => {
    assert.equal(maskSecret('short'), '****');
    assert.equal(maskSecret(undefined), '(not set)');
    assert.equal(maskSecret('  '), '(not set)');
  });
});

describe('redactSecrets', () => {
  it('removes every configured credential from arbitrary text', () => {
    const text = `connect failed for key ${FULL_ENV.PHONIC_API_KEY} using ${FULL_ENV.LIVEKIT_API_SECRET}`;
    const redacted = redactSecrets(text, FULL_ENV);

    assert.doesNotMatch(redacted, /ph_test_0000000000000000/);
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

    assert.doesNotMatch(summary, /ph_test_0000000000000000/);
    assert.doesNotMatch(summary, /secret_0000000000000000/);
    // The non-secret URL is fine to show.
    assert.match(summary, /wss:\/\/example\.livekit\.cloud/);
  });
});

describe('readIntEnv', () => {
  it('parses integers and falls back on unset/invalid/negative values', () => {
    assert.equal(readIntEnv('PHONIC_MIN_WORDS_TO_INTERRUPT', 2, {}), 2);
    assert.equal(readIntEnv('PHONIC_MIN_WORDS_TO_INTERRUPT', 2, { PHONIC_MIN_WORDS_TO_INTERRUPT: '4' }), 4);
    assert.equal(readIntEnv('PHONIC_MIN_WORDS_TO_INTERRUPT', 2, { PHONIC_MIN_WORDS_TO_INTERRUPT: 'abc' }), 2);
    assert.equal(readIntEnv('PHONIC_MIN_WORDS_TO_INTERRUPT', 2, { PHONIC_MIN_WORDS_TO_INTERRUPT: '-1' }), 2);
  });
});

describe('readOptionalIntEnv', () => {
  it('returns a parsed value only when one is configured', () => {
    assert.equal(readOptionalIntEnv('PHONIC_VAD_THRESHOLD', {}), undefined);
    assert.equal(readOptionalIntEnv('PHONIC_VAD_THRESHOLD', { PHONIC_VAD_THRESHOLD: '  ' }), undefined);
    assert.equal(readOptionalIntEnv('PHONIC_VAD_THRESHOLD', { PHONIC_VAD_THRESHOLD: '0' }), 0);
    assert.equal(readOptionalIntEnv('PHONIC_VAD_THRESHOLD', { PHONIC_VAD_THRESHOLD: '250' }), 250);
  });

  it('treats invalid values as unset so a typo cannot change behaviour', () => {
    assert.equal(readOptionalIntEnv('PHONIC_VAD_THRESHOLD', { PHONIC_VAD_THRESHOLD: 'abc' }), undefined);
    assert.equal(readOptionalIntEnv('PHONIC_VAD_THRESHOLD', { PHONIC_VAD_THRESHOLD: '-5' }), undefined);
    assert.equal(readOptionalIntEnv('PHONIC_VAD_THRESHOLD', { PHONIC_VAD_THRESHOLD: '1.5' }), 1);
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
