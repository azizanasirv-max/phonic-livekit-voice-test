# Phonic + LiveKit real-time voice agent (minimal prototype)

A deliberately small, working prototype of a **real-time speech-to-speech** voice agent:

- **LiveKit Agents (Node.js)** for the agent server, room transport, and turn handling
- **`@livekit/agents-plugin-phonic`** so Phonic does the speech-to-speech conversation
- No database, no CRM, no payments, no custom frontend, no deployment automation

You talk into a microphone, Phonic answers out loud, and you can interrupt the agent mid-sentence.

> **Scope:** this is an isolated experiment. It does not read, modify, or integrate with any other
> project in this workspace.

---

## 1. Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | **>= 20** (verified on `v24.15.0`) | Per LiveKit's Node.js requirements. This project relies on Node's built-in TypeScript type-stripping to run `.ts` files directly, which needs Node >= 22.18 in practice; **Node 24 LTS is recommended**. |
| npm | >= 10 (verified on `11.12.1`) | pnpm also works. |
| LiveKit project | — | LiveKit Cloud (free tier available) or a self-hosted LiveKit server. |
| Phonic account | — | Needed for `PHONIC_API_KEY`. |

Verified package versions (from the npm registry at build time):

| Package | Version |
| --- | --- |
| `@livekit/agents` | `1.9.3` |
| `@livekit/agents-plugin-phonic` | `1.9.3` |
| `@livekit/rtc-node` | `^1.1.0` (peer dependency of the plugin) |

Documentation this prototype is based on:

- Phonic plugin guide: <https://docs.livekit.io/agents/models/realtime/plugins/phonic/>
- Voice AI quickstart (Node.js): <https://docs.livekit.io/agents/start/voice-ai/>
- Agent dispatch: <https://docs.livekit.io/agents/server/agent-dispatch/>

---

## 2. Install

```bash
npm install
```

Optional (only needed for `npm run download-files`; the Phonic plugin has no downloadable models,
so this is a no-op today):

```bash
npm run download-files
```

## 3. Configure

```bash
cp .env.example .env
# then edit .env and fill in the four required values
npm run check:env        # masked summary + LIVEKIT_URL scheme check; exits non-zero on problems
```

