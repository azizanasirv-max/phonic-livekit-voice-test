# Deepslate Opal + LiveKit real-time voice agent (Stage 1)

A deliberately small prototype for **one** purpose: prove that a real participant can hold a
spoken conversation with **Deepslate Opal** through the **LiveKit Agents (Node.js)** agent that
already existed in this repository, including interrupting Opal mid-sentence.

> **Status: code complete and validated; deployment blocked on a GitHub permission; live microphone
> test still manual.** The GitHub App available for this change can push code but has no `workflows`
> permission, so GitHub rejects any change under `.github/workflows`. The repaired workflow is
> therefore delivered as `deployment/deploy.yml` and has **not** been dispatched. The agent currently
> deployed on LiveKit Cloud still runs the previous provider. See sections 12 and 13.

---

## 1. Scope

**In scope (this stage):** verify the official Opal integration, wire it into the existing agent,
keep credentials server-side, document and test interruption behaviour, and provide a repeatable
manual test for real audio.

**Explicitly not built:** Cloudflare Worker, D1, session tokens, invitation links, prospect page,
sales dashboard, call history, analytics, service profiles, production deployment. LiveKit remains
the transport; nothing was replaced.

---

## 2. Upgrade from the legacy provider

The repository was originally a prototype that wrapped a different realtime speech-to-speech
provider. The LiveKit-facing parts were reusable; the provider layer was not.

| Area | Before | Decision |
| --- | --- | --- |
| Entry point | `src/main.ts` — `defineAgent({ entry })` + `cli.runApp(new ServerOptions(...))`; `npm run dev` / `npm start` | **Reused** |
| LiveKit SDK | `@livekit/agents@1.9.3`, `@livekit/rtc-node@^1.1.0` | **Reused unchanged** |
| Provider | Legacy vendor plugin, wrapped by a vendor module | **Removed.** Replaced by `@deepslate-labs/livekit@0.1.23` and `src/deepslate.ts` |
| Session | `src/session.ts` — one `AgentSession` with a single realtime `llm`; no STT/LLM/TTS stack | **Reused**, comments generalised |
| Room lifecycle | `ctx.connect()` + `session.start({ agent, room })` + `generateReply()` greeting; automatic or explicit dispatch via `LIVEKIT_AGENT_NAME` | **Reused** (connection now happens before session start, matching the official Opal quick start) |
| Turn handling | `turnDetection: 'realtime_llm'`; interruptions enabled; `resumeFalseInterruption: false`; no client-side word/duration thresholds | **Reused** |
| Interruption | Provider server-side VAD reports speech onset; LiveKit interrupts the active `SpeechHandle` and flushes queued audio | **Reused**; Opal produces the same LiveKit event |
| Config | `src/config.ts` — required vars, `ConfigError`, masking, redaction; `npm run check:env` | **Reused**, variables changed |
| Logging | `src/logging.ts` — redacts secrets from every line | **Reused unchanged** |
| Tests | Config, prompt, legacy vendor wiring, turn policy, real-`AgentSession` interruption harness | **Vendor wiring test removed**; the provider-independent interruption harness is retained and adapted |
| Deployment | Multi-stage `Dockerfile`, manual LiveKit Cloud workflow with a legacy-secret preflight | **Dockerfile reused**; workflow rewritten for the existing agent and Deepslate secrets |

**Removed completely:** the legacy adapter module, its vendor plugin dependency, its API-key,
voice and VAD variables, the vendor-specific test double and wiring test, the legacy instructions
in the deployment documentation, and the workflow's legacy secret preflight and secret references.
The shared interruption harness was kept because it tests LiveKit's behaviour, not the vendor's.

There is no fallback path: `src/main.ts` constructs only the Deepslate model, and
`tests/provider-consistency.test.ts` fails if a legacy dependency, source reference, environment
variable or workflow secret reference is reintroduced.

**Voice-session lifecycle now:** validate Deepslate + LiveKit config → build the Opal
`RealtimeModel` → wrap it in `AgentSession` with the fixed turn policy → attach
Error/Speech/State listeners → `ctx.connect()` → `session.start()` → `generateReply()` for the
greeting.

