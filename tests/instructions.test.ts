/**
 * Unit tests for the agent prompt. No LiveKit imports, no network, no cost.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_INSTRUCTIONS, GREETING_INSTRUCTIONS } from '../src/instructions.ts';

describe('agent instructions', () => {
  it('are concise enough for a realtime model', () => {
    assert.ok(AGENT_INSTRUCTIONS.length > 100, 'instructions should not be empty');
    assert.ok(
      AGENT_INSTRUCTIONS.length < 1500,
      `instructions should stay short, got ${AGENT_INSTRUCTIONS.length} characters`,
    );
  });

  it('tell the agent to yield when the user interrupts', () => {
    assert.match(AGENT_INSTRUCTIONS, /interrupt/i);
    assert.match(AGENT_INSTRUCTIONS, /stop immediately/i);
  });

  it('tell the agent not to treat short acknowledgements as new questions', () => {
    assert.match(AGENT_INSTRUCTIONS, /backchannel/i);
    assert.match(AGENT_INSTRUCTIONS, /acknowledgement/i);
    assert.match(AGENT_INSTRUCTIONS, /hmm/i);
  });

  it('keep spoken replies short and free of formatting', () => {
    assert.match(AGENT_INSTRUCTIONS, /one or two short sentences/i);
    assert.match(AGENT_INSTRUCTIONS, /markdown/i);
  });
});

describe('greeting instructions', () => {
  it('ask for a short friendly opening', () => {
    assert.ok(GREETING_INSTRUCTIONS.length > 0);
    assert.match(GREETING_INSTRUCTIONS, /greet/i);
    assert.match(GREETING_INSTRUCTIONS, /one short sentence/i);
  });
});
