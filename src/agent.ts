/**
 * The conversational agent definition (prompt only — no tools, no database).
 *
 * Opal handles speech-to-speech generation; this file only supplies the
 * instructions that shape how the agent talks. It is provider-independent.
 */
import { voice } from '@livekit/agents';
import { AGENT_INSTRUCTIONS } from './instructions.ts';

/** Build the LiveKit voice agent used for each session. */
export function createAgent(): voice.Agent {
  return new voice.Agent({
    instructions: AGENT_INSTRUCTIONS,
  });
}
