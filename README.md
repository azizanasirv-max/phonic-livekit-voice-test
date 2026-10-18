# Deepslate Opal + LiveKit real-time voice agent (Stage 1)

A deliberately small, working prototype of a **real-time spoken** voice agent:

- **LiveKit Agents (Node.js)** for the agent server, room transport, and turn handling
- **Deepslate Opal** via the official `@deepslate-labs/livekit` plugin for speech understanding and reply generation
- **Deepslate server-side TTS** (hosted cloned voice or ElevenLabs) for the audible reply
- No database, no CRM, no Cloudflare Worker, no prospect page, no custom frontend

You talk into a microphone, Opal answers out loud through LiveKit, and you can interrupt it mid-sentence.

> **Scope:** Stage 1 only. Stage 2 (Cloudflare Worker, D1, session tokens, invitation page, dashboard) is intentionally absent.

---

## 1. Architecture audit (what existed before this change)

| Area | Before |
| --- | --- |
| Entry point | `src/main.ts` — `defineAgent({ entry })` plus `cli.runApp(new ServerOptions(...))` |
| Startup | `npm run dev` (`node src/main.ts dev`) / `npm start` (`node src/main.ts start`) |
| LiveKit SDK | `@livekit/agents@1.9.3`, `@livekit/rtc-node@^1.1.0` |
| Voice provider | `@livekit/agents-plugin-phonic@1.9.3` (speech-to-speech) |
| Session lifecycle | One `voice.AgentSession` per dispatched room job; start session, connect room, `generateReply` greeting |
| Turn detection | Deep in the plugin: realtime model detects turns; session policy pinned in `src/session.ts` to `realtime_llm` |
| Interruption | Phonic `user_started_speaking` → LiveKit `input_speech_started` → interrupt active speech + flush queued audio; `resumeFalseInterruption: false` |
| Config | `.env` via `dotenv`, validated in `src/config.ts`, masked logging, `npm run check:env` |
| Tests | `node --test` on `tests/*.test.ts`; real LiveKit session with a fake provider for interruption tests |
| Deployment | `Dockerfile` (Node 24, `npm start`), manual `workflow_dispatch` LiveKit Cloud workflow, `livekit.toml` |
| Reusable | Agent server, room lifecycle, turn-handling policy, config/redaction, logging, tests, deploy image |
| Phonic-specific | `src/phonic.ts`, Phonic plugin dependency, `PHONIC_*` variables, fake Phonic model/tests, deploy secret docs |

---

## 2. Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | **>= 22.18** (verified on `v24.15.0`) | Runs `.ts` directly using Node's type stripping; Node 24 LTS recommended |
| npm | >= 10 (verified on `11.12.1`) | — |
| LiveKit project | — | Cloud or self-hosted server |
| Deepslate account | — | Vendor id, organization id, API key |
| Voice output | — | **Required for audio:** a Deepslate-hosted cloned voice id, or an ElevenLabs API key + voice id |

Verified versions:

| Package | Version | Why this version |
| --- | --- | --- |
| `@deepslate-labs/livekit` | `0.1.23` | Latest published plugin (peer: `@livekit/agents ^1.7.1`, `@livekit/rtc-node ^0.13.34`) |
| `@livekit/agents` | `1.9.0` | Newest release on the plugin's supported rtc-node line |
| `@livekit/rtc-node` | `0.13.35` | Matches the plugin's declared peer range |

> **Why not `@livekit/agents@1.9.3`?** That release requires `@livekit/rtc-node@^1.1.0`, while the Deepslate plugin declares `^0.13.34`. npm fails with `ERESOLVE`. `1.9.0` exposes the same `AgentSession` / `turnHandling` / `SpeechCreated` API used here, so the SDK was pinned one patch line back rather than forcing an unsupported dependency tree.
>
> `sharp` is overridden to `0.35.5` (from the `0.35.4` pinned by `@livekit/agents@1.9.0`) to clear CVE-2026-96889 / GHSA-wq5f-xc86-pv6w. `npm audit --omit=dev` reports 0 vulnerabilities with the override.

Documentation used:

- <https://docs.deepslate.eu/llms.txt>
- <https://docs.deepslate.eu/livekit-node.md>
- <https://docs.deepslate.eu/opal.md>
- <https://docs.deepslate.eu/concepts.md>

---

## 3. Install

```bash
npm install
```

## 4. Configure

```bash
cp .env.example .env
# edit .env
npm run check:env        # masked summary, LIVEKIT_URL check, voice-output check
```

