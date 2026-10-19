/**
 * Unit tests for the native-STS capability probe.
 *
 * These tests only exercise the observation/verdict logic with synthetic
 * events. They do **not** prove that Deepslate emits native Opal audio; that is
 * why `scripts/probe-native-sts.ts` must be run against a real account before
 * any production claim is made.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NativeStsProbe,
  NativeStsUnavailableError,
  describeNativeStsObservation,
} from '../src/native-sts.ts';

describe('NativeStsProbe', () => {
  it('accepts a completed response that contains model audio', () => {
    const probe = new NativeStsProbe();
    probe.beginResponse();
    probe.recordText('Hello from Opal.');
    probe.recordAudio(new Uint8Array(960), 24_000, 1);
    probe.recordAudio(new Uint8Array(960), 24_000, 1);
    probe.endResponse();

    const observation = probe.assertNativeAudio();

    assert.equal(observation.audioChunks, 2);
    assert.equal(observation.audioBytes, 1920);
    assert.deepEqual(observation.sampleRates, [24_000]);
    assert.deepEqual(observation.channels, [1]);
    assert.equal(observation.textFragments, 1);
    assert.equal(observation.text, 'Hello from Opal.');
    assert.equal(observation.responsesBegun, 1);
    assert.equal(observation.responsesEnded, 1);
  });

  it('rejects a completed text-only response as unsupported native STS', () => {
    const probe = new NativeStsProbe();
    probe.beginResponse();
    probe.recordText('This is text, not speech.');
    probe.endResponse();

    assert.throws(
      () => probe.assertNativeAudio(),
      (error: unknown) =>
        error instanceof NativeStsUnavailableError &&
        /no model audio chunks/.test(error.message) &&
        error.textFragments === 1,
    );
  });

  it('rejects a session that never completed a response', () => {
    const probe = new NativeStsProbe();
    probe.recordText('partial');

    assert.throws(() => probe.assertNativeAudio(), /No completed Deepslate response/);
  });

  it('rejects a session that failed even if audio arrived', () => {
    const probe = new NativeStsProbe();
    probe.beginResponse();
    probe.recordAudio(new Uint8Array(480), 16_000, 1);
    probe.recordFatal(new Error('connection rejected'));

    assert.throws(() => probe.assertNativeAudio(), /connection rejected/);
  });

  it('summarises formats and counts without secrets', () => {
    const probe = new NativeStsProbe();
    probe.beginResponse();
    probe.recordAudio(new Uint8Array(480), 16_000, 1);
    probe.recordAudio(new Uint8Array(480), 24_000, 2);
    probe.recordText('hello');
    probe.endResponse();

    const summary = describeNativeStsObservation(probe.observation);

    assert.match(summary, /audio chunks=2 bytes=960/);
    assert.match(summary, /16000Hz\/1ch/);
    assert.match(summary, /24000Hz\/2ch/);
    assert.match(summary, /text fragments=1/);
    assert.match(summary, /responses=1\/1/);
  });
});