---

## 3. Verified Opal integration

Official sources consulted (October 2026):

- Documentation index: <https://docs.deepslate.eu/llms.txt>
- Node.js LiveKit plugin: <https://docs.deepslate.eu/livekit-node.md>
- How Opal works: <https://docs.deepslate.eu/opal.md>
- Realtime concepts: <https://docs.deepslate.eu/concepts.md>

**Decision: use the documented `@deepslate-labs/livekit` plugin with LiveKit Agents.**

- Package: `@deepslate-labs/livekit` (latest `0.1.23`, installed).
- Installation: `npm install @deepslate-labs/livekit` alongside the LiveKit peer packages.
- The plugin exposes `RealtimeModel`, which plugs into the existing `voice.AgentSession` as its
  `llm`. No separate STT, LLM or TTS pipeline was added; Opal performs speech understanding and
  response generation, with server-side TTS for the audio stream.
- The direct **WebRTC** API was **not** used. It is documented as under construction/unavailable;
  the LiveKit plugin is the supported route for this workflow.

### Required configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DEEPSLATE_VENDOR_ID` | Yes | Deepslate vendor ID |
| `DEEPSLATE_ORGANIZATION_ID` | Yes | Deepslate organization ID |
| `DEEPSLATE_API_KEY` | Yes (secret) | Deepslate API key |
| `DEEPSLATE_MODEL` | No | Pin an Opal model; unset = platform default (`opal-v2.1`) |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | Yes (this deployment) | Server-side ElevenLabs TTS |
| `DEEPSLATE_HOSTED_VOICE_ID` | No | Optional alternative TTS path if a cloned voice exists |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Yes | LiveKit transport/agent server |

**Audio output is conditional on a TTS config.** In the plugin,
`audioOutput = options.ttsConfig != null`. With no TTS backend Opal still understands speech and
produces text, but no audio reaches the room. This deployment uses the plugin's `eleven_labs`
backend, so `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` are required. A Deepslate-hosted voice is
supported but is **not required** and this account does not have one. `npm run check:env` reports the
resolved backend.

### SDK compatibility (verified)

- The plugin declares `@livekit/agents ^1.7.1` — the repository's `1.9.3` satisfies this.
- The plugin declares `@livekit/rtc-node ^0.13.34`, but `@livekit/agents@1.9.3` requires
  `@livekit/rtc-node ^1.1.0`. The ranges cannot both be satisfied by one install.
- `package.json` uses an npm **override** to resolve the plugin's `@livekit/rtc-node` to the root
  dependency (`1.1.0`). `npm ci` then installs a single deduplicated copy. This was verified with a
  clean `npm ci --omit=dev`.
- The plugin imports only `AudioFrame` from `@livekit/rtc-node`; its constructor signature is
  identical in `0.13.x` and `1.1.0`. Model construction, capability reporting and option resolution
  were exercised on the installed runtime (`tests/deepslate.test.ts` plus a direct startup probe).
  This closes the type/runtime risk for the audio frame boundary, but a live call is still required to
  confirm the service end to end.

### How audio flows

1. LiveKit delivers the participant's microphone audio to the agent room.
2. `AgentSession` pushes frames into the Opal realtime session (`RealtimeSession.pushAudio`).
3. Opal streams generated audio frames back; the plugin wraps them in `AudioFrame` and publishes them
   through LiveKit's audio output to the participant.
4. Turn taking is Opal's server-side VAD (start/stop durations, confidence, volume, backbuffer).

### Native Opal STS status (blocked upstream as of 2026-10-19)

**Native Opal speech-to-speech audio output is not available through the
installed Deepslate Realtime API + `@deepslate-labs/livekit@0.1.23`.** This is a
server/API limitation, not a TypeScript or adapter bug:

- `InitializeSessionRequest` has no native-audio/output-mode field. Its
  `tts_configuration` is optional, and the API reference says: *“Optional
  text-to-speech configuration. If omitted, raw text fragments are sent.”*
- `ModelAudioChunk` is documented as *“TTS audio output when a TTS provider is
  configured”*; the WebSocket guide says it is sent *“only when a TTS provider
  is configured.”*
