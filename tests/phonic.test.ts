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
  resolvePhonicVadOptions,
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
      vadPrebufferDurationMs: undefined,
      vadMinSpeechDurationMs: undefined,
      vadMinSilenceDurationMs: undefined,
      vadThreshold: undefined,
    });
    assert.equal(DEFAULT_VOICE, 'sabrina');
  });

  it('defaults minWordsToInterrupt to 1 so one word can interrupt', () => {
    // 1 is Phonic's own default and the earliest interruption it supports.
    // Raising it makes the assistant keep talking over the start of the user's
    // interruption, so this default is a behavioural guarantee, not a taste call.
    assert.equal(DEFAULT_MIN_WORDS_TO_INTERRUPT, 1);
    assert.equal(resolvePhonicOptions({}).minWordsToInterrupt, 1);
  });

  it('honours environment overrides', () => {
    const options = resolvePhonicOptions({
      PHONIC_VOICE: 'grant',
      PHONIC_MIN_WORDS_TO_INTERRUPT: '3',
    });

    assert.equal(options.voice, 'grant');
    assert.equal(options.minWordsToInterrupt, 3);
  });

  it('leaves Phonic VAD tuning unset unless it is configured', () => {
    assert.deepEqual(resolvePhonicVadOptions({}), {
      vadPrebufferDurationMs: undefined,
      vadMinSpeechDurationMs: undefined,
      vadMinSilenceDurationMs: undefined,
      vadThreshold: undefined,
    });

    const tuned = resolvePhonicVadOptions({
      PHONIC_VAD_PREBUFFER_MS: '200',
      PHONIC_VAD_MIN_SPEECH_MS: '150',
      PHONIC_VAD_MIN_SILENCE_MS: '500',
      PHONIC_VAD_THRESHOLD: '0',
    });
    assert.deepEqual(tuned, {
      vadPrebufferDurationMs: 200,
      vadMinSpeechDurationMs: 150,
      vadMinSilenceDurationMs: 500,
      vadThreshold: 0,
    });
  });

  it('ignores unparseable VAD values instead of applying a wrong number', () => {
    const options = resolvePhonicVadOptions({
      PHONIC_VAD_MIN_SPEECH_MS: 'fast',
      PHONIC_VAD_MIN_SILENCE_MS: '-50',
    });

    assert.equal(options.vadMinSpeechDurationMs, undefined);
    assert.equal(options.vadMinSilenceDurationMs, undefined);
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

  it('passes Phonic VAD tuning through to the plugin', () => {
    process.env.PHONIC_API_KEY = FAKE_KEY;

    const model = createRealtimeModel({
      PHONIC_VAD_MIN_SPEECH_MS: '150',
      PHONIC_VAD_MIN_SILENCE_MS: '500',
    });

    assert.equal(model._options.vadMinSpeechDurationMs, 150);
    assert.equal(model._options.vadMinSilenceDurationMs, 500);
    // Untouched knobs stay undefined so Phonic's own defaults apply.
    assert.equal(model._options.vadPrebufferDurationMs, undefined);
    assert.equal(model._options.vadThreshold, undefined);
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
