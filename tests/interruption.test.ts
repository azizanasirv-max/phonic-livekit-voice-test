/**
 * Interruption-lifecycle regression tests for the Deepslate Opal ↔ LiveKit
 * integration.
 *
 * These run the **real** `AgentSession`, realtime-generation and audio-playback
 * machinery from the installed `@livekit/agents`, with only Deepslate replaced
 * by `FakeDeepslateRealtimeModel` (see `fake-deepslate-realtime.ts`). No network
 * calls, no Deepslate credentials, no audio devices.
 *
 * What each test pins down:
 *
 * 1. a short user utterance stops the assistant;
 * 2. an interruption during an in-flight response cancels it and releases the
 *    audio stream, so buffered frames are never scheduled;
 * 3. late audio from the interrupted response is *not* filtered by the plugin
 *    (it reopens a generation) — an honest limit that depends on Deepslate
 *    stopping the stream server-side;
 * 4. a new response starts normally after the interruption;
 * 5. repeated interruptions leave no overlapping responses;
 * 6. an uninterruptable direct-speech utterance keeps playing;
 * 7. a non-recoverable provider error closes the session and a fresh session
 *    works;
 * 8. the turn-handling policy keeps Deepslate's server-side turn detection and
 *    never resumes an interrupted response.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initializeLogger, voice } from '@livekit/agents';

import { createAgent } from '../src/agent.ts';
import { createAgentSession, resolveTurnHandling } from '../src/session.ts';
import { FakeDeepslateRealtimeModel, RecordingAudioOutput } from './fake-deepslate-realtime.ts';
import type { FakeDeepslateRealtimeSession } from './fake-deepslate-realtime.ts';

// The SDK requires its logger to be initialized before a session is created.
initializeLogger({ pretty: false, level: 'silent' });

/** Let queued tasks, stream reads and state transitions run to completion. */
async function settle(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

type Harness = {
  model: FakeDeepslateRealtimeModel;
  rt: FakeDeepslateRealtimeSession;
  session: voice.AgentSession;
  output: RecordingAudioOutput;
  speeches: voice.SpeechHandle[];
  agentStates: voice.AgentState[];
  errors: unknown[];
};

/** Start a session over the fake Deepslate model, wired like production. */
async function startHarness(): Promise<Harness> {
  const model = new FakeDeepslateRealtimeModel();
  const session = createAgentSession(model);
  const output = new RecordingAudioOutput();
  session.output.audio = output;

  const harness = {
    model,
    session,
    output,
    speeches: [] as voice.SpeechHandle[],
    agentStates: [] as voice.AgentState[],
    errors: [] as unknown[],
    rt: undefined as unknown as FakeDeepslateRealtimeSession,
  };

  session.on(voice.AgentSessionEventTypes.SpeechCreated, (event) => {
    harness.speeches.push(event.speechHandle);
  });
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
    harness.agentStates.push(event.newState);
  });
  session.on(voice.AgentSessionEventTypes.Error, (event) => {
    harness.errors.push(event.error);
  });

  await session.start({ agent: createAgent() });
  harness.rt = model.activeSession!;
  return harness;
}