- In `@deepslate-labs/livekit`, `audioOutput` and the generation modalities are
  derived from `ttsConfig != null`; without it the plugin closes the audio
  stream and declares `text` only.
- The official Python SDK documents the same rule: *“When None (default), only
  text output is provided.”*
- The maintainer confirmed in the SDK repository that an unresolved TTS voice
  causes a silent fallback to text-only responses — there is no native audio
  fallback.

Sources: [Opal](https://docs.deepslate.eu/opal) (the model supports a full S2S
mode), [Realtime protocol](https://docs.deepslate.eu/api-reference/realtime),
[WebSocket](https://docs.deepslate.eu/websocket),
[LiveKit Node](https://docs.deepslate.eu/livekit-node), and
[deepslate-sdks](https://github.com/deepslate-labs/deepslate-sdks).

A protocol comment in `ChatAudioData` mentions *“model-output audio (not
TTS-synthesized)”*, but no documented request field or streaming mode selects
it, and `ModelAudioChunk` itself is documented as TTS-only. It is not a usable
native-STS switch.

**There is no official newer package that changes this.** `0.1.23` is the latest
published `@deepslate-labs/livekit`/`@deepslate-labs/core` version, and the
public GitHub `main` still has the same `ttsConfig`-gated behaviour.

#### What this repository now provides

- `src/native-sts.ts` — a provider-independent observation/verdict layer that
  distinguishes a real completed response with model audio from a text-only
  response. It never synthesizes audio.
- `scripts/probe-native-sts.ts` — a live diagnostic that opens a real
  `DeepslateSession` with **no** `tts_configuration`, sends one text prompt, and
  reports whether the server actually emits `modelAudioChunk` audio.
- `tests/native-sts.test.ts` — unit tests for the observation logic (mocked;
  they do not prove server behaviour).

Run the live probe with your own Deepslate credentials (never committed):

```bash
DEEPSLATE_VENDOR_ID=... \
DEEPSLATE_ORGANIZATION_ID=... \
DEEPSLATE_API_KEY=... \
npm run probe:native-sts
```

- Exit `0` + “NATIVE MODEL AUDIO OBSERVED”: the server exposed model audio on
  that session; the next step is a production adapter.
- Exit `2` + `audio chunks=0`: native STS is not exposed by that
  account/server. Do not describe the agent as native STS.
- Exit `1`: missing configuration.

The probe sends a text prompt rather than microphone audio. It proves the
server's **output** path; audio input is already documented and supported by the
same session. A full native-STS live test still requires microphone audio once
the output path exists.

#### Exact upstream work still required

1. **Deepslate Realtime API:** expose Opal's native speech decoder on the
   realtime session (for example, a documented native output mode, or documented
   audio output when `tts_configuration` is omitted), and emit incremental
   native audio chunks with turn/interruption metadata.
2. **`@deepslate-labs/core`:** expose the corresponding option in
   `DeepslateOptions`/`InitializeSessionRequest` and forward native
   `audioChunk` events without a TTS config.
3. **`@deepslate-labs/livekit`:** set `audioOutput: true` based on that mode,
   report `audio`+`text` modalities, map native PCM chunks to `AudioFrame`, and
   keep interruption/reconnect behaviour.
4. **This repository:** remove the TTS requirement from `src/deepslate.ts` and
   the deployment secrets only after upstream (1)–(3) exist and a live probe
   proves audio.

Until then the working agent remains **text + configured TTS**, not native
Opal speech output. That is stated explicitly rather than hidden behind a
fallback.

---

## 4. What the code does now

```
participant mic ──► LiveKit room ──► AgentSession ──► DeepslateRealtimeSession ──► Opal
                                                                                    │
participant speakers ◄── LiveKit room ◄── AgentSession audio output ◄── audio frames ┘
```

- `src/main.ts` validates config, builds the Opal model, attaches log-only event listeners, connects
  to the room, starts the session, then requests a short spoken greeting.
- `src/deepslate.ts` is the only file that imports `@deepslate-labs/livekit`. It resolves credentials,
  VAD overrides and the TTS backend, and never logs a credential.
- `src/session.ts` keeps the provider-independent turn/interruption policy.
- `src/agent.ts` supplies the conversational prompt.
- `src/config.ts` validates variables, masks/redacts secrets, and checks `LIVEKIT_URL`.
- `src/check-env.ts` prints a masked summary plus the TTS backend, exiting non-zero on problems.

The running agent imports only `src/deepslate.ts`; a provider-consistency test guards that isolation.


---

## 5. Install and configure

Requirements: Node.js 24 (verified `v24.15.0`; Node >= 22.18 is needed for built-in TypeScript
type-stripping), npm 11, a LiveKit project, a Deepslate account, and ElevenLabs TTS (free plan is
sufficient for non-commercial use; see `deployment/README.md` for the verified limits).

```bash
npm install
cp .env.example .env
# edit .env: Deepslate IDs/key, LiveKit URL/key/secret, ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID
npm run check:env
```

`npm run check:env` prints only masked credentials. It fails if a required variable is missing,
`LIVEKIT_URL` is not a usable WebSocket URL, or no TTS backend is configured.

Never commit `.env`; it is gitignored. No credential is sent to a browser or printed in logs.

---

## 6. Live test (manual — required)

This is the Stage 1 acceptance test. It cannot be automated without real service credentials and a
human microphone.

### 6.1 Start the agent

```bash
npm run dev          # node src/main.ts dev, random local HTTP port
# or
npm start            # node src/main.ts start, binds 0.0.0.0:8081
```

Expected log lines:

```
INFO starting agent server ... DEEPSLATE_API_KEY=**** ...
INFO starting worker
INFO Server is listening on port ...
```

The worker must register with LiveKit. If it prints `failed to connect to LiveKit server (...)`, fix
`LIVEKIT_URL` / keys before continuing.

### 6.2 Connect a real participant (choose one)

**A. Browser through LiveKit Cloud (no extra tooling) — recommended**

1. Keep `npm run dev` running.
2. Open <https://cloud.livekit.io/projects/p_/agents> → **Launch Console**.
3. Join a room and allow microphone access.
4. With `LIVEKIT_AGENT_NAME` unset, the agent is automatically dispatched into the new room. With it
   set, request that agent explicitly, e.g.
   `lk token create --join --open my-room --agent opal-voice-agent`.

**B. LiveKit CLI console**

```bash
lk agent console     # https://docs.livekit.io/reference/developer-tools/livekit-cli/
```

This uses a local simulated room rather than LiveKit Cloud transport, but still exercises Opal over
the network and is sufficient to hear audio.

### 6.3 Pass criteria

| # | Check | Expected |
| --- | --- | --- |
| 1 | Agent starts | Worker listens and registers, no retry loop |
| 2 | Agent joins the room | `INFO agent connected to room` |
| 3 | Participant mic reaches Opal | Speaking produces `user state ... listening`; Opal answers |
| 4 | Real spoken response | You hear a synthesized voice in the room |
| 5 | Multi-turn conversation | Follow-up questions are answered coherently |
| 6 | Interruption | Start speaking while Opal is talking: `agent state` leaves `speaking` and Opal stops |
| 7 | Conversation resumes | Your next turn gets a fresh answer with no replayed old audio |
| 8 | Failure reporting | Kill the network / use a bad key: an explicit `session error` / `job failed` line appears |

Record what you actually observed. A successful room join alone does **not** prove interruption
works.

---

## 7. Interruption: what the verified integration does

### 7.1 Mechanism (from `@deepslate-labs/livekit@0.1.23` source)

1. Opal's server-side VAD decides the participant has started speaking and sends
   `playbackBufferClear`.
2. The plugin's handler, for a normal interruptible generation:
   - emits LiveKit's `input_speech_started`, then
   - closes the current generation (audio/text/function streams).
3. LiveKit's `AgentActivity` receives `input_speech_started`, interrupts the active `SpeechHandle`,
   aborts the task forwarding that response, and calls the audio output's `clearBuffer()`, which
   drops the agent-side queued frames.
4. Opal continues the conversation from the interruption point: the plugin declares
   `messageTruncation: true`, and the server tracks how much was actually spoken, so the next turn
   has accurate context. The plugin's `truncate()` is intentionally a no-op because this is handled
   server-side.

### 7.2 What this repository adds

`src/session.ts` pins the compatible policy: `turnDetection: 'realtime_llm'`, interruptions enabled,
`resumeFalseInterruption: false` (an interrupted response is never resumed later),
`discardAudioIfUninterruptible: true`, and zero client-side word/duration thresholds so LiveKit does
not delay Opal's stop signal.

### 7.3 Limits (verified and documented)

- **Already-transmitted audio cannot be recalled.** Frames that left the agent over WebRTC, plus
  whatever the participant's jitter/playback buffer holds, will finish playing. Only the agent-side
  queue can be flushed.
- **No configurable interruption word count.** The Opal plugin exposes no word-count gate; barge-in
  timing is controlled by server-side VAD.
- **`clearAudio()` is not supported by the backend.** The plugin logs
  `clearAudio not yet supported by the Deepslate backend`; it does not cancel server generation
  beyond closing the local generation.
- **Overlapping speech is not advertised.** LiveKit treats the model as non-overlapping, so a new
  user turn interrupts rather than mixing with the assistant's audio.
- **Provider errors are surfaced, not hidden.** Plugin `error`/`fatalError` events become
  `session error` logs (redacted). An unrecoverable socket failure ends that session; the next job
  starts a fresh one.
- `speakDirect(..., uninterruptable = true)` would ignore barge-in for an utterance. This agent does
  not use it, so normal replies remain interruptible.

### 7.4 Logs to correlate

`user state listening` (barge-in detected) should be followed quickly by `agent state` leaving
`speaking`, then `speech created` for the next turn. Measure the gap against a recording; it includes
Opal's VAD onset plus network latency.


---

## 8. Validation results

Environment: Node `v24.15.0`, npm `11.12.1`, Linux. Commands run from the repository root.

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | **PASS** — 0 errors |
| Unit/integration tests | `npm test` | **PASS** — 76 tests, 76 passed, 0 failed |
| Production install | `npm ci --omit=dev` | **PASS** — 174 packages, single `@livekit/rtc-node@1.1.0` |
| Missing config | `npm run check:env` with no `.env` | **PASS (expected failure)** — exits 1, lists the six missing variables |
| Agent startup | `node src/main.ts dev` with placeholder creds and an unreachable `ws://127.0.0.1:7880` | **PASS** — worker starts, binds a port, retries with clear `ECONNREFUSED` messages |
| Secret redaction | grep startup output for the placeholder key/secret | **PASS** — 0 raw matches; values shown as `****` |
| Opal model init | construct `createRealtimeModel()` with fake env | **PASS** — `model=deepslate-realtime audio=true`, ElevenLabs TTS resolved |
| **Live Opal conversation** | sections 6.1–6.3 | **NOT RUN — requires a microphone and an operator** |
| **Deployed agent + room smoke test** | `deployment/deploy.yml` | **NOT RUN — workflow cannot be activated without GitHub `workflows` permission (section 13)** |

The 76 tests include:

- `tests/deepslate.test.ts` (new): provider construction, explicit credential passing, model
  selection, VAD overrides (including out-of-range rejection), hosted-vs-ElevenLabs resolution,
  missing/invalid credentials, audio-output capability, and no secret leakage.
- `tests/config.test.ts` (updated): required-variable reporting, masking/redaction, `LIVEKIT_URL`
  validation, integer/float parsing.
- `tests/session.test.ts` (updated): the turn/interruption policy.
- `tests/interruption.test.ts` (unchanged, still passing): the **real** LiveKit `AgentSession`,
  generation and audio-playback code with a test-double provider. It proves the downstream
  interruption contract: one-word barge-in stops the response, in-flight generation is cancelled,
  cancelled audio is never scheduled, a new response starts afterwards, repeated interruptions do not
  duplicate audio, and the session recovers after a provider drop.
- `tests/resilience.test.ts` (new): the real `AgentSession` behind `SessionSupervisor` — one
  replacement after a fatal provider error, no duplicate sessions during a burst, restart-budget
  enforcement, no restart when the room is gone, idempotent stop, and room-event detachment.
- `tests/native-sts.test.ts` (new): the observation/verdict layer that distinguishes a completed
  response with real model audio from a text-only response. These are mocked tests; the live
  capability is only proven by `npm run probe:native-sts` against a real Deepslate account.
- `tests/provider-consistency.test.ts` (updated): fails if a legacy provider dependency, adapter, env
  variable or workflow secret reference returns, and asserts that the workflow keeps explicit,
  gated create and deploy modes.

**Honesty note:** the interruption suite exercises LiveKit's real code with a provider double; it does
not prove Opal's live server VAD. Opal's own `playbackBufferClear → input_speech_started` wiring is
verified from the pinned plugin source and must be confirmed with the manual interruption step.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `Missing required environment variable(s): ...` | Fill `.env`; run `npm run check:env` |
| `No audio output configured for Opal` | Set both `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` (or a hosted voice, if one exists) |
| Agent starts but never joins | `LIVEKIT_URL`/keys wrong, or `LIVEKIT_AGENT_NAME` set without requesting that agent in the room token |
| Joins, but no audio | TTS config missing; check `Audio output (TTS)` in `check:env` output; check browser mic permission |
| `session error` with Deepslate text | Invalid/expired Deepslate credentials, model access denied, or network failure; values are redacted in logs |
| `generateReply timed out` | Opal did not start a turn within 30 s; check provider connectivity/credentials |
| Type-stripping error | Node too old; use Node 24 |
| `EADDRINUSE :8081` | Another `npm start` is running; use `npm run dev` |

---

## 10. Security

- All credentials are read server-side from environment variables (or LiveKit Cloud runtime secrets).
- `.env` is gitignored; `.env.example` contains placeholders only.
- `src/logging.ts` passes every line through `redactSecrets`, which masks `DEEPSLATE_API_KEY`,
  `ELEVENLABS_API_KEY`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.
- `npm run check:env` prints masked values only.
- No browser code, worker, token endpoint or client-side credential exists in this stage.

---

## 11. Files changed / added

| File | Change |
| --- | --- |
| `src/deepslate.ts` | Opal model construction, model/VAD/TTS resolution, audio requirement, `ConfigError`s |
| `src/main.ts` | Uses Opal; validates all config; connects before session start; supervises exactly one session |
| `src/resilience.ts` | **New.** Bounded provider-session recovery, room lifecycle logging, duplicate-session guard |
| `src/native-sts.ts` | **New.** Native-STS observation/verdict logic; never synthesizes audio |
| `src/session.ts` | Provider-independent turn/interruption policy; audio queue + disconnect options |
| `src/config.ts` | Deepslate required/secret vars, masked summary, float env parsing |
| `src/check-env.ts` | Validates and reports the TTS backend |
| `src/session.ts` | Provider-independent turn/interruption policy |
| `src/agent.ts` | Provider-independent prompt |
| `src/logging.ts` | Redacts credentials from every log line |
| `src/phonic.ts` | **Deleted.** Legacy vendor adapter; nothing imports it any more |
| `.env.example` | Deepslate + TTS + VAD placeholders; no legacy variables |
| `package.json`, `package-lock.json` | Deepslate plugin/core, legacy plugin removed, `@livekit/rtc-node` override, renamed package, `probe:native-sts` script |
| `tests/deepslate.test.ts` | Opal provider/configuration/capability tests |
| `tests/config.test.ts` | Required-variable, masking/redaction and `LIVEKIT_URL` tests |
| `tests/session.test.ts` | Turn/interruption policy tests |
| `tests/interruption.test.ts` | Provider-independent interruption lifecycle against the real LiveKit session |
| `tests/resilience.test.ts` | **New.** Bounded session recovery, duplicate-session guard, room lifecycle |
| `tests/native-sts.test.ts` | **New.** Native-audio observation/verdict tests (mocked) |
| `tests/fake-realtime-model.ts` | Provider-neutral realtime-model test double (renamed and adapted from the legacy fake) |
| `tests/phonic.test.ts` | **Deleted.** Legacy vendor wiring test |
| `tests/provider-consistency.test.ts` | **New.** Guards against reintroducing a second provider |
| `scripts/room-smoke.ts` | **New.** Joins a real LiveKit room and waits for the deployed agent (no microphone) |
| `scripts/probe-native-sts.ts` | **New.** Live diagnostic: no `tts_configuration`, reports whether Deepslate emits model audio |
| `Dockerfile` | Provider comments updated; reproducible `npm ci --omit=dev` install |
| `deployment/deploy.yml` | **Rewritten.** Explicit create-once and deploy modes, identity guards, generated `livekit.toml` commit/artifact, health checks, smoke test, diagnostics. Pending activation under `.github/workflows/` |
| `deployment/README.md` | **Rewritten.** Free-tier TTS findings, exact secrets, first-create and redeploy steps, manual `livekit.toml` recovery |
| `livekit.toml` | **Deleted.** It named the deleted agent (`CA_y4mXvu49sfag`); the create run generates and commits a new one |
| `.github/workflows/*` | **Unchanged on the remote.** GitHub rejects workflow changes from this App (no `workflows` permission); see section 12 |
| `README.md` | This report |

---

## 12. Deployment workflow (create once, then deploy)

The previous LiveKit Cloud agent was **deleted**, so the old identity
(`CA_y4mXvu49sfag`) is no longer valid and `livekit.toml` has been removed from
this repository. The repaired workflow therefore has two explicit,
non-interchangeable operations:

- `operation=create` (with `confirm_create=true`) registers a new agent once,
  deploys it, writes the new `livekit.toml`, uploads it as the
  `livekit-agent-config` artifact, and commits it back to the branch.
- `operation=deploy` ships a new version of the agent named in the committed
  `livekit.toml`. It fails if the file is missing, has no `CA_...` id, or names a
  different project subdomain than `LIVEKIT_URL`.

Deploy never falls back to create, and create refuses to run when
`livekit.toml` already exists or the confirmation input is false. That is what
prevents a deleted-then-recreated agent from being silently duplicated.

**It is not active yet.** The App used for this task (`cline-cloud[bot]`) lacks
the GitHub `workflows` permission, so it cannot write `.github/workflows/**`.
A repository administrator must install `deployment/deploy.yml` as
`.github/workflows/deploy.yml`, delete the two obsolete workflow files, and run
it manually. Exact steps are in `deployment/README.md`. Until then, do not
dispatch the old manual workflow: it requires the removed provider's secret and
would ship this code without Deepslate configuration.

Order of operations:

1. `npm ci`, `npm run typecheck`, `npm test`.
2. Preflight the identity: create requires confirmation + no `livekit.toml`;
   deploy requires a committed `CA_...` id whose project matches `LIVEKIT_URL`.
3. Build the deploy-action `SECRET_LIST` from individual Deepslate/ElevenLabs
   repository secrets, migrating any legacy `SECRET_LIST` and dropping
   `PHONIC_*` entries. Every value is masked with `::add-mask::`; only names are
   printed.
4. `npm run check:env` with the resolved configuration (masked output).
5. `livekit/deploy-action@v2.12.2` with `OPERATION: create` **or**
   `OPERATION: deploy` — whichever the operator selected; never both.
6. For create only: verify the generated `livekit.toml`, upload it as an
   artifact, then commit/push it so later runs deploy instead of create.
7. `OPERATION: status-retry` (10 minute timeout) to wait for a healthy version.
8. `lk agent status --id <resolved id>` to record the deployed version.
9. Optional room smoke test: a subscribe-only participant joins a temporary
   room and waits for the deployed agent (up to 120 s). It passes
   `SMOKE_EXPECT_AGENT_NAME` when `LIVEKIT_AGENT_NAME` is set, so another agent
   cannot make it pass. It proves dispatch/room connection only.
10. `lk agent logs` (bounded by `timeout`) captured to the run artifact;
    deterministic configuration errors fail the run.
11. A run summary records the operation, project, agent id, commit and each
    outcome.

Required repository secret names: `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `DEEPSLATE_VENDOR_ID`, `DEEPSLATE_ORGANIZATION_ID`,
`DEEPSLATE_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`. Optional:
`DEEPSLATE_MODEL`, the `DEEPSLATE_VAD_*` tuning variables,
`ELEVENLABS_MODEL_ID`, `LIVEKIT_AGENT_NAME`, and `DEEPSLATE_HOSTED_VOICE_ID`
(alternative TTS path; not required).

### Runtime resilience added at the same time

- `SessionSupervisor` (new) closes a dead provider session and starts a fresh
  `AgentSession` at most twice per job, serialized so a burst of fatal errors
  cannot create duplicate sessions. The plugin already retries its own socket
  three times; this covers exhaustion of those retries. No greeting is replayed.
- Room reconnecting/reconnected events are logged only (the SDK owns room
  reconnection); a terminal disconnect stops the session and ends the job.
  Job shutdown closes the session, so a retried job cannot overlap a stale one.
- `RoomOutputOptions.queueSizeMs` is set to 400 ms, the only agent audio-buffer
  knob the installed SDK exposes. `@livekit/rtc-node` has no jitter-buffer
  option, so none is configured.


---

## 13. Outstanding blockers / manual steps

0. **Native Opal STS remains blocked upstream.** The installed Deepslate Realtime
   API/plugin (`0.1.23`, also latest on npm and GitHub `main`) emits text only
   when `tts_configuration` is omitted; `ModelAudioChunk` is TTS-only. The
   repository now contains an honest **live probe**
   (`npm run probe:native-sts`) and observation tests, but no production native
   audio adapter, because there is no server-side native audio to consume. Do
   not claim native STS until the probe returns actual audio chunks and the
   upstream API/SDK/adapter changes in the README section “Native Opal STS
   status” exist.
1. **The old agent was deleted and its `livekit.toml` was removed.** The first
   workflow run must be `operation=create` with `confirm_create=true`, then the
   generated `livekit.toml` must be committed (the workflow does this
   automatically; the artifact is the fallback). Later runs use
   `operation=deploy`. Do not re-run create after an agent exists.
2. **GitHub workflow permission blocks activation.** The App token cannot
   create, update or delete `.github/workflows/**`. An administrator must
   install `deployment/deploy.yml` as `.github/workflows/deploy.yml`, delete the
   obsolete `phonic-deploy.yml` and `deploy.yml.`, and run it. **No deployment
   was performed by this change.**
3. **ElevenLabs TTS must be provisioned.** A free plan is sufficient for
   non-commercial use, but it requires attribution and cannot use Voice Library
   voices through the API. Create a default/premade voice or a Voice Design
   voice and store its id in `ELEVENLABS_VOICE_ID`.
   `DEEPSLATE_HOSTED_VOICE_ID` is not required.
4. **Real microphone acceptance is manual.** The automated room smoke test
   cannot prove speech recognition, spoken output, barge-in or recovery. Run
   section 6 with a real microphone after the first deployment.
5. **Known SDK peer-range mismatch.** The plugin advertises
   `@livekit/rtc-node ^0.13.34` while `@livekit/agents@1.9.3` requires `^1.1.0`.
   The npm override was verified with a clean install and model construction;
   if Deepslate publishes a plugin version with an updated peer range, remove
   the override and re-test.
6. **Residual audio tail.** Audio already sent over RTP or buffered by the
   participant cannot be cancelled by the agent (section 7.3). Expect a short
   tail after a barge-in; this is a transport limit, not a missing cancellation
   call.
7. **Packet-loss/jitter/RTT metrics** require a publisher with a media track.
   The smoke client is subscribe-only, so it records connection state and
   quality events only; the manual console test covers the real audio path.
   `@livekit/rtc-node` exposes no jitter-buffer setting, so none is configured.
8. **Branch protection may reject the generated-file commit.** If the push in
   the create run fails, download the `livekit-agent-config` artifact and commit
   it manually; the run fails with that instruction instead of allowing a
   second create.

