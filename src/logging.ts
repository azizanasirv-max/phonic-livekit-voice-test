/**
 * Small logging helpers.
 *
 * Deliberately dependency-free: the LiveKit agent server already logs its own
 * connection/runtime messages, and everything written here is passed through
 * {@link redactSecrets} first so credentials never reach the terminal.
 */
import { redactSecrets } from './config.ts';

export type LogFields = Record<string, unknown>;

function emit(level: 'info' | 'warn' | 'error', message: string, fields?: LogFields): void {
  const parts = [`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`];
  if (fields !== undefined) {
    const rendered = Object.entries(fields)
      .map(([key, value]) => `${key}=${redactSecrets(String(value))}`)
      .join(' ');
    if (rendered !== '') parts.push(rendered);
  }
  const line = parts.join(' ');
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Turn any thrown value into a redacted, single-line description. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(`${error.name}: ${error.message}`);
  }
  return redactSecrets(String(error));
}

export function logInfo(message: string, fields?: LogFields): void {
  emit('info', message, fields);
}

export function logWarn(message: string, fields?: LogFields): void {
  emit('warn', message, fields);
}

/** Log a runtime error with context; the error text is redacted. */
export function logError(message: string, error: unknown, fields?: LogFields): void {
  emit('error', message, { ...fields, error: describeError(error) });
}