| Variable | Required | Secret? | Where to get it |
| --- | --- | --- | --- |
| `PHONIC_API_KEY` | **Yes** | **Yes** | Phonic console → API keys (<https://phonic.ai/>) |
| `LIVEKIT_URL` | **Yes** | No | LiveKit Cloud project URL, e.g. `wss://your-project.livekit.cloud` |
| `LIVEKIT_API_KEY` | **Yes** | **Yes** | LiveKit Cloud → Project settings → Keys |
| `LIVEKIT_API_SECRET` | **Yes** | **Yes** | LiveKit Cloud → Project settings → Keys (same page) |
| `PHONIC_VOICE` | No | No | Default `sabrina`. Documented voices: `sabrina`, `grant`, `virginia`, `landon`, `eleanor`, `shelby`, `nolan` |
| `PHONIC_MIN_WORDS_TO_INTERRUPT` | No | No | Default `2`. Minimum words the user must say to interrupt the agent |
| `LIVEKIT_AGENT_NAME` | No | No | Unset by default → automatic dispatch. Set it to enable explicit dispatch |

`.env` is gitignored. `.env.example` contains placeholders only. Never commit real credentials.

---

## 4. Run

```bash
npm run dev      # node src/main.ts dev    (development worker, random local HTTP port)
npm start        # node src/main.ts start  (production-style worker, HTTP port 8081)
```

Both connect to `LIVEKIT_URL` and register the agent with LiveKit. Press `Ctrl+C` to stop.

> `npm run dev` prints a deprecation warning suggesting `lk agent dev`. That is the LiveKit CLI's
> preferred workflow (it also auto-reloads and prints an Agent Console link), but `lk` is an extra
> install — `npm run dev` works fine on its own.

### Then talk to it

Pick whichever option you prefer:

**A. Terminal, microphone + speakers (no browser, needs the LiveKit CLI)**

```bash
lk agent console        # install: https://docs.livekit.io/reference/developer-tools/livekit-cli/
```

Console mode runs the agent against a local simulated room, so it does not use LiveKit Cloud
transport. Only `PHONIC_API_KEY` is needed for this mode.

**B. Browser, microphone + speakers (no extra tooling)**

1. Keep `npm run dev` running.
2. Open the Agent Console from your project's Agents dashboard:
   <https://cloud.livekit.io/projects/p_/agents> → **Launch Console**.
3. Join a room from the Console and allow microphone access. Because `LIVEKIT_AGENT_NAME` is
   unset, the agent is automatically dispatched into the new room and will greet you.

> With `LIVEKIT_AGENT_NAME` **set**, dispatch becomes explicit: the room token must request that
> agent name, e.g. `lk token create --join --open my-room --agent phonic-voice-agent`, or
> `lk dispatch create --agent-name phonic-voice-agent --room my-room`.

---

## 5. How interruption works

Interruption is handled by Phonic's own turn detection, not by extra code here. The plugin exposes
documented options that are wired up in `src/phonic.ts`:

- `minWordsToInterrupt: 2` (overridable via `PHONIC_MIN_WORDS_TO_INTERRUPT`) — the user must say at
  least two words before the agent is interrupted, so short acknowledgements like "uh" or "hmm"
  don't cut the agent off.
- `isWelcomeMessageInterruptible: true` — you can talk over the opening greeting.

There is **no** code that calls an interrupt method; interruption happens on Phonic's side when it
detects user speech that clears the word threshold. The agent prompt (`src/instructions.ts`) also
tells the model to stop talking and listen, and not to treat backchannel as a new question.

---

## 6. Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the agent server in development mode |
| `npm start` | Start the agent server in production mode (binds `0.0.0.0:8081`) |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `tests/` |
| `npm test` | Unit tests via `node --test` (no network, no paid calls) |
| `npm run check:env` | Validate `.env` and print a masked summary |
| `npm run download-files` | `livekit-agents download-files` (no-op for the Phonic plugin) |

---

## 7. Tests

```bash
npm run typecheck   # must pass cleanly
npm test
```

`npm test` runs 27 unit tests in three files. **None of them make network requests or call a paid
API:**

| File | Covers |
| --- | --- |
| `tests/config.test.ts` | Env validation, missing-variable reporting, credential masking/redaction, `LIVEKIT_URL` scheme validation |
| `tests/instructions.test.ts` | The prompt is concise and contains the interruption/backchannel rules |
| `tests/phonic.test.ts` | The Phonic model is constructed with the documented options and fails cleanly without a key |

There is **no automated end-to-end voice test**: verifying real audio requires a paid Phonic
conversation plus a human microphone, so it stays manual (section 8).

### Build and test results (this repository, Node v24.15.0)

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | ✅ 0 errors |
| Unit tests | `npm test` | ✅ 27 passed / 0 failed |
| Agent boots | `node src/main.ts dev` | ✅ Worker starts, binds a random port, then retries the LiveKit connection |
| Connection error path | `node src/main.ts dev` with an unreachable `LIVEKIT_URL` | ✅ Clear `failed to connect to LiveKit server (ws://127.0.0.1:7880), retrying in 2 seconds: (1/10)` messages |
| Missing config path | `npm run check:env` with no `.env` | ✅ Exits `1` with `Missing required environment variable(s): PHONIC_API_KEY, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET` |
| Secret redaction | Grep the run logs for the configured fake key/secret | ✅ No raw secret values in output |

⚠️ **No live voice conversation has been performed or verified.** Every runtime check above used
placeholder credentials and never reached Phonic or a LiveKit server.

### Manual acceptance checklist

Run through this yourself once real credentials are in place. Record what actually happened.

| # | Check | How | Result |
| --- | --- | --- | --- |
| 1 | Agent starts successfully | `npm run dev` → expect `starting worker`, no retry loop, then a successful registration | ☐ |
| 2 | You can connect and hold a voice conversation | Join a room (section 4A or 4B), allow the mic, hear the greeting | ☐ |
| 3 | Agent responds coherently across multiple turns | Ask 4–5 related follow-up questions | ☐ |
| 4 | You can interrupt the agent mid-sentence | Start speaking while it is talking; it should stop and listen | ☐ |
| 5 | You can ask a question while the agent is speaking | Interrupt with a full question, e.g. "what's the weather like today?" | ☐ |
| 6 | No self-interruption or false triggers on acknowledgements | While the agent talks, say "uh-huh" / "hmm"; it should keep going | ☐ |
| 7 | Conversation stable for several minutes | Talk for 5+ minutes, check for drops, hangs, or a frozen session | ☐ |
| 8 | Errors are understandable and credentials stay private | Break one value in `.env` on purpose; check the message is actionable and no key appears in the log | ☐ |

For checks 4–6, raise `PHONIC_MIN_WORDS_TO_INTERRUPT` (e.g. to `3`) if the agent is being
interrupted too easily, or set it to `1` if it is too hard to interrupt.

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `Missing required environment variable(s): …` | `.env` is missing or incomplete. Run `npm run check:env`. |
| `Phonic API key is required. Provide apiKey or set PHONIC_API_KEY.` | `PHONIC_API_KEY` is empty in the environment the agent runs in. |
| `failed to connect …: connect ECONNREFUSED 127.0.0.1:7880` | `LIVEKIT_URL` still points at a local/self-hosted server. For LiveKit Cloud it must be `wss://<project>.livekit.cloud`. `npm run check:env` now flags this. |
| `failed to connect …: Unexpected server response: 401` | TLS/WebSocket reached LiveKit, but it rejected the credentials. The `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` pair is wrong, from a different project, or revoked — or the project name in `LIVEKIT_URL` does not match those keys. Re-copy both values from Project settings → Keys. |
| `failed to connect …: getaddrinfo ENOTFOUND` / `EAI_AGAIN` | DNS or network problem, or a typo in the project subdomain. Check that the host in `LIVEKIT_URL` exists. |
| `failed to connect to LiveKit server (…), retrying…` then gives up | Wrong `LIVEKIT_URL`, wrong key/secret, or the LiveKit server is unreachable. Cloud URLs must start with `wss://`. |
| Agent picks up the wrong URL even though `.env` looks right | A stale `LIVEKIT_URL` (or key/secret) exported in your shell wins over `.env` — dotenv does not override already-set variables. Run `env | grep LIVEKIT` and `unset` the stale ones, or start from a clean shell. |
| `Error: listen EADDRINUSE: address already in use 0.0.0.0:8081` | `npm start` (production mode) always binds port 8081. Stop the other process or use `npm run dev`, which binds a random free port. |
| Agent starts but nobody joins the room | With `LIVEKIT_AGENT_NAME` set, dispatch is explicit — the room token must request that agent name, otherwise the agent is never assigned. Unset it for automatic dispatch. |
| Agent joins but you hear nothing | Check microphone permission in the browser/terminal, that you joined the same room, and that the Phonic conversation was created (look for `phonic conversation created` in the logs). |
| Type-stripping errors when running `node src/main.ts` | Node is too old. Use Node >= 22.18 (Node 24 LTS recommended). |
| Connection drops mid-conversation | Check `session error` log lines; Phonic/network hiccups surface there. Re-run with `--log-level DEBUG` for more detail. |

---

## 9. Cost and deployment safeguards

**This repository contains no CI and no deploy automation.** It ships the deployment inputs
(`Dockerfile`, `.dockerignore`) but running `lk agent create` / `lk agent deploy` — the only steps
that create billable cloud resources — is always an explicit, manual action. Nothing is deployed
automatically, and no billing settings are touched by this repository.

Services that require credentials, and their cost characteristics:

| Service | Credential | Cost |
| --- | --- | --- |
| **Phonic** (speech-to-speech) | `PHONIC_API_KEY` | Billed per minute of conversation. Per Phonic's published pricing: Starter plan `$0/mo` with `$30/month` in free credits at `$0.14/min`; Pro `$240/mo` with `$240/month` in free credits at `$0.12/min` (<https://phonic.ai/pricing>). Verify current terms yourself before a long test. |
| **LiveKit** (transport / agent server) | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit Cloud has a free tier; usage beyond it is metered (connection minutes, etc.). Running the agent locally is free apart from your own machine. Self-hosting the LiveKit server is free/OSS. |

Practical cost notes:

- Every minute of conversation consumes Phonic minutes, including your manual test conversations.
- The unit tests in this repo cost nothing — they never open a connection.
- An unreachable/misconfigured agent costs nothing; it fails before any conversation starts.

**Keep this prototype isolated:** use its own LiveKit project (or at least its own agent name) and
its own Phonic key. Do not point it at a LiveKit project used by another production system.

---

## 10. Deploy to LiveKit Cloud

The agent deploys as a container built by the LiveKit Cloud build service, using the `Dockerfile`
and `.dockerignore` in this repo (adapted from the official Node.js template at
<https://docs.livekit.io/agents/ops/deployment/builds/>). The image uses **Node 24**, installs
`ca-certificates` (required by the LiveKit SDK's native TLS stack), runs as an unprivileged
`appuser`, and starts with `npm start`.

### Prerequisites

| Item | Where to get it |
| --- | --- |
| LiveKit CLI (`lk`) | <https://docs.livekit.io/reference/developer-tools/livekit-cli/> |
| LiveKit project credentials | LiveKit Cloud dashboard → Project settings → Keys (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`) |
| Phonic key | Phonic console → API keys (`PHONIC_API_KEY`) |

### 1. Authenticate

```bash
lk cloud auth          # interactive browser flow (recommended)
```

For a non-interactive environment, register the project with keys instead:

```bash
lk project add <name> --url wss://<project>.livekit.cloud \
  --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET" --default
```

### 2. Create the agent (first deploy)

`lk agent create` registers the agent, writes `livekit.toml`, builds the image, and deploys the
first version. Secrets are read from a `.env.local` file (gitignored), or passed with `--secrets`.

```bash
cp .env.example .env.local      # then fill in the real values
lk agent create --secrets-file .env.local
```

LiveKit Cloud injects `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` automatically, so
only `PHONIC_API_KEY` (and optional tuning values) strictly needs to be supplied as a secret.

### 3. Subsequent deploys and monitoring

```bash
lk agent deploy                 # ship a new version
lk agent status                 # deployment status
lk agent logs                   # runtime logs
lk agent secrets                # list secret names (values are never shown)
```

### 4. Talk to it

```bash
lk agent console                # browser-based voice console, no frontend needed
```

`lk agent create` / `lk agent deploy` upload your build context to LiveKit Cloud, which creates
billable resources on your LiveKit project. Confirm the target project before running them.

---

## 11. Files

```
.env.example        Placeholder values for the four required variables
.gitignore          Excludes .env and other secret-bearing files
Dockerfile          Deployment image (Node 24, non-root, `npm start`) for LiveKit Cloud builds
.dockerignore       Keeps tests, secrets and docs out of the build context
package.json        Dependencies and scripts
tsconfig.json       Type-check configuration (NodeNext, strict, no emit)
src/main.ts         Agent entry point: defineAgent + AgentSession + Phonic model + cli.runApp
src/phonic.ts       Phonic RealtimeModel construction and option resolution
src/agent.ts        Builds the LiveKit voice.Agent
src/instructions.ts Agent prompt (concise, interruption/backchannel aware)
src/config.ts       Env reading, validation, masking, redaction
src/logging.ts      Redacted console logging helpers
src/check-env.ts    `npm run check:env` preflight check
tests/*.test.ts     Unit tests (no network, no paid calls)
```

---

## 12. Unresolved questions

1. **Exact Phonic billing granularity** — pricing is published per minute, but per-second rounding,
   minimum session length, and whether a failed/no-audio session is billed are not documented on the
   pricing page. Confirm with Phonic before a long test.
2. **Free-credit terms** — the `$30/month` Starter credits: whether they roll over, and whether they
   apply to the Live Conversation API used here, is not stated on the pricing page.
3. **LiveKit Cloud free-tier limits** — the exact free connection-minute allowance for agent
   sessions was not verified here; check the LiveKit pricing page for your project.
4. **`minWordsToInterrupt` tuning** — the default of `2` is a judgement call. The right value for
   your microphone, language, and speaking style needs the manual checklist (item 6) to confirm.
5. **`lk agent console` / Agent Console compatibility** — both are documented for locally running
   agents, but neither was executed here (no microphone, and the LiveKit CLI is not installed in the
   build environment). Treat options A and B in section 4 as untested paths.
6. **Phonic model version** — the plugin defaults to the Phonic model `merritt`; whether a newer
   `phonicModel` (`phonic_v1` / `phonic_v1_1`) gives better interruption behavior was not evaluated.
