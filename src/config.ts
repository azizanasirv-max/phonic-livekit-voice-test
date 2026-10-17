/**
 * Environment-variable handling for the Phonic + LiveKit voice prototype.
 *
 * All `process.env` access goes through this module so that:
 *  - required variables are validated in one place with friendly messages, and
 *  - credentials can be redacted before anything is written to a log.
 */

/** Variables the agent needs before it can start a voice session. */
export const REQUIRED_ENV_VARS = [
  'PHONIC_API_KEY',
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
] as const;

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/** Variables whose values are secrets and must never be logged verbatim. */
export const SECRET_ENV_VARS = [
  'PHONIC_API_KEY',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
] as const;

export type EnvLike = Record<string, string | undefined>;

/** Thrown when required configuration is missing or malformed. */
export class ConfigError extends Error {
  readonly missing: RequiredEnvVar[];

  constructor(message: string, missing: RequiredEnvVar[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

/** Read a variable, treating empty/whitespace-only values as unset. */
export function readEnv(name: string, env: EnvLike = process.env): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Names of required variables that are missing or blank. */
export function getMissingEnvVars(
  env: EnvLike = process.env,
  vars: readonly RequiredEnvVar[] = REQUIRED_ENV_VARS,
): RequiredEnvVar[] {
  return vars.filter((name) => readEnv(name, env) === undefined);
}

/**
 * Throw a {@link ConfigError} listing every missing required variable.
 * Values are never included in the message.
 */
export function assertRequiredEnv(
  env: EnvLike = process.env,
  vars: readonly RequiredEnvVar[] = REQUIRED_ENV_VARS,
): void {
  const missing = getMissingEnvVars(env, vars);
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill in the values (see README.md).',
      missing,
    );
  }
}

/** Render a credential so you can confirm it is set without revealing it. */
export function maskSecret(value?: string): string {
  if (value === undefined || value.trim() === '') return '(not set)';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Masked view of the environment, safe to log at startup. */
export function safeEnvSummary(env: EnvLike = process.env): Record<string, string> {
  return {
    PHONIC_API_KEY: maskSecret(readEnv('PHONIC_API_KEY', env)),
    LIVEKIT_URL: readEnv('LIVEKIT_URL', env) ?? '(not set)',
    LIVEKIT_API_KEY: maskSecret(readEnv('LIVEKIT_API_KEY', env)),
    LIVEKIT_API_SECRET: maskSecret(readEnv('LIVEKIT_API_SECRET', env)),
    PHONIC_VOICE: readEnv('PHONIC_VOICE', env) ?? '(not set)',
    PHONIC_MIN_WORDS_TO_INTERRUPT: readEnv('PHONIC_MIN_WORDS_TO_INTERRUPT', env) ?? '(not set)',
    LIVEKIT_AGENT_NAME: readEnv('LIVEKIT_AGENT_NAME', env) ?? '(not set)',
    DIAG_TURN_TIMELINE: readEnv('DIAG_TURN_TIMELINE', env) ?? '(not set)',
    DIAG_RTC_STATS: readEnv('DIAG_RTC_STATS', env) ?? '(not set)',
    DIAG_RTC_INTERVAL_MS: readEnv('DIAG_RTC_INTERVAL_MS', env) ?? '(not set)',
  };
}

/** Every configured secret value, longest first (so overlaps redact cleanly). */
export function secretValues(env: EnvLike = process.env): string[] {
  return SECRET_ENV_VARS.map((name) => readEnv(name, env))
    .filter((value): value is string => value !== undefined)
    .sort((a, b) => b.length - a.length);
}

/**
 * Replace any configured credential appearing in `text` with its masked form.
 * Used for anything that may end up in a log or a crash report.
 */
export function redactSecrets(text: string, env: EnvLike = process.env): string {
  let result = text;
  for (const secret of secretValues(env)) {
    result = result.split(secret).join(maskSecret(secret));
  }
  return result;
}

/** Parse an integer env override, falling back to `fallback` when unset/invalid. */
export function readIntEnv(
  name: string,
  fallback: number,
  env: EnvLike = process.env,
): number {
  const raw = readEnv(name, env);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Values that read as "on" / "off" for boolean env flags. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * Parse a boolean env flag, falling back to `fallback` when unset/unrecognized.
 * Diagnostics are disabled by default; only an explicit truthy value enables them.
 */
export function readBoolEnv(
  name: string,
  fallback = false,
  env: EnvLike = process.env,
): boolean {
  const raw = readEnv(name, env);
  if (raw === undefined) return fallback;
  const normalized = raw.toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return fallback;
}

/** Resolved diagnostics configuration (Stage 0). Never contains credentials. */
export type DiagnosticsOptions = {
  /** Record the per-turn event timeline. Off by default. */
  timeline: boolean;
  /** Sample `room.getRtcStats()`. Off by default. */
  rtcStats: boolean;
  /** RTC sampling interval in milliseconds (clamped). */
  rtcIntervalMs: number;
};

/** Minimum accepted `DIAG_RTC_INTERVAL_MS` (avoids hammering the FFI/stats path). */
export const MIN_RTC_INTERVAL_MS = 1000;
/** Maximum accepted `DIAG_RTC_INTERVAL_MS`. */
export const MAX_RTC_INTERVAL_MS = 60000;
/** Default `DIAG_RTC_INTERVAL_MS`. */
export const DEFAULT_RTC_INTERVAL_MS = 5000;

/**
 * Resolve the Stage 0 diagnostics flags. Everything is opt-in: with none of the
 * `DIAG_*` variables set, diagnostics are fully disabled and the agent behaves
 * exactly as before.
 */
export function resolveDiagnosticsOptions(env: EnvLike = process.env): DiagnosticsOptions {
  const requested = readIntEnv('DIAG_RTC_INTERVAL_MS', DEFAULT_RTC_INTERVAL_MS, env);
  const rtcIntervalMs = Math.min(MAX_RTC_INTERVAL_MS, Math.max(MIN_RTC_INTERVAL_MS, requested));
  return {
    timeline: readBoolEnv('DIAG_TURN_TIMELINE', false, env),
    rtcStats: readBoolEnv('DIAG_RTC_STATS', false, env),
    rtcIntervalMs,
  };
}

/** Hostnames that mean "a LiveKit server running locally". */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

export type LivekitUrlCheck = {
  ok: boolean;
  scheme?: string;
  host?: string;
  port?: string;
  problems: string[];
  warnings: string[];
};

/**
 * Validate `LIVEKIT_URL` before startup.
 *
 * A `ws://` URL pointing at localhost, or an `http(s)://` URL, are the two most
 * common reasons an agent never reaches LiveKit Cloud — the agent retries and
 * fails with a connection error that does not mention the URL scheme. `problems`
 * must fail the run; `warnings` are informational (a local server is legitimate).
 */
export function validateLivekitUrl(url?: string): LivekitUrlCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const value = url?.trim();

  if (value === undefined || value === '') {
    return { ok: false, problems: ['LIVEKIT_URL is not set.'], warnings };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      problems: [
        `LIVEKIT_URL is not a valid URL (got "${value.split(':')[0]}:"). ` +
          'Expected wss://<project>.livekit.cloud for LiveKit Cloud.',
      ],
      warnings,
    };
  }

  const scheme = parsed.protocol;
  const host = parsed.hostname;
  const port = parsed.port;
  const isLocal = LOCAL_HOSTNAMES.has(host);

  if (scheme === 'http:' || scheme === 'https:') {
    problems.push(
      `LIVEKIT_URL uses "${scheme}//" — LiveKit needs a WebSocket URL. ` +
        `Use "wss://${parsed.host}" for LiveKit Cloud (or "ws://localhost:7880" for a local server).`,
    );
  } else if (scheme === 'ws:') {
    if (isLocal) {
      warnings.push(
        `LIVEKIT_URL points at a local/self-hosted LiveKit server (${value}). ` +
          'This cannot reach LiveKit Cloud — for Cloud use wss://<project>.livekit.cloud.',
      );
    } else {
      problems.push(
        `LIVEKIT_URL uses insecure "ws://" for remote host "${host}". ` +
          `LiveKit Cloud requires "wss://${parsed.host}".`,
      );
    }
  } else if (scheme !== 'wss:') {
    problems.push(`LIVEKIT_URL has unsupported scheme "${scheme}". Expected "wss://".`);
  } else if (!host.endsWith('.livekit.cloud') && !isLocal) {
    warnings.push(
      `LIVEKIT_URL host "${host}" is not a *.livekit.cloud host. ` +
        'That is fine for a self-hosted server; otherwise double-check your project URL.',
    );
  }

  return { ok: problems.length === 0, scheme, host, port, problems, warnings };
}

