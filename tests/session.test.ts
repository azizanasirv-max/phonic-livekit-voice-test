/**
 * Unit tests for the turn-handling policy applied to every `AgentSession`.
 *
 * The behaviour these settings produce against the real SDK is covered by
 * `tests/interruption.test.ts`; here we only pin the policy values themselves,
 * which is what stops a later edit from silently changing them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TURN_HANDLING_POLICY, describeTurnHandling, resolveTurnHandling } from '../src/session.ts';

describe('resolveTurnHandling', () => {
  it('keeps Phonic in charge of turn detection', () => {
    // `realtime_llm` means "the realtime model detects turns", i.e. Phonic's
    // server-side detection. It must never be replaced by a client-side VAD or
    // turn detector, which would fight Phonic's interruption events.
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
    // Phonic already gates interruptions with `minWordsToInterrupt`; a second
    // client-side threshold would only delay the stop.
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
