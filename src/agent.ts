/**
 * The conversational agent definition (prompt only — no tools, no database).
 *
 * Deepslate Opal handles speech generation; this file only supplies the
 * instructions that shape how the agent talks.
 */
import { voice } from '@livekit/agents';
import { AGENT_INSTRUCTIONS } from './instructions.ts';

/** Build the LiveKit voice agent used for each session. */
export function createAgent(): voice.Agent {
  return new voice.Agent({
    instructions: AGENT_INSTRUCTIONS,
  });
}
