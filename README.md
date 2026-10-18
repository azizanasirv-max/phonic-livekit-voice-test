# Deepslate Opal + LiveKit real-time voice agent (Stage 1)

A deliberately small prototype for **one** purpose: prove that a real participant can hold a
spoken conversation with **Deepslate Opal** through the **LiveKit Agents (Node.js)** agent that
already existed in this repository, including interrupting Opal mid-sentence.

> **Status: implementation complete, live conversation not yet verified.**
> No Deepslate, LiveKit Cloud or TTS credentials were available in the build environment, so the
> automated checks below all pass but the real microphone/speaker test in section 6 is **manual and
> still outstanding**. See "Outstanding blockers" at the end. Stage 1 is not complete until that
> test is performed.

---

## 1. Scope

**In scope (this stage):** verify the official Opal integration, wire it into the existing agent,
keep credentials server-side, document and test interruption behaviour, and provide a repeatable
manual test for real audio.

**Explicitly not built:** Cloudflare Worker, D1, session tokens, invitation links, prospect page,
sales dashboard, call history, analytics, service profiles, production deployment. LiveKit remains
the transport; nothing was replaced.

---

## 2. Audit of the repository before the change

The repository was a Phonic + LiveKit prototype (its own README stated that no live voice conversation had
yet been verified). The parts that mattered:

| Area | Original implementation | Reusable? |
| --- | --- | --- |
| Entry point | `src/main.ts` — `defineAgent({ entry })` + `cli.runApp(new ServerOptions(...))`; `npm run dev` / `npm start` | **Reused** |
| LiveKit SDK | `@livekit/agents@1.9.3`, `@livekit/rtc-node@^1.1.0` | **Reused unchanged** |
| Provider | `@livekit/agents-plugin-phonic@1.9.3`, wrapped by `src/phonic.ts` | Phonic-specific; isolated |
| Session | `src/session.ts` — one `AgentSession` with a single realtime `llm`; no STT/LLM/TTS stack | **Reused**, comments generalised |
| Room lifecycle | `ctx.connect()` + `session.start({ agent, room })` + `generateReply()` greeting; automatic or explicit dispatch via `LIVEKIT_AGENT_NAME` | **Reused** (connection now happens before session start, matching the official Opal quick start) |
| Turn handling | `turnDetection: 'realtime_llm'`; interruptions enabled; `resumeFalseInterruption: false`; no client-side word/duration thresholds | **Reused** |
| Interruption | Provider server-side VAD reports speech onset; LiveKit interrupts the active `SpeechHandle` and flushes queued audio | **Reused**; Opal produces the same LiveKit event |
| Config | `src/config.ts` — required vars, `ConfigError`, masking, redaction; `npm run check:env` | **Reused**, variables changed |
| Logging | `src/logging.ts` — redacts secrets from every line | **Reused unchanged** |
| Tests | 46 tests: config, prompt, Phonic wiring, turn policy, real-`AgentSession` interruption harness | **Reused/extended** (63 tests now) |
| Deployment | Multi-stage `Dockerfile`, manual-only LiveKit Cloud workflow, `livekit.toml` | **Reused**; Dockerfile comments updated, workflows untouched, nothing deployed |

**Phonic-specific parts:** `src/phonic.ts`, `@livekit/agents-plugin-phonic`, `PHONIC_*` env vars, the
Phonic fake in `tests/fake-phonic-realtime.ts`, and the old README timings. Phonic is no longer
imported by `src/main.ts`; its module and tests are retained only as isolated reference/regression
coverage so existing working code was not deleted.

**Voice-session lifecycle before:** validate `PHONIC_API_KEY` → build `RealtimeModel` → wrap it in
`AgentSession` with the fixed turn policy → attach Error/Speech/State listeners → `session.start()` →
`ctx.connect()` → `generateReply()` for the greeting.

**Interruption behaviour before:** Phonic's server VAD emitted `user_started_speaking`; the plugin
forwarded it as LiveKit `input_speech_started` and closed the generation, so LiveKit interrupted the
active response and cleared its agent-side playback queue. The old README correctly documented that
audio already sent over RTP or buffered in the client cannot be recalled.

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
| `DEEPSLATE_HOSTED_VOICE_ID` | One TTS path | Deepslate-hosted (cloned) voice ID |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | Alternative TTS path | Server-side ElevenLabs voice |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Yes | LiveKit transport/agent server |

**Audio output is conditional on a TTS config.** In the plugin,
`audioOutput = options.ttsConfig != null`. With no TTS backend Opal still understands speech and
produces text, but no audio reaches the room. `src/deepslate.ts` therefore refuses to start without a
complete hosted-voice or ElevenLabs configuration, and `npm run check:env` reports it.

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

`src/phonic.ts` and its tests remain in the tree but are not imported by the running agent.


---

## 5. Install and configure

Requirements: Node.js 24 (verified `v24.15.0`; Node >= 22.18 is needed for built-in TypeScript
type-stripping), npm 11, a LiveKit project, a Deepslate account, and one TTS backend.