| Variable | Required | Secret? | Purpose |
| --- | --- | --- | --- |
| `DEEPSLATE_VENDOR_ID` | **Yes** | No | Deepslate vendor id |
| `DEEPSLATE_ORGANIZATION_ID` | **Yes** | No | Deepslate organization id |
| `DEEPSLATE_API_KEY` | **Yes** | **Yes** | Deepslate API key |
| `DEEPSLATE_VOICE_ID` | One of the two voice options | No | Deepslate-hosted cloned voice id (enables audio) |
| `ELEVENLABS_API_KEY` | One of the two voice options | **Yes** | ElevenLabs key for server-side TTS |
| `ELEVENLABS_VOICE_ID` | With the ElevenLabs option | No | ElevenLabs voice id |
| `DEEPSLATE_TTS_PROVIDER` | No | No | `hosted` or `eleven_labs`; inferred when omitted |
| `DEEPSLATE_TTS_MODE` | No | No | `high_quality` (default) or `low_latency` (hosted only) |
| `DEEPSLATE_MODEL` | No | No | Opal model id; defaults to the platform default (`opal-v2.1`) |
| `DEEPSLATE_BASE_URL` | No | No | Defaults to `https://app.deepslate.eu` |
| `DEEPSLATE_VAD_*` | No | No | Server-side VAD tuning (see `.env.example`) |
| `LIVEKIT_URL` | **Yes** | No | `wss://<project>.livekit.cloud` |
| `LIVEKIT_API_KEY` | **Yes** | **Yes** | LiveKit Cloud key |
| `LIVEKIT_API_SECRET` | **Yes** | **Yes** | LiveKit Cloud secret |
| `LIVEKIT_AGENT_NAME` | No | No | Unset → automatic dispatch |

`.env` is gitignored; `.env.example` contains placeholders only. Credentials are only read server-side and are redacted from logs.

### Why a TTS voice is mandatory

The Deepslate Node plugin sets `audioOutput: false` and closes its audio stream when `ttsConfig` is absent (`RealtimeModel` in `@deepslate-labs/livekit@0.1.23`). Opal generates the reply; Deepslate server-side TTS turns it into PCM. With no hosted voice and no ElevenLabs credentials the agent is text-only, so this repo fails fast with an explanation instead of silently producing no audio.

---

## 5. Run and talk to it

```bash
npm run dev      # development worker (auto-reload with `lk agent dev`)
npm start        # production-style worker
```

Both connect to `LIVEKIT_URL` and register the agent. Leave `LIVEKIT_AGENT_NAME` unset for automatic dispatch (the agent joins every new room). Set it for explicit dispatch; the room token must then request that name.

### Manual live test (required for a real Opal conversation)

This is the Stage 1 acceptance test. It needs real Deepslate + LiveKit credentials and cannot be automated in CI.

1. **Configure** `.env` with the Deepslate credentials, LiveKit credentials, and one voice option. Run `npm run check:env`; it must print `Voice output: provider=...` and exit 0.
2. **Start the agent**: `npm run dev`. Expected log lines: `starting agent server` (with masked credentials), `starting worker`, `job accepted ... provider=deepslate`, `turn handling policy ...`, `agent connected to room`, `speech created`.
3. **Join a room as the participant**, using either:
   - **Browser (no extra tooling):** LiveKit Cloud → project → **Agents** → **Launch Console** → join a room and allow microphone access. With automatic dispatch the agent joins and greets you.
   - **Terminal:** install the LiveKit CLI, then `lk agent console` (local simulated room; LiveKit Cloud transport is not used in this mode).
   - **Explicit dispatch:** `lk dispatch create --agent-name <LIVEKIT_AGENT_NAME> --room <room>`, then join that room with any LiveKit client.
4. **Check audio in:** say “Hello, can you hear me?” The log should show `user state ... listening` and then `speech created` for the reply.
5. **Check audio out:** you should hear Opal's voice from the room participant. If you see `speech created` but hear nothing, check the voice-output configuration and the browser's audio output device.
6. **Check interruption:** while Opal is speaking, say “Stop — let me ask something else.” Expected: `agent state` leaves `speaking`, a new `user state`/`speech created` follows, and the old sentence does not resume. Repeat twice to confirm conversation continuation.
7. **Check failure reporting:** temporarily set an invalid `DEEPSLATE_API_KEY`, restart, and join. The log must show a redacted `session error` and the job must fail clearly, not hang silently.

Record the outcome in the final report. Do not mark this test as passed without a live run.

---

## 6. How interruption works (verified from plugin source)

`@deepslate-labs/livekit@0.1.23` was inspected directly, not assumed:

