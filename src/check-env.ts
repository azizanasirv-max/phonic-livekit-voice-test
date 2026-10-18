/**
 * Configuration preflight check.
 *
 *   npm run check:env
 *
 * Prints a masked summary of the configuration and exits non-zero if any
 * required variable is missing or LIVEKIT_URL is malformed. Makes no network
 * calls and costs nothing.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  assertRequiredEnv,
  readEnv,
  safeEnvSummary,
  validateLivekitUrl,
} from './config.ts';
import { describeTtsConfig, resolveTtsConfig } from './deepslate.ts';

// Resolve .env next to the project root, not relative to the current working
// directory, so the check works no matter where it is invoked from.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

try {
  assertRequiredEnv();
  console.log('Environment looks complete (values masked):');
  for (const [key, value] of Object.entries(safeEnvSummary())) {
    console.log(`  ${key} = ${value}`);
  }

  // Opal only produces audio when a TTS backend is configured. Report this
  // here rather than letting a silent session fail during the manual test.
  try {
    console.log(`Audio output (TTS): ${describeTtsConfig(resolveTtsConfig())}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }

  const urlCheck = validateLivekitUrl(readEnv('LIVEKIT_URL'));
  console.log('');
  console.log(
    `LIVEKIT_URL check: scheme=${urlCheck.scheme ?? '(none)'} host=${urlCheck.host ?? '(none)'}`,
  );
  for (const warning of urlCheck.warnings) console.warn(`WARN: ${warning}`);
  for (const problem of urlCheck.problems) console.error(`FAIL: ${problem}`);
  if (!urlCheck.ok) process.exitCode = 1;
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`FAIL: ${error.message}`);
  } else {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
