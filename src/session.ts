/**
 * LiveKit `AgentSession` construction and the turn-handling policy the voice
 * agent runs with.
 *
 * This module is provider-independent: Deepslate Opal (via `src/deepslate.ts`)
 * detects turns and interruptions server-side, and LiveKit decides what happens
 * to audio that has already been queued for playback. The policy below pins the
 * parts of that hand-off the agent depends on, so a future change to session
 * options (or to LiveKit's defaults) cannot silently re-enable client-side
 * interruption behaviour that would let an interrupted response keep playing.
 *
 * See README "Interruption" for the full lifecycle and its limits.
 */
import { type llm, voice } from '@livekit/agents';

/** Turn-handling settings this agent always runs with. */
export type TurnHandlingPolicy = {
  /**
   * Opal does its own server-side turn detection and VAD. Naming it explicitly
   * keeps that behaviour (LiveKit resolves `realtime_llm` to "the realtime
   * model detects turns") and stops a stray client-side VAD / turn detector
   * from taking over endpointing, which would make the provider's interruption
   * events and LiveKit's turn boundaries disagree.
   */
  turnDetection: 'realtime_llm';
  interruption: {
    /** Interruptions are always enabled — the user must be able to cut in. */
    enabled: true;
    /**
     * Never pause and later resume the agent's audio around user speech.
     *
     * LiveKit's default (`true`, with a 2 s `falseInterruptionTimeout`) lets a
     * user utterance it treats as a false interruption pause the audio output and
     * then resume it, replaying the buffered remainder of the old response after
     * the user has spoken. That is exactly the stale-audio overlap this agent
     * must not have, so it is turned off: an interruption ends the response for
     * good, and the next response starts from silence.
     *
     * That pause/resume path is driven by LiveKit's client-side interruption
     * detection, which is inactive while the realtime model owns turn
     * detection — so this is a guard rather than a fix for an observed fault.
     * It is pinned anyway so the guarantee cannot be lost by a later change to
     * the VAD or turn-detection settings.
     */
    resumeFalseInterruption: false;
    /**
     * Keep dropping the user's input audio while an uninterruptible response is
     * playing, so the agent does not answer its own voice or a muted caller.
     */
    discardAudioIfUninterruptible: true;
    /**
     * Client-side word/duration thresholds stay at zero: Opal already gates
     * interruptions server-side, and stacking a second threshold here would
     * delay the stop further.
     */
    minWords: 0;
    minDuration: 0;
  };
};

/** The single source of truth for the agent's turn-handling settings. */
export const TURN_HANDLING_POLICY: TurnHandlingPolicy = {
  turnDetection: 'realtime_llm',
  interruption: {
    enabled: true,
    resumeFalseInterruption: false,
    discardAudioIfUninterruptible: true,
    minWords: 0,
    minDuration: 0,
  },
};

/**
 * Build the `turnHandling` option object for `AgentSession`.
 *
 * Returns a fresh copy each call so callers cannot mutate the shared policy.
 */
export function resolveTurnHandling(): {
  turnDetection: 'realtime_llm';
  interruption: TurnHandlingPolicy['interruption'];
} {
  return {
    turnDetection: TURN_HANDLING_POLICY.turnDetection,
    interruption: { ...TURN_HANDLING_POLICY.interruption },
  };
}

/**
 * Create the `AgentSession` for a realtime speech-to-speech model.
 *
 * The realtime model stays the only model in the session — no STT/LLM/TTS
 * pipeline and no extra VAD — so Opal handles understanding, generation and
 * turn taking end to end.
 */
export function createAgentSession(llm: llm.RealtimeModel): voice.AgentSession {
  return new voice.AgentSession({
    llm,
    turnHandling: resolveTurnHandling(),
  });
}

/** One-line, non-secret summary of the policy, for startup logs. */
export function describeTurnHandling(): string {
  const { turnDetection, interruption } = TURN_HANDLING_POLICY;
  return (
    `turnDetection=${turnDetection} ` +
    `interruption.enabled=${interruption.enabled} ` +
    `resumeFalseInterruption=${interruption.resumeFalseInterruption} ` +
    `minWords=${interruption.minWords} minDuration=${interruption.minDuration}`
  );
}