```bash
npm install
cp .env.example .env
# edit .env: Deepslate IDs/key, LiveKit URL/key/secret, and ONE TTS backend
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
- **No configurable interruption word count.** Unlike Phonic's `minWordsToInterrupt`, the Opal plugin
  has no equivalent option; barge-in timing is controlled by server-side VAD.
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
| Unit/integration tests | `npm test` | **PASS** — 63 tests, 63 passed, 0 failed |
| Production install | `npm ci --omit=dev` | **PASS** — 176 packages, single `@livekit/rtc-node@1.1.0` |
| Missing config | `npm run check:env` with no `.env` | **PASS (expected failure)** — exits 1, lists the six missing variables |
| Agent startup | `node src/main.ts dev` with placeholder creds and an unreachable `ws://127.0.0.1:7880` | **PASS** — worker starts, binds a port, retries with clear `ECONNREFUSED` messages |
| Secret redaction | grep startup output for the placeholder key/secret | **PASS** — 0 raw matches; values shown as `****` |
| Opal model init | construct `createRealtimeModel()` with fake env | **PASS** — `model=deepslate-realtime audio=true`, hosted TTS resolved |
| **Live Opal conversation** | sections 6.1–6.3 | **NOT RUN — requires real credentials and a microphone** |

The 63 tests include:

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
- `tests/phonic.test.ts` (unchanged, still passing): isolated Phonic wiring retained as regression
  coverage; it is not used by the agent.

**Honesty note:** the interruption suite exercises LiveKit's real code with a provider double; it does
not prove Opal's live server VAD. Opal's own `playbackBufferClear → input_speech_started` wiring is
verified from the pinned plugin source and must be confirmed with the manual interruption step.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `Missing required environment variable(s): ...` | Fill `.env`; run `npm run check:env` |
| `No audio output configured for Opal` | Set `DEEPSLATE_HOSTED_VOICE_ID` or both `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` |
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
| `src/deepslate.ts` | **New.** Opal model construction, model/VAD/TTS resolution, audio requirement, `ConfigError`s |
| `src/main.ts` | Uses Opal; validates all config; connects before session start; structured error handling |
| `src/config.ts` | Deepslate required/secret vars, masked summary, float env parsing |
| `src/check-env.ts` | Validates and reports the TTS backend |
| `src/session.ts` | Comments generalised; policy unchanged (provider-independent) |
| `src/agent.ts` | Comment updated; prompt unchanged |
| `.env.example` | Deepslate + TTS + VAD placeholders |
| `package.json` | Adds `@deepslate-labs/livekit@0.1.23`; rtc-node override; description |
| `package-lock.json` | Regenerated for the new dependency and override |
| `tests/deepslate.test.ts` | **New.** Opal provider/configuration/capability tests |
| `tests/config.test.ts` | Updated for the new variables + float parsing |
| `tests/session.test.ts` | Comment updates only; assertions unchanged |
| `Dockerfile` | Provider comments updated; install unchanged (override lives in `package.json`) |
| `.github/workflows/phonic-deploy.yml`, `.github/workflows/deploy.yml.` | **Unchanged.** The available GitHub App token lacks `workflows` permission; the manual deploy preflight still references Phonic and must be updated before any deployment |
| `README.md` | Replaced with this audit/integration/test report |

`src/phonic.ts`, `tests/phonic.test.ts` and `tests/fake-phonic-realtime.ts` are intentionally
untouched and unused by the running agent.

---

## 12. Git workflow

- Branch: `cline/5myazpr0` (created from the current checkout; default branch untouched).
- No merge or deployment was performed.
- Pull request: opened or reported separately after the final push; see the branch/commit details in
  the hand-off message.

---

## 13. Outstanding blockers / manual steps

1. **Live credentials are required for acceptance.** The build environment had no Deepslate, LiveKit
   Cloud or ElevenLabs credentials, so the real conversation and interruption test in section 6 has
   **not been executed**. Together with item 2, this is the remaining Stage 1 completion criterion.
2. **A TTS backend must be provisioned.** Either create/clone a voice in the Deepslate platform and
   use its `DEEPSLATE_HOSTED_VOICE_ID`, or supply an ElevenLabs key + voice ID. Opal will not emit
   audio without one.
3. **Manual console step.** Joining a room through the LiveKit Agents dashboard (or `lk agent
   console`) is manual; there is no automated end-to-end voice test.
4. **Known SDK peer-range mismatch.** The plugin advertises `@livekit/rtc-node ^0.13.34` while
   `@livekit/agents@1.9.3` requires `^1.1.0`. The npm override was verified with a clean install and
   model construction; if Deepslate publishes a plugin version with an updated peer range, remove the
   override and re-test.
5. **Residual audio tail.** Audio already sent over RTP or buffered by the participant cannot be
   cancelled by the agent (section 7.3). Expect a short tail after a barge-in; this is a transport
   limit, not a missing cancellation call.
6. **No deployment performed.** The LiveKit Cloud workflow was not modified (the GitHub App token
   used here lacks `workflows` permission) and was not triggered. Its `SECRET_LIST` preflight still
   checks `PHONIC_API_KEY`; update it to the Deepslate variables before deploying. `livekit.toml` was
   not modified.
