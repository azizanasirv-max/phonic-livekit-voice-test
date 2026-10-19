/**
 * Interruption-lifecycle regression tests for the LiveKit realtime integration.
 *
 * These run the **real** `AgentSession`, realtime-generation and audio-playback
 * machinery from the installed `@livekit/agents`, with only the provider replaced by
 * `FakeRealtimeModel` (see `fake-realtime-model.ts`). No network calls,
 * no provider credentials, no audio devices.
 *
 * What each test pins down:
 *
 * 1. a short (one-word) user utterance stops the assistant;
 * 2. an interruption during an in-flight generation cancels the generation and
 *    releases the audio stream;
 * 3. audio from a cancelled response is never scheduled after the cancellation;
 * 4. a new response starts normally after the interruption;
 * 5. repeated interruptions leave no duplicated or overlapping responses;
 * 6. the session recovers after the provider disconnects and after a clean close;
 * 7. the turn-handling policy keeps the provider's server-side turn detection and
 *    never resumes an interrupted response.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initializeLogger, voice } from '@livekit/agents';

import { createAgent } from '../src/agent.ts';
import { createAgentSession, resolveTurnHandling } from '../src/session.ts';
import { FakeRealtimeModel, RecordingAudioOutput } from './fake-realtime-model.ts';
import type { FakeRealtimeSession } from './fake-realtime-model.ts';

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
  model: FakeRealtimeModel;
  rt: FakeRealtimeSession;
  session: voice.AgentSession;
  output: RecordingAudioOutput;
  speeches: voice.SpeechHandle[];
  agentStates: voice.AgentState[];
  errors: unknown[];
};

/** Start a session over the fake the provider model, wired exactly like production. */
async function startHarness(): Promise<Harness> {
  const model = new FakeRealtimeModel();
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
    rt: undefined as unknown as FakeRealtimeSession,
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
  it('stops the assistant when the provider reports a short (one-word) utterance', async () => {
    const h = await startHarness();

    const speech = h.session.generateReply();
    await settle();
    h.rt.pushAssistantAudio('This is a normal length reply from the agent.');
    await settle();
    assert.ok(h.output.framesCaptured > 0, 'the response should be playing');

    // The provider's server-side VAD hears one word and reports `user_started_speaking`.
    // With `minWordsToInterrupt: 1` that is already an interruption.
    h.rt.userStartedSpeaking();
    await settle();

    assert.equal(speech.interrupted, true, 'the active response must be interrupted');
    assert.equal(h.rt.turnsInterrupted, 1);
    assert.ok(h.output.clears >= 1, 'queued audio must be dropped from the playback path');
    assert.equal(h.rt.turnOpen, false, 'no provider turn may be left open');

    await h.session.close();
  });

  it('interrupts a response that is still being generated', async () => {
    const h = await startHarness();

    const speech = h.session.generateReply();
    await settle();
    h.rt.pushAssistantAudio('A long reply that is still');
    await settle();

    // The generation is still open: the provider has not finished speaking.
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

  it('never schedules audio from a cancelled response after the interruption', async () => {
    const h = await startHarness();

    const speech = h.session.generateReply();
    await settle();
    h.rt.pushAssistantAudio('first');
    await settle();
    const framesBefore = h.output.framesCaptured;
    assert.equal(framesBefore, 1);

    // the provider streams ahead of real time, so at the moment the interruption lands
    // several more chunks of the *same* response are already buffered in the
    // generation's audio stream. This models the worst case — the provider
    // reports user speech but keeps its generation open — so those frames stay
    // readable and LiveKit has to stop them itself.
    for (let i = 0; i < 5; i += 1) {
      assert.equal(h.rt.pushAssistantAudio(`stale-${i}`), true);
    }
    h.rt.userStartedSpeakingKeepingTurnOpen();
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
      'LiveKit must cancel the generation audio stream, not drain it',
    );

    // Even after that, nothing more from this response may be scheduled: the
    // generation's stream was cancelled, so the provider cannot write to it.
    assert.equal(h.rt.pushAssistantAudio('still stale'), false);
    await settle();
    assert.equal(h.output.framesCaptured, framesBefore);

    await h.session.close();
  });

  it('drops chunks that arrive after the interrupted generation is closed', async () => {
    const h = await startHarness();

    const speech = h.session.generateReply();
    await settle();
    h.rt.pushAssistantAudio('first');
    await settle();
    const framesBefore = h.output.framesCaptured;

    // The plugin's normal path: `user_started_speaking` emits
    // `input_speech_started` and then closes the generation.
    h.rt.userStartedSpeaking();
    await settle();
    assert.equal(speech.interrupted, true);
    assert.equal(h.rt.turnOpen, false);

    // A chunk that arrives after the close is dropped by the plugin, and it must
    // not resurrect the response as a new generation.
    assert.equal(h.rt.pushAssistantAudio('late'), false);
    await settle();
    assert.equal(h.output.framesCaptured, framesBefore);
    assert.equal(h.rt.turnsOpened, 1, 'a late chunk must not open a new response');
    assert.ok(h.rt.framesDropped >= 1);

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

    // The user finishes their turn and the provider starts the next response.
    h.rt.userFinishedSpeaking();
    const nextTurn = h.rt.assistantTurnFromProvider();
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

  it('survives repeated interruptions without duplicated or overlapping responses', async () => {
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

      // A burst of the response is still buffered when the user cuts in.
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

  it('recovers after the provider disconnects mid-response', async () => {
    const h = await startHarness();

    const speech = h.session.generateReply();
    await settle();
    h.rt.pushAssistantAudio('a reply that will be cut off by a disconnect');
    await settle();
    const framesBeforeDrop = h.output.framesCaptured;

    // Mirrors the plugin's socket `close` handler: drop the open generation and
    // report the abnormal close.
    h.rt.simulateProviderDisconnect(1006);
    await settle();

    assert.equal(h.rt.turnOpen, false, 'the in-flight generation must be dropped');
    assert.equal(speech.interrupted, true);
    assert.ok(h.errors.length >= 1, 'the disconnect must be surfaced to the session');

    // The plugin reports an abnormal socket close as *unrecoverable*, so LiveKit
    // tears the session down instead of carrying on over a dead socket.
    assert.throws(() => h.session.generateReply(), /not running/);

    // Whatever the provider still had buffered must not be scheduled.
    assert.equal(h.rt.pushAssistantAudio('audio from the dead socket'), false);
    await settle();
    assert.equal(
      h.output.framesCaptured,
      framesBeforeDrop,
      'nothing from the dropped connection may be scheduled',
    );

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
    assert.equal(h.rt.turnOpen, false, 'no generation may survive the close');

    assert.equal(h.rt.pushAssistantAudio('after close'), false);
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

  it('pins the provider server-side turn detection and never resumes an interrupted response', () => {
    const model = new FakeRealtimeModel();
    const session = createAgentSession(model);
    const { turnDetection, interruption } = session.sessionOptions.turnHandling;

    // the provider's own turn detection stays in charge.
    assert.equal(turnDetection, 'realtime_llm');
    assert.equal(model.capabilities.turnDetection, true);
    assert.notEqual(model.capabilities.supportsOverlappingSpeech, true);

    // Interruptions are on, and an interrupted response is never resumed.
    assert.equal(interruption.enabled, true);
    assert.equal(interruption.resumeFalseInterruption, false);
    assert.equal(interruption.discardAudioIfUninterruptible, true);
    // No second client-side threshold on top of the provider-side interruption gate.
    assert.equal(interruption.minWords, 0);
    assert.equal(interruption.minDuration, 0);

    // The policy is copied out, not shared, so callers cannot mutate it.
    const first = resolveTurnHandling();
    const second = resolveTurnHandling();
    assert.ok(first !== second, 'each call must return a fresh object');
    assert.ok(first.interruption !== second.interruption, 'nested options must be copied too');
  });
});