describe('interruption lifecycle', () => {
  it('stops the assistant when Deepslate reports user speech', async () => {
    const h = await startHarness();

    const speech = h.session.generateReply();
    await settle();
    h.rt.pushAssistantAudio('This is a normal length reply from the agent.');
    await settle();
    assert.ok(h.output.framesCaptured > 0, 'the response should be playing');

    // Deepslate's server-side VAD reports the caller speaking.
    h.rt.userStartedSpeaking();
    await settle();

    assert.equal(speech.interrupted, true, 'the active response must be interrupted');
    assert.equal(h.rt.turnsInterrupted, 1);
    assert.ok(h.output.clears >= 1, 'queued audio must be dropped from the playback path');
    assert.equal(h.rt.turnOpen, false, 'no Deepslate response may be left open');

    await h.session.close();
  });

  it('interrupts a response that is still being generated', async () => {
    const h = await startHarness();

    const speech = h.session.generateReply();
    await settle();
    h.rt.pushAssistantAudio('A long reply that is still');
    await settle();

    assert.equal(h.rt.turnOpen, true);
    const framesBefore = h.output.framesCaptured;

    h.rt.userStartedSpeaking();
    await settle();

    assert.equal(speech.interrupted, true);
    assert.equal(h.rt.turnOpen, false);
    assert.ok(h.output.clears >= 1);
    assert.ok(
      h.agentStates.includes('listening'),
      `the agent should go back to listening, saw: ${h.agentStates.join(', ')}`,
    );
    assert.equal(h.output.framesCaptured, framesBefore);

    await h.session.close();
  });

  it('never schedules buffered frames after the interruption', async () => {
    const h = await startHarness();

    const speech = h.session.generateReply();
    await settle();
    h.rt.pushAssistantAudio('first');
    await settle();
    const framesBefore = h.output.framesCaptured;
    assert.equal(framesBefore, 1);

    // Audio chunks Deepslate already generated are buffered in the response's
    // audio stream when the interruption lands.
    for (let i = 0; i < 5; i += 1) {
      assert.equal(h.rt.pushAssistantAudio(`stale-${i}`), true);
    }
    h.rt.userStartedSpeaking();
    await settle();

    assert.equal(speech.interrupted, true);
    assert.equal(
      h.output.framesCaptured,
      framesBefore,
      'buffered frames from the cancelled response must not be scheduled',
    );
    assert.ok(h.output.clears >= 1, 'the playback queue must be flushed');
    assert.equal(
      h.rt.audioStreamCancelled,
      true,
      'LiveKit must cancel the response audio stream, not drain it',
    );

    await h.session.close();
  });

  it('documents the plugin limit: late server audio reopens a response', async () => {
    const h = await startHarness();

    const speech = h.session.generateReply();
    await settle();
    h.rt.pushAssistantAudio('first');
    await settle();
    h.rt.userStartedSpeaking();
    await settle();
    assert.equal(speech.interrupted, true);
    assert.equal(h.rt.turnsOpened, 1);

    // @deepslate-labs/livekit@0.1.23 does not drop audioChunks that arrive after
    // a playbackBufferClear: audioChunk calls ensureGeneration(), which opens a
    // new response. Preventing this depends on Deepslate stopping generation
    // server-side, not on LiveKit or this agent. The test records the behaviour
    // so the limitation is visible rather than assumed away.
    const framesAfterInterrupt = h.output.framesCaptured;
    assert.equal(h.rt.pushAssistantAudio('late chunk from the same response'), true);
    await settle();

    assert.equal(h.rt.turnsOpened, 2, 'the plugin opens a new response for late audio');
    assert.ok(
      h.output.framesCaptured > framesAfterInterrupt,
      'late audio is scheduled by LiveKit — it cannot be recalled locally',
    );

    await h.session.close();
  });

  it('starts a new response after the interruption', async () => {
    const h = await startHarness();

    const first = h.session.generateReply();
    await settle();
    h.rt.pushAssistantAudio('the first reply');
    await settle();
    h.rt.userStartedSpeaking();
    await settle();
    assert.equal(first.interrupted, true);
    const framesAfterInterrupt = h.output.framesCaptured;

    // The user finishes their turn and Deepslate starts the next response.
    h.rt.userFinishedSpeaking();
    const nextTurn = h.rt.assistantTurnFromServer();
    assert.equal(nextTurn.userInitiated, false);
    await settle();
    assert.equal(h.rt.pushAssistantAudio('the second reply'), true);
    await settle();

    assert.ok(
      h.output.framesCaptured > framesAfterInterrupt,
      'audio for the new response must be scheduled',
    );
    assert.equal(h.speeches.length, 2, 'exactly one new speech handle');
    const newest = h.speeches.at(-1)!;
    assert.equal(newest.interrupted, false, 'the new response must not be interrupted');
    assert.equal(newest.done(), false);
    assert.equal(h.rt.turnOpen, true);

    await h.session.close();
  });

  it('survives repeated interruptions without overlapping responses', async () => {
    const h = await startHarness();
    let expectedFrames = 0;

    for (let round = 0; round < 3; round += 1) {
      const speech = h.session.generateReply();
      await settle();
      assert.equal(h.rt.pushAssistantAudio(`round ${round}`), true);
      await settle();
      expectedFrames += 1;

      assert.equal(
        h.output.framesCaptured,
        expectedFrames,
        `round ${round}: only the current response may be scheduled`,
      );
      assert.equal(
        h.speeches.filter((s) => !s.interrupted && !s.done()).length,
        1,
        `round ${round}: exactly one response may be live`,
      );

      for (let i = 0; i < 4; i += 1) {
        assert.equal(h.rt.pushAssistantAudio(`round ${round} stale ${i}`), true);
      }
      h.rt.userStartedSpeaking();
      await settle();

      assert.equal(speech.interrupted, true, `round ${round}: response must be interrupted`);
      assert.equal(
        h.output.framesCaptured,
        expectedFrames,
        `round ${round}: no stale audio may be scheduled`,
      );
      assert.equal(
        h.speeches.filter((s) => !s.interrupted && !s.done()).length,
        0,
        `round ${round}: nothing may be left playing`,
      );
    }

    assert.equal(h.rt.turnsOpened, 3, 'one response per round, no duplicates');
    assert.equal(h.rt.turnsInterrupted, 3);
    assert.equal(h.rt.turnOpen, false);
    assert.equal(h.output.framesCaptured, expectedFrames);

    await h.session.close();
  });

  it('lets an uninterruptable direct-speech utterance finish', async () => {
    const h = await startHarness();

    // Mirrors speakDirect(text, includeInHistory, uninterruptable=true).
    await h.rt.speakDirectUninterruptable('This notice must play to the end.');
    await settle();
    const framesBefore = h.output.framesCaptured;
    assert.ok(framesBefore > 0);

    h.rt.userStartedSpeaking();
    await settle();

    assert.equal(h.rt.turnOpen, true, 'the notice must keep playing');
    assert.equal(h.output.clears, 0, 'nothing may be flushed while it is uninterruptable');
    assert.equal(h.output.framesCaptured, framesBefore);

    await h.session.close();
  });

  it('closes the session on an unrecoverable provider error and recovers fresh', async () => {
    const h = await startHarness();

    h.session.generateReply();
    await settle();
    h.rt.pushAssistantAudio('a reply that will be cut off');
    await settle();
    const framesBeforeDrop = h.output.framesCaptured;

    // The plugin emits provider errors with recoverable: false.
    h.rt.simulateProviderError('Deepslate WS closed unexpectedly');
    await settle(20);

    assert.equal(h.errors.length, 1, 'the provider error must be surfaced');
    assert.throws(() => h.session.generateReply(), /not running/);

    // Whatever the provider had buffered must not be scheduled by this session.
    await settle();
    assert.equal(h.output.framesCaptured, framesBeforeDrop);

    // The next job starts a fresh session on the same code path and speaks.
    const fresh = await startHarness();
    const freshSpeech = fresh.session.generateReply();
    await settle();
    assert.equal(fresh.rt.pushAssistantAudio('back on the line'), true);
    await settle();

    assert.ok(fresh.output.framesCaptured > 0, 'the agent must speak again');
    assert.equal(freshSpeech.interrupted, false);
    assert.equal(fresh.errors.length, 0);

    await fresh.session.close();
  });

  it('stops scheduling audio after the session is closed', async () => {
    const h = await startHarness();

    h.session.generateReply();
    await settle();
    h.rt.pushAssistantAudio('hello');
    await settle();
    const framesBeforeClose = h.output.framesCaptured;
    assert.ok(framesBeforeClose > 0);

    await h.session.close();
    await settle();

    assert.equal(h.rt.closed, true, 'the model session must be closed');
    assert.equal(h.rt.turnOpen, false, 'no response may survive the close');

    await settle();
    assert.equal(h.output.framesCaptured, framesBeforeClose);

    // A brand-new session over the same code path works normally.
    const fresh = await startHarness();
    const freshSpeech = fresh.session.generateReply();
    await settle();
    assert.equal(fresh.rt.pushAssistantAudio('new session'), true);
    await settle();

    assert.ok(fresh.output.framesCaptured > 0, 'a new session must speak normally');
    assert.equal(freshSpeech.interrupted, false);
    assert.equal(fresh.errors.length, 0);

    await fresh.session.close();
  });

  it('pins Deepslate server-side turn detection and never resumes an interrupted response', () => {
    const model = new FakeDeepslateRealtimeModel();
    const session = createAgentSession(model);
    const { turnDetection, interruption } = session.sessionOptions.turnHandling;

    // Deepslate's own VAD stays in charge of turns.
    assert.equal(turnDetection, 'realtime_llm');
    assert.equal(model.capabilities.turnDetection, true);

    // Interruptions are on, and an interrupted response is never resumed.
    assert.equal(interruption.enabled, true);
    assert.equal(interruption.resumeFalseInterruption, false);
    assert.equal(interruption.discardAudioIfUninterruptible, true);
    // No second client-side threshold on top of Deepslate's server-side VAD.
    assert.equal(interruption.minWords, 0);
    assert.equal(interruption.minDuration, 0);

    // The policy is copied out, not shared, so callers cannot mutate it.
    const first = resolveTurnHandling();
    const second = resolveTurnHandling();
    assert.ok(first !== second, 'each call must return a fresh object');
    assert.ok(first.interruption !== second.interruption, 'nested options must be copied too');
  });
});
