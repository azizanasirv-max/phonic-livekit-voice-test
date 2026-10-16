/**
 * Wiring tests for the Phonic realtime model.
 *
 * Constructing a `RealtimeModel` only validates options and stores them — it
 * makes no network request and opens no websocket, so these tests are free to
 * run and need no real credentials.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  DEFAULT_MIN_WORDS_TO_INTERRUPT,
  DEFAULT_VOICE,
  createRealtimeModel,
  resolvePhonicOptions,
} from '../src/phonic.ts';

const FAKE_KEY = 'ph_test_0000000000000000';

afterEach(() => {
  delete process.env.PHONIC_API_KEY;
});

describe('resolvePhonicOptions', () => {
  it('applies the documented defaults', () => {
    assert.deepEqual(resolvePhonicOptions({}), {
      voice: DEFAULT_VOICE,
      minWordsToInterrupt: DEFAULT_MIN_WORDS_TO_INTERRUPT,
      isWelcomeMessageInterruptible: true,
    });
    assert.equal(DEFAULT_VOICE, 'sabrina');
    assert.equal(DEFAULT_MIN_WORDS_TO_INTERRUPT, 2);
  });

  it('honours environment overrides', () => {
    const options = resolvePhonicOptions({
      PHONIC_VOICE: 'grant',
      PHONIC_MIN_WORDS_TO_INTERRUPT: '3',
    });

    assert.equal(options.voice, 'grant');
    assert.equal(options.minWordsToInterrupt, 3);
  });
});

describe('createRealtimeModel', () => {
  it('builds a Phonic speech-to-speech model with the resolved options', () => {
    process.env.PHONIC_API_KEY = FAKE_KEY;

    const model = createRealtimeModel({
      PHONIC_VOICE: 'virginia',
      PHONIC_MIN_WORDS_TO_INTERRUPT: '4',
    });

    assert.equal(model.provider, 'phonic');
    assert.equal(model.label(), 'phonic.RealtimeModel');
    // `_options` is the plugin's own resolved option bag (marked @internal).
    // Asserting on it proves the options reach the plugin constructor.
    assert.equal(model._options.voice, 'virginia');
    assert.equal(model._options.minWordsToInterrupt, 4);
    assert.equal(model._options.isWelcomeMessageInterruptible, true);
  });

  it('forwards the conversation-created callback', () => {
    process.env.PHONIC_API_KEY = FAKE_KEY;

    const seen: string[] = [];
    const model = createRealtimeModel({}, (id) => seen.push(id));

    assert.equal(typeof model._options.onConversationCreated, 'function');
    model._options.onConversationCreated?.('conv_123');
    assert.deepEqual(seen, ['conv_123']);
  });

  it('fails loudly and without secrets when PHONIC_API_KEY is missing', () => {
    delete process.env.PHONIC_API_KEY;

    assert.throws(
      () => createRealtimeModel({}),
      /Phonic API key is required/,
    );
  });
});
