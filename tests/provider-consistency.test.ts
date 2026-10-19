/**
 * Provider-consistency guards.
 *
 * Stage 1 made Deepslate Opal the only voice provider. These tests fail if a
 * legacy provider dependency, adapter, environment variable or deployment
 * secret reference is reintroduced, so the running agent cannot silently fall
 * back to a different vendor. They read the repository as text; no credentials
 * or network access are involved.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { REQUIRED_ENV_VARS, SECRET_ENV_VARS } from '../src/config.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (relativePath: string): string => readFileSync(join(ROOT, relativePath), 'utf8');

/** Matches the removed provider's name in any casing. */
const LEGACY_PROVIDER = /phonic/i;
/** Matches an environment variable or agent secret owned by the removed provider. */
const LEGACY_ENV = /PHONIC_[A-Z0-9_]+/;

describe('single provider', () => {
  it('declares only the Deepslate plugin as its voice provider', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const providerPackages = Object.keys(all).filter((name) =>
      name.startsWith('@livekit/agents-plugin-'),
    );

    assert.equal(all['@deepslate-labs/livekit'], '0.1.23');
    assert.deepEqual(providerPackages, [], 'the Deepslate plugin replaces the LiveKit provider plugins');
    assert.deepEqual(
      Object.keys(all).filter((name) => LEGACY_PROVIDER.test(name)),
      [],
      'no dependency may reference the removed provider',
    );
  });

  it('keeps the removed provider out of every source file', () => {
    for (const file of readdirSync(join(ROOT, 'src')).filter((name) => name.endsWith('.ts'))) {
      const source = read(join('src', file));
      assert.doesNotMatch(source, LEGACY_PROVIDER, `src/${file} still references the removed provider`);
      assert.doesNotMatch(source, LEGACY_ENV, `src/${file} still reads a removed-provider variable`);
    }
  });

  it('imports the Deepslate plugin from exactly one module', () => {
    const importers = readdirSync(join(ROOT, 'src'))
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => read(join('src', name)).includes("from '@deepslate-labs/livekit'"));

    assert.deepEqual(importers, ['deepslate.ts'], 'provider wiring must stay isolated');
  });

  it('requires Deepslate configuration and no removed-provider variables', () => {
    for (const name of ['DEEPSLATE_VENDOR_ID', 'DEEPSLATE_ORGANIZATION_ID', 'DEEPSLATE_API_KEY']) {
      assert.ok(
        (REQUIRED_ENV_VARS as readonly string[]).includes(name),
        `${name} must be required`,
      );
    }
    for (const name of [...REQUIRED_ENV_VARS, ...SECRET_ENV_VARS]) {
      assert.doesNotMatch(name, LEGACY_ENV, `${name} is obsolete`);
    }
  });

  it('documents only Deepslate and TTS configuration in .env.example', () => {
    const example = read('.env.example');
    assert.doesNotMatch(example, LEGACY_ENV);
    assert.doesNotMatch(example, LEGACY_PROVIDER);
    for (const name of ['DEEPSLATE_VENDOR_ID', 'DEEPSLATE_ORGANIZATION_ID', 'DEEPSLATE_API_KEY']) {
      assert.match(example, new RegExp(`^${name}=`, 'm'));
    }
  });

  it('ships one deployment workflow template with explicit create and deploy modes', () => {
    // The repaired workflow lives in deployment/ because this GitHub App lacks
    // the `workflows` permission; see deployment/README.md. Once a human moves
    // it into .github/workflows it must stay identical to this reviewed copy.
    const template = read('deployment/deploy.yml');

    // Both operations are explicit and gated; deploy must never silently fall
    // back to creating a second agent.
    assert.match(template, /OPERATION: create/);
    assert.match(template, /OPERATION: deploy/);
    assert.match(template, /if: \$\{\{ inputs\.operation == 'create' \}\}/);
    assert.match(template, /if: \$\{\{ inputs\.operation == 'deploy' \}\}/);
    assert.match(template, /confirm_create/);
    assert.match(template, /no existing agent to deploy/);
    assert.match(template, /Refusing to create a second agent/);
    assert.match(template, /SMOKE_EXPECT_AGENT_NAME/);
    assert.doesNotMatch(
      template,
      new RegExp(`${LEGACY_ENV.source}=`),
      'the workflow still supplies a removed-provider secret',
    );

    if (existsSync(join(ROOT, '.github', 'workflows', 'deploy.yml'))) {
      assert.equal(
        read('.github/workflows/deploy.yml'),
        template,
        'the active workflow must match the reviewed deployment/deploy.yml',
      );
    }
  });
});