1. Deepslate's **server-side VAD** decides when the caller starts speaking (`vad.startDurationMs`, default 150 ms) and when their turn ends (`vad.stopDurationMs`, default 390 ms).
2. On barge-in the server sends `playbackBufferClear`. The plugin then emits LiveKit's **`input_speech_started`** and closes the current generation, unless the generation is `uninterruptable` (only `speakDirect(..., uninterruptable=true)` sets that).
3. LiveKit interrupts the active speech handle, flushes frames queued for playback (`AudioOutput.clearBuffer`), and cancels the generation's audio stream. The agent returns to `listening`.
4. The next response is a new generation; the old one is never resumed (`interruption.resumeFalseInterruption = false` in `src/session.ts`).
5. Deepslate truncates the model's context server-side to what was actually heard (`messageTruncation: true`; the plugin's `truncate()` is intentionally a no-op).

### Interruption limits (documented, not hidden)

- **Already-transmitted audio cannot be recalled.** Frames that left the agent over RTP or are buffered in the participant's playback path will finish. The local queue is dropped, but the remote tail is outside the agent's control.
- **The plugin does not filter late `audioChunk`s.** Its `audioChunk` handler calls `ensureGeneration()`, so audio still in flight from an interrupted response opens a **new** generation and can be scheduled. Preventing this depends on Deepslate stopping generation server-side. `tests/interruption.test.ts` records this behaviour explicitly.
- **`clearAudio()` is a no-op** and **`interrupt()` only closes the local generation**. No method claims to cancel audio server-side.
- Deepslate's VAD settings directly move the stop point. Raising `DEEPSLATE_VAD_START_MS` makes barge-in later; raising `DEEPSLATE_VAD_STOP_MS` delays the reply after the caller stops. Defaults are used unless set.
- An upstream issue in the SDK core (`deepslate-labs/deepslate-sdks#47`) notes that output audio is labelled with the *input* sample rate after a mid-session input-rate change. LiveKit's realtime session default is 24 kHz, which matches Deepslate's init rate, so the default setup does not trigger it. Do not change the input rate without re-testing pitch/speed.
- Provider **reconnection** is handled inside `@deepslate-labs/core` with exponential backoff (default 3 retries). A rejected handshake or exhausted retries is surfaced as a non-recoverable error; LiveKit then closes the session, and the next job starts fresh.

---

## 7. Tests and validation

```bash
npm test          # node --test tests/*.test.ts
npm run typecheck # tsc --noEmit
npm run check:env # config preflight (needs a filled .env)
```

What the automated suite covers (no network, no credentials, no audio devices):

- provider option resolution, VAD overrides, hosted/ElevenLabs TTS selection;
- missing/invalid credentials and missing voice output (messages contain names, never values);
- credential redaction in logs;
- real `AgentSession` + fake Deepslate model interruption lifecycle (stop, flush, cancel, continue, repeated barge-ins, uninterruptable notice, unrecoverable-error teardown);
- turn-handling policy regression.

Manual only (needs live services): steps 1–7 in section 5 — an actual Opal conversation, audible speech, and interruption.

---

## 8. Project layout

| File | Purpose |
| --- | --- |
| `src/main.ts` | Agent entry point; validates config, connects the room, starts the session, greets |
| `src/deepslate.ts` | Opal provider wiring, credential/TTS/VAD validation (provider-specific) |
| `src/session.ts` | `AgentSession` construction and pinned turn-handling/interruption policy |
| `src/agent.ts`, `src/instructions.ts` | Prompt-only agent definition |
| `src/config.ts`, `src/check-env.ts`, `src/logging.ts` | Env handling, preflight, redacted logging |
| `tests/*.test.ts` | Unit + interruption-lifecycle tests |
| `Dockerfile`, `livekit.toml`, `.github/workflows/deploy-livekit.yml` | Existing LiveKit Cloud build/deploy path (manual workflow) |

---

## 9. Stage 1 status

Established in code and offline tests:

- the official Node.js Deepslate plugin is installed and wired into the existing LiveKit agent;
- Opal is the only model in the session (no separate STT/LLM/TTS pipeline);
- Deepslate server-side TTS is required and validated, so replies are configured as real audio;
- the existing room lifecycle and interruption policy are preserved;
- interruption behaviour is tested against the real LiveKit session machinery and the plugin's actual semantics.

Not yet established here: a **live** Opal conversation. That requires Deepslate credentials plus a hosted voice id (or ElevenLabs credentials) and a LiveKit project, none of which are present in this environment. Section 5 is the manual acceptance procedure.
