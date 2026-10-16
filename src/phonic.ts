/**
 * Phonic realtime-model wiring, isolated so it can be unit tested without
 * connecting to anything.
 *
 * Only options documented in the official plugin guide/README are used:
 * https://docs.livekit.io/agents/models/realtime/plugins/phonic/
 */
import * as phonic from '@livekit/agents-plugin-phonic';
import { readEnv, readIntEnv, type EnvLike } from './config.ts';

/** Voice used when PHONIC_VOICE is unset (a documented Phonic voice id). */
export const DEFAULT_VOICE = 'sabrina';

/**
 * Minimum user words needed to interrupt the agent.
 * 2 means a single word like "uh" or "hmm" will not cut the agent off.
 */
export const DEFAULT_MIN_WORDS_TO_INTERRUPT = 2;

/** Resolved, non-secret Phonic options. */
export type PhonicOptions = {
  voice: string;
  minWordsToInterrupt: number;
  isWelcomeMessageInterruptible: boolean;
};

/** Resolve Phonic options from the environment, applying documented defaults. */
export function resolvePhonicOptions(env: EnvLike = process.env): PhonicOptions {
  return {
    voice: readEnv('PHONIC_VOICE', env) ?? DEFAULT_VOICE,
    minWordsToInterrupt: readIntEnv(
      'PHONIC_MIN_WORDS_TO_INTERRUPT',
      DEFAULT_MIN_WORDS_TO_INTERRUPT,
      env,
    ),
    // Let the user talk over the opening greeting.
    isWelcomeMessageInterruptible: true,
  };
}

/**
 * Create the Phonic speech-to-speech model for an `AgentSession`.
 *
 * The API key is read from `PHONIC_API_KEY` by the plugin itself (never logged
 * here). The plugin throws immediately if no key is configured.
 */
export function createRealtimeModel(
  env: EnvLike = process.env,
  onConversationCreated?: (conversationId: string) => void,
): phonic.realtime.RealtimeModel {
  return new phonic.realtime.RealtimeModel({
    ...resolvePhonicOptions(env),
    onConversationCreated,
  });
}
