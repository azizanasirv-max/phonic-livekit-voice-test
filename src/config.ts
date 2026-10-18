/**
 * Environment-variable handling for the Deepslate Opal + LiveKit voice
 * prototype.
 *
 * All `process.env` access goes through this module so that:
 *  - required variables are validated in one place with friendly messages, and
 *  - credentials can be redacted before anything is written to a log.
 */

/**
 * Variables the agent needs before it can start a voice session.
 *
 * Voice output (Deepslate hosted TTS or ElevenLabs) is validated separately in
 * `src/deepslate.ts`, because either provider can supply it.
 */
export const REQUIRED_ENV_VARS = [
  'DEEPSLATE_VENDOR_ID',
  'DEEPSLATE_ORGANIZATION_ID',
  'DEEPSLATE_API_KEY',
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
] as const;

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/** Variables whose values are secrets and must never be logged verbatim. */
export const SECRET_ENV_VARS = [
  'DEEPSLATE_API_KEY',
  'ELEVENLABS_API_KEY',
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
    DEEPSLATE_VENDOR_ID: readEnv('DEEPSLATE_VENDOR_ID', env) ?? '(not set)',
    DEEPSLATE_ORGANIZATION_ID: readEnv('DEEPSLATE_ORGANIZATION_ID', env) ?? '(not set)',
    DEEPSLATE_API_KEY: maskSecret(readEnv('DEEPSLATE_API_KEY', env)),
    DEEPSLATE_MODEL: readEnv('DEEPSLATE_MODEL', env) ?? '(platform default)',
    DEEPSLATE_TTS_PROVIDER: readEnv('DEEPSLATE_TTS_PROVIDER', env) ?? '(auto)',
    DEEPSLATE_VOICE_ID: readEnv('DEEPSLATE_VOICE_ID', env) ?? '(not set)',
    ELEVENLABS_API_KEY: maskSecret(readEnv('ELEVENLABS_API_KEY', env)),
    ELEVENLABS_VOICE_ID: readEnv('ELEVENLABS_VOICE_ID', env) ?? '(not set)',
    LIVEKIT_URL: readEnv('LIVEKIT_URL', env) ?? '(not set)',
    LIVEKIT_API_KEY: maskSecret(readEnv('LIVEKIT_API_KEY', env)),
    LIVEKIT_API_SECRET: maskSecret(readEnv('LIVEKIT_API_SECRET', env)),
    LIVEKIT_AGENT_NAME: readEnv('LIVEKIT_AGENT_NAME', env) ?? '(not set)',
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

/**
 * Parse an optional integer env override.
 *
 * Returns `undefined` both when the variable is unset and when it is set to
 * something unparseable, so a typo can never silently apply a wrong number:
 * either way the provider's own default is used.
 */
export function readOptionalIntEnv(name: string, env: EnvLike = process.env): number | undefined {
  const raw = readEnv(name, env);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Parse an optional float env override (for VAD thresholds).
 *
 * Like {@link readOptionalIntEnv}, an unparseable or negative value is treated
 * as unset so a typo cannot change VAD behaviour.
 */
export function readOptionalFloatEnv(
  name: string,
  env: EnvLike = process.env,
): number | undefined {
  const raw = readEnv(name, env);
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
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

