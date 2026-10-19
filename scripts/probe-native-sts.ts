/**
 * Live capability probe: does Deepslate emit native Opal model audio when no
 * TTS backend is configured?
 *
 * This uses the real Deepslate Realtime client (`@deepslate-labs/core`) with
 * `ttsConfig` deliberately omitted. It sends one text prompt and counts what
 * the server actually returns:
 *
 *   audio chunks > 0  -> the server exposed model audio on this session;
 *   audio chunks = 0  -> the server is text-only for this configuration.
 *
 * It does not configure ElevenLabs or a Deepslate-hosted voice, and it never
 * prints a credential. It is a diagnostic, not a production agent.
 *
 * Usage:
 *   DEEPSLATE_VENDOR_ID=... DEEPSLATE_ORGANIZATION_ID=... DEEPSLATE_API_KEY=... \
 *     npm run probe:native-sts
 *
 * Exit codes: 0 = model audio observed, 2 = text-only / unsupported,
 *             1 = missing configuration or connection failure.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

import {
  DeepslateSession,
  TriggerMode,
  optionsFromEnv,
} from '@deepslate-labs/core';

import {
  describeNativeStsObservation,
  NativeStsProbe,
} from '../src/native-sts.ts';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const REQUIRED = [
  'DEEPSLATE_VENDOR_ID',
  'DEEPSLATE_ORGANIZATION_ID',
  'DEEPSLATE_API_KEY',
] as const;

const missing = REQUIRED.filter((name) => (process.env[name] ?? '').trim() === '');
if (missing.length > 0) {
  console.error(
    `Missing required Deepslate configuration: ${missing.join(', ')}. ` +
      'Set these environment variables (or a local .env) before running the probe.',
  );
  process.exit(1);
}

const probe = new NativeStsProbe();
const session = DeepslateSession.create(optionsFromEnv(), { vadConfig: {} });

let fatalError: Error | undefined;
session.on('audioChunk', (pcm, sampleRate, channels) => {
  probe.recordAudio(pcm, sampleRate, channels);
});
session.on('textFragment', (text) => {
  probe.recordText(text);
});
session.on('responseBegin', () => {
  probe.beginResponse();
});
session.on('responseEnd', () => {
  probe.endResponse();
});
session.on('fatalError', (error) => {
  fatalError = error;
  probe.recordFatal(error);
});

const ready = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error('Timed out waiting for Deepslate sessionReady (20s).'));
  }, 20_000);
  session.once('sessionInitialized', () => {
    clearTimeout(timer);
    resolve();
  });
  session.once('fatalError', (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

const responseEnded = new Promise<void>((resolve) => {
  session.once('responseEnd', () => resolve());
});

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

try {
  console.log('Opening a Deepslate session with NO tts_configuration...');
  session.start();
  await session.initialize(24_000, 1);
  await ready;
  console.log('Session ready. Sending one text prompt to trigger inference...');

  await session.sendText(
    'Say exactly this short sentence: native speech output check.',
    TriggerMode.IMMEDIATE,
  );

  await Promise.race([
    responseEnded,
    delay(30_000).then(() => {
      throw new Error('Timed out waiting for Deepslate responseEnd (30s).');
    }),
  ]);

  // Give any audio that was queued just before responseEnd a moment to arrive.
  await delay(1_000);

  if (fatalError !== undefined) {
    throw fatalError;
  }

  const observation = probe.assertNativeAudio();
  console.log('NATIVE MODEL AUDIO OBSERVED');
  console.log(describeNativeStsObservation(observation));
  process.exitCode = 0;
} catch (error) {
  const observation = probe.observation;
  console.error(
    `No usable native model audio: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error(describeNativeStsObservation(observation));
  process.exitCode = 2;
} finally {
  await session.close().catch(() => undefined);
}
