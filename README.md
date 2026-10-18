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
| `PHONIC_MIN_WORDS_TO_INTERRUPT` | No | No | Default `1`. Minimum words the user must say to interrupt the agent. Raise it only if backchannel noises interrupt too often — it directly lengthens the overlap on every interruption (section 5) |
| `PHONIC_VAD_MIN_SPEECH_MS` | No | No | Unset by default (Phonic's own value applies). Phonic `vad_min_speech_duration_ms` — how much speech must accumulate before speech onset is reported |
| `PHONIC_VAD_MIN_SILENCE_MS` | No | No | Unset by default. Phonic `vad_min_silence_duration_ms` — silence needed before the user's turn is considered finished |
| `PHONIC_VAD_PREBUFFER_MS` | No | No | Unset by default. Phonic `vad_prebuffer_duration_ms` — audio kept before speech onset |
| `PHONIC_VAD_THRESHOLD` | No | No | Unset by default. Phonic `vad_threshold` — VAD sensitivity |
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

Interruption is handled by Phonic's own turn detection, not by extra code here. This section
documents the whole lifecycle, what this repository does about it, and the one part it cannot fix.

### 5.1 The lifecycle, step by step

1. **Phonic detects the user's speech.** Its server-side VAD (tuned with `vad_*`) decides the user
   has started talking and emits `user_started_speaking`.
2. **The plugin forwards it.** `handleInputSpeechStarted()` emits LiveKit's `input_speech_started`
   and *then* closes the active generation, which closes that generation's audio and text streams.
3. **LiveKit stops the old response.** `AgentActivity.onInputSpeechStarted` calls
   `interrupt({ source: 'audio_activity' })`, which interrupts the active `SpeechHandle` and aborts
   the task forwarding that response's audio.
4. **Already-buffered audio is dropped, in the agent.** The interrupted branch of the realtime
   generation calls `audioOutput.clearBuffer()`, and the room audio output implements it by
   bumping an interruption generation counter (frames captured after that are discarded) and
   clearing the `AudioSource` queue. `tests/interruption.test.ts` asserts this against the real SDK.
5. **The next response starts clean.** Phonic opens a new generation, LiveKit creates a new
   `SpeechHandle`, and the previous response can no longer deliver audio.

### 5.2 What this repository configures

`src/phonic.ts` (model options) and `src/session.ts` (turn-handling policy):

| Setting | Value | Why |
| --- | --- | --- |
| `minWordsToInterrupt` | **`1`** (was `2`) | Phonic will not stop the assistant until the user has spoken this many words. At `2` the assistant keeps generating and streaming audio for the whole first word of every interruption — the main cause of "it keeps talking over me". `1` is Phonic's own default and the earliest interruption it supports. Override with `PHONIC_MIN_WORDS_TO_INTERRUPT`. |
| `isWelcomeMessageInterruptible` | `true` | You can talk over the opening greeting. |
| `turnHandling.turnDetection` | `'realtime_llm'` | Pinned so Phonic's server-side turn detection stays in charge and cannot be replaced by a client-side VAD or turn detector. |
| `turnHandling.interruption.resumeFalseInterruption` | `false` | LiveKit's default (`true`, with a 2 s timeout) *pauses* the agent's audio on user speech and **resumes it later**, replaying the buffered remainder of the old response after the user has spoken. Disabling it means an interruption ends the response for good. |
| `turnHandling.interruption.minWords` / `minDuration` | `0` / `0` | Phonic already gates interruptions server-side; a second client-side threshold would only delay the stop. |

`PHONIC_VAD_*` (`PHONIC_VAD_MIN_SPEECH_MS`, `PHONIC_VAD_MIN_SILENCE_MS`,
`PHONIC_VAD_PREBUFFER_MS`, `PHONIC_VAD_THRESHOLD`) expose Phonic's documented VAD knobs. They are
**unset by default** so Phonic's own tuned values apply; they exist because lowering
`vad_min_speech_duration_ms` is the only supported way to make Phonic report speech onset earlier
(and therefore stop the assistant earlier) without changing the interruption word count. Tune them
against real recordings, not by guesswork.

### 5.3 Where the old audio actually continues — and the precise limitation

The installed plugin (`@livekit/agents-plugin-phonic@1.9.3`) does **not** cancel or truncate audio
already generated: `interrupt()`, `clearAudio()` and `truncate()` are no-ops that only log a
warning, and its declared capability `messageTruncation` is `false`. It also hardcodes Phonic's
`stream_ahead_of_real_time: true`, which tells Phonic to send the assistant's audio as fast as it is
generated rather than paced to real time. There is no supported option to change either behaviour,
and this repository does not patch the SDK.

Where audio can be stopped, and where it cannot:

| Layer | Can an interruption stop it? |
| --- | --- |
| Phonic generation | Yes, on Phonic's side — but only once Phonic decides the user is speaking. |
| The plugin's generation streams | Yes — the generation is closed, so later chunks are dropped. |
| LiveKit's agent-side playback queue | **Yes** — `clearBuffer()` clears the `AudioSource` queue and discards frames captured after the interruption. |
| WebRTC transmission | No — packets already sent cannot be recalled. |
| Caller's playback / jitter buffer | No — it is inside the client, which the agent cannot reach. |

So the residual overlap is the audio that had already left the agent plus whatever the caller has
buffered, and it grows with (a) how long Phonic takes to decide the user is speaking and (b) how far
ahead of real time Phonic has already streamed. With `stream_ahead_of_real_time: true` forced by the
plugin, that backlog is deeper than with real-time pacing.

**Conclusion:** the agent-side queue *is* flushed, so an interrupted response can never be
*scheduled* again — that is asserted by the regression tests. But the last few hundred milliseconds
already in flight, and anything sitting in the caller's playback buffer, cannot be recalled from
this side of the connection. This repository therefore shrinks the window rather than claiming the
residual tail is gone. If the remaining tail is too large in practice, the fix has to be in the
plugin (expose `stream_ahead_of_real_time`, or implement `truncate()`), and this project deliberately
does not work around that with monkey-patching.

### 5.4 The one thing to watch

A single-word threshold means backchannel noises ("hmm", "uh") can now interrupt the agent, because
Phonic decides. The prompt in `src/instructions.ts` tells the model how to treat backchannel once it
is listening, and `PHONIC_MIN_WORDS_TO_INTERRUPT=2` restores the old behaviour if false
interruptions are worse than the overlap for your microphone and accent. The agent logs a warning at
startup whenever that value is greater than 1.

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

`npm test` runs 46 unit tests in five files. **None of them make network requests or call a paid
API:**

| File | Covers |
| --- | --- |
| `tests/config.test.ts` | Env validation, missing-variable reporting, credential masking/redaction, `LIVEKIT_URL` scheme validation, optional integer parsing |
| `tests/instructions.test.ts` | The prompt is concise and contains the interruption/backchannel rules |
| `tests/phonic.test.ts` | The Phonic model is constructed with the documented options (including `minWordsToInterrupt: 1` and the optional VAD knobs) and fails cleanly without a key |
| `tests/session.test.ts` | The turn-handling policy: server-side turn detection pinned, interruptions on, no resume of interrupted audio |
| `tests/interruption.test.ts` | The interruption lifecycle against the **real** LiveKit `AgentSession` |

`tests/interruption.test.ts` is the regression suite for this fix. It runs the real SDK's realtime
generation, interruption and audio-playback code with only Phonic replaced
(`tests/fake-phonic-realtime.ts`, which mirrors the installed plugin's declared capabilities and
event order). It covers: a one-word interruption, an interruption mid-generation, buffered audio
from a cancelled response never being scheduled, a new response starting afterwards, repeated
interruptions without duplicated or overlapping responses, and recovery after a Phonic disconnect
and after a session close.

`fake-phonic-realtime.ts` is a test double, not a mock of Phonic's network protocol: it does not
invent capabilities the installed plugin does not have, and `interrupt()`, `clearAudio()` and
`truncate()` are no-ops there too, because they are no-ops in the plugin.

There is still **no automated end-to-end voice test**: verifying real audio requires a paid Phonic
conversation plus a human microphone, so it stays manual (section 8).

### Build and test results (this repository, Node v24.15.0)

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | ✅ 0 errors |
| Unit tests | `npm test` | ✅ 46 passed / 0 failed |
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
| 4 | You can interrupt the agent mid-sentence with one word | Start speaking while it is talking; it should stop and listen | ☐ |
| 5 | You can ask a question while the agent is speaking | Interrupt with a full question, e.g. "what's the weather like today?" | ☐ |
| 6 | No audible tail after an interruption | Interrupt, then stay silent: no fragment of the old reply should play after the agent stops | ☐ |
| 7 | No self-interruption or false triggers on acknowledgements | While the agent talks, say "uh-huh" / "hmm"; it should keep going | ☐ |
| 8 | Conversation stable for several minutes | Talk for 5+ minutes, check for drops, hangs, or a frozen session | ☐ |
| 9 | Errors are understandable and credentials stay private | Break one value in `.env` on purpose; check the message is actionable and no key appears in the log | ☐ |

For checks 4–7, raise `PHONIC_MIN_WORDS_TO_INTERRUPT` (e.g. to `2` or `3`) if the agent is being
interrupted too easily — the default is `1`, the earliest interruption Phonic supports. Check 6 is
the one this repository cannot fully fix: see section 5.3 for why, and use it to judge how large the
residual tail actually is on your device before deciding whether it needs a plugin change upstream.

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
| Connection drops mid-conversation | Check `session error` log lines; Phonic/network hiccups surface there. Re-run with `--log-level DEBUG` for more detail. An abnormal Phonic socket close is reported as unrecoverable, so LiveKit ends that session; the next job starts a fresh one. |
| The agent talks over you when you interrupt | `minWordsToInterrupt` is above `1` (the startup log warns about this), or Phonic's VAD is reporting speech onset late. Lower `PHONIC_MIN_WORDS_TO_INTERRUPT` to `1` and consider `PHONIC_VAD_MIN_SPEECH_MS`. See section 5. |
| A short fragment of the old reply still plays after you interrupt | This is the residual, unflushable audio tail described in section 5.3 (audio already sent over RTP plus the caller's own buffer). The agent-side queue is flushed, so nothing can be *re-scheduled*; if the tail is long enough to matter, it needs a plugin-side change upstream. |
| The agent is interrupted by "uh-huh" / "hmm" | Expected with the `1`-word default, because Phonic decides. Raise `PHONIC_MIN_WORDS_TO_INTERRUPT` to `2` and accept the longer overlap. |

---

## 9. Cost and deployment safeguards

**Nothing is deployed automatically.** `.github/workflows/deploy.yml` is `workflow_dispatch`-only —
it has no `push` and no `pull_request` trigger — so a deployment to LiveKit Cloud (the step that
creates billable resources) only ever happens when a human explicitly starts a run. No billing
settings are touched by this repository.

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

For a **deployed** agent, open the **LiveKit Cloud dashboard → Agents → your agent → Console**
and click **Start a session**, then use the microphone button. With `LIVEKIT_AGENT_NAME` unset the
agent uses automatic dispatch, so it joins any new room in the project.

To talk to the agent **locally** instead (needs a local `.env`, not a deployment):

```bash
lk agent console                # runs the agent on your machine and pipes it to your mic/speakers
```

`lk agent create` / `lk agent deploy` upload your build context to LiveKit Cloud, which creates
billable resources on your LiveKit project. Confirm the target project before running them.

### 5. Deploy from GitHub Actions (no local terminal needed)

The workflow lives at **`.github/workflows/deploy.yml`**. It deploys the agent using the official
[`livekit/deploy-action`](https://github.com/livekit/deploy-action), so no interactive
`lk cloud auth` browser session is required.

> **One-time setup step.** The copy committed here sits at `.github/deploy-workflow.yml`, because
> the automation that prepared this branch runs as a GitHub App without the `workflows` permission
> and so cannot write into `.github/workflows/`. Move it into place once:
> open `.github/deploy-workflow.yml` on GitHub → **Edit** (pencil) → change the filename to
> `.github/workflows/deploy.yml` → **Commit changes**. GitHub creates the folder automatically.
> The file is inert until it lives under `.github/workflows/`.
>
> **The workflow must end up on the default branch.** GitHub only shows the *Run workflow* button
> when the workflow file exists on the default branch, and the run deploys whatever branch you
> select. This branch is the one that also carries `Dockerfile` and `.dockerignore`, so merge it
> (see *Open the pull request* below) rather than adding the workflow to the default branch on its
> own — otherwise the deployment fails the "required deployment files exist" check.

### 6. Open the pull request

The default branch of this repository is `cline/afhrhgja`, which does **not** yet contain the
`Dockerfile`, `.dockerignore`, or this workflow. Bring them over with a pull request:

1. Open <https://github.com/azizanasirv-max/phonic-livekit-voice-test/pull/new/cline/chxv51c3>
   (base `cline/afhrhgja` ← compare `cline/chxv51c3`).
2. Click **Create pull request**, then **Merge pull request**.

After the merge the default branch holds everything the deployment needs.

Add four **repository secrets** under *Settings → Secrets and variables → Actions → Repository
secrets*:

| Secret | Value |
| --- | --- |
| `LIVEKIT_URL` | `wss://<project>.livekit.cloud` |
| `LIVEKIT_API_KEY` | LiveKit Cloud project API key |
| `LIVEKIT_API_SECRET` | LiveKit Cloud project API secret |
| `SECRET_LIST` | `PHONIC_API_KEY=<your phonic key>` (comma-separate extra pairs) |

Then open *Actions → Deploy LiveKit Cloud Agent → Run workflow* and pick an operation:

- **`create`** — registers a new LiveKit Cloud agent, builds the container and deploys it. Also
  writes `livekit.toml` (which stores the project subdomain and the agent id — never a credential),
  and the workflow commits that file back so later runs can find the agent. Run this first.
- **`deploy`** — ships a new version of the existing agent. Requires `livekit.toml` in the repo.
- **`status`** — only reads the current agent state.

The workflow is **manual only** — there is no `push` or `pull_request` trigger, so nothing deploys
by itself. All runs share one concurrency group, so two deployments can never race. It never prints
secret values (it registers `::add-mask::` entries for the values inside `SECRET_LIST`, which
GitHub masks automatically) and never writes a credential to a file.

---

## 11. Files

```
.env.example        Placeholder values for the four required variables
.github/deploy-workflow.yml   Manual LiveKit Cloud deploy workflow (workflow_dispatch only).
                              Move to .github/workflows/deploy.yml to activate - see section 10.5.
.gitignore          Excludes .env and other secret-bearing files
Dockerfile          Deployment image (Node 24, non-root, `npm start`) for LiveKit Cloud builds
.dockerignore       Keeps tests, secrets and docs out of the build context
package.json        Dependencies and scripts
tsconfig.json       Type-check configuration (NodeNext, strict, no emit)
src/main.ts         Agent entry point: defineAgent + AgentSession + Phonic model + cli.runApp
src/phonic.ts       Phonic RealtimeModel construction and option resolution
src/session.ts      AgentSession factory + the turn-handling / interruption policy
src/agent.ts        Builds the LiveKit voice.Agent
src/instructions.ts Agent prompt (concise, interruption/backchannel aware)
src/config.ts       Env reading, validation, masking, redaction
src/logging.ts      Redacted console logging helpers
src/check-env.ts    `npm run check:env` preflight check
tests/*.test.ts     Unit tests (no network, no paid calls)
tests/fake-phonic-realtime.ts   Test double for the Phonic model boundary
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
4. **`minWordsToInterrupt` tuning** — the default is now `1` (Phonic's own default and the earliest
   interruption it supports), chosen because `2` demonstrably makes the assistant talk over the start
   of every interruption. Whether `1` produces too many false interruptions for your microphone,
   language, and speaking style still needs the manual checklist (item 6) to confirm;
   `PHONIC_MIN_WORDS_TO_INTERRUPT=2` restores the previous behaviour.
5. **The unflushable audio tail** — audio already transmitted over RTP and buffered in the caller's
   playback path cannot be recalled by the agent (section 5.3). The plugin hardcodes
   `stream_ahead_of_real_time: true` and does not implement `truncate()`, so the size of that tail
   cannot be reduced from this repository. Measuring it needs client-side playback instrumentation,
   which the Stage 0 diagnostics branch (`src/diagnostics.ts`, a separate branch) does not provide
   either — it only samples the agent's peer connection.
6. **Phonic VAD defaults** — the `vad_*` values Phonic applies when they are left unset are not
   published, so `PHONIC_VAD_*` is exposed without a recommended starting value. Set them from
   recordings, not from guesswork.
7. **`lk agent console` / Agent Console compatibility** — both are documented for locally running
   agents, but neither was executed here (no microphone, and the LiveKit CLI is not installed in the
   build environment). Treat options A and B in section 4 as untested paths.
8. **Phonic model version** — the plugin defaults to the Phonic model `merritt`; whether a newer
   `phonicModel` (`phonic_v1` / `phonic_v1_1`) gives better interruption behavior was not evaluated.
