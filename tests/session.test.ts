/**
 * Unit tests for the turn-handling policy applied to every `AgentSession`.
 *
 * The behaviour these settings produce against the real SDK is covered by
 * `tests/interruption.test.ts`; here we only pin the policy values themselves,
 * which is what stops a later edit from silently changing them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUDIO_OUTPUT_QUEUE_MS,
  TURN_HANDLING_POLICY,
  describeTurnHandling,
  resolveRoomInputOptions,
  resolveRoomOutputOptions,
  resolveTurnHandling,
} from '../src/session.ts';

describe('resolveTurnHandling', () => {
  it('keeps the realtime model in charge of turn detection', () => {
    // `realtime_llm` means "the realtime model detects turns", i.e. Opal's
    // server-side detection. It must never be replaced by a client-side VAD or
    // turn detector, which would fight the provider's interruption events.
    assert.equal(resolveTurnHandling().turnDetection, 'realtime_llm');
  });

  it('keeps interruptions on and never resumes an interrupted response', () => {
    const { interruption } = resolveTurnHandling();

    assert.equal(interruption.enabled, true);
    // LiveKit's default (`true` + a 2 s false-interruption timeout) pauses the
    // agent's audio and resumes it later, which replays stale audio over the
    // user. That is exactly what this agent must not do.
    assert.equal(interruption.resumeFalseInterruption, false);
    assert.equal(interruption.discardAudioIfUninterruptible, true);
    // Opal already gates interruptions server-side; a second client-side
    // threshold would only delay the stop.
    assert.equal(interruption.minWords, 0);
    assert.equal(interruption.minDuration, 0);
  });

  it('returns a copy so callers cannot mutate the shared policy', () => {
    const first = resolveTurnHandling();
    const second = resolveTurnHandling();

    assert.notEqual(first, second);
    assert.notEqual(first.interruption, second.interruption);
    assert.equal(TURN_HANDLING_POLICY.interruption.resumeFalseInterruption, false);
  });
});

describe('describeTurnHandling', () => {
  it('summarises the policy in one non-secret line', () => {
    const summary = describeTurnHandling();

    assert.match(summary, /turnDetection=realtime_llm/);
    assert.match(summary, /resumeFalseInterruption=false/);
    assert.match(summary, /minWords=0/);
  });
});

describe('audio output tuning', () => {
  it('uses the SDK-supported output queue instead of inventing jitter settings', () => {
    // `RoomOutputOptions.queueSizeMs` is the only agent-side audio buffer the
    // installed @livekit/agents exposes; @livekit/rtc-node has no jitter buffer
    // option, so none is configured.
    assert.equal(AUDIO_OUTPUT_QUEUE_MS, 400);
    assert.deepEqual(resolveRoomOutputOptions(), { queueSizeMs: 400 });
  });

  it('pins participant-disconnect handling explicitly', () => {
    assert.deepEqual(resolveRoomInputOptions(), { closeOnDisconnect: true });
  });

  it('returns fresh option objects so callers cannot mutate shared state', () => {
    assert.notEqual(resolveRoomOutputOptions(), resolveRoomOutputOptions());
    assert.notEqual(resolveRoomInputOptions(), resolveRoomInputOptions());
  });
});

