/**
 * Configuration preflight check.
 *
 *   npm run check:env
 *
 * Prints a masked summary of the configuration and exits non-zero if any
 * required variable is missing. Makes no network calls and costs nothing.
 */
import dotenv from 'dotenv';
import { ConfigError, assertRequiredEnv, safeEnvSummary } from './config.ts';

dotenv.config({ path: '.env', quiet: true });

try {
  assertRequiredEnv();
  console.log('Environment looks complete (values masked):');
  for (const [key, value] of Object.entries(safeEnvSummary())) {
    console.log(`  ${key} = ${value}`);
  }
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`FAIL: ${error.message}`);
  } else {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
