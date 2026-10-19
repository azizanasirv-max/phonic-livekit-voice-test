# Deployment workflow: create, then deploy, the same LiveKit Cloud agent

> **Native Opal STS status (2026-10-19): not available.** Deepslate Realtime API
> `0.1.23` emits text only when `tts_configuration` is omitted; the plugin derives
> `audioOutput` from `ttsConfig`. This workflow therefore still configures a TTS
> backend and must not be described as native speech-to-speech. Run
> `npm run probe:native-sts` with your credentials to verify the server behaviour
> for your account; see the root `README.md` section “Native Opal STS status”.

`deployment/deploy.yml` is the reviewed, manual-only workflow. Install it as
`.github/workflows/deploy.yml` (the `cline-cloud[bot]` GitHub App cannot write
`.github/workflows/**` without the `workflows` permission).

## Why this version creates an agent

The previous LiveKit Cloud agent was deleted. The old `livekit.toml`
(`CA_y4mXvu49sfag`) was therefore removed from this repository: keeping a dead
id would let a deploy target a non-existent agent. The first workflow run must
**create** a new agent once; every later run uses **deploy**.

The two operations are explicit `workflow_dispatch` inputs. There is no
fallback:

- `operation=deploy` requires a committed `livekit.toml` with a `CA_...` id and
  the same project subdomain as `LIVEKIT_URL`; otherwise it fails.
- `operation=create` requires `confirm_create=true` **and** the absence of
  `livekit.toml`; otherwise it fails. This avoids both the official action's
  silent no-op when the file exists and accidental duplicate agents.

## TTS: the only compatible free option

The installed `@deepslate-labs/livekit@0.1.23` accepts exactly two TTS configs
(`@deepslate-labs/core` `TtsConfig`):

- `{ provider: 'hosted', voiceId }` — requires a voice cloned in Deepslate,
  which this account does not have; and
- `{ provider: 'eleven_labs', apiKey, voiceId, modelId? }` — server-side
  ElevenLabs TTS.

So **ElevenLabs is the compatible free-tier option**. Verified from
ElevenLabs' current documentation:

- The Free plan is **$0 with 10,000 credits/month and API access**
  (<https://elevenlabs.io/pricing>).
- Free-plan output is **non-commercial and requires attribution**
  ("elevenlabs.io" or "11.ai") when published
  (<https://elevenlabs.io/docs/help-center/legal/can-i-publish-the-content-i-generate-on-the-platform>).
- **Voice Library voices are not available via the API to free-tier users**;
  use a default/premade voice or one created with Voice Design
  (<https://elevenlabs.io/docs/overview/capabilities/voices>).
- `eleven_flash_v2_5` is the ~75 ms, half-price-per-character realtime model
  (<https://elevenlabs.io/docs/overview/models>). Set it via
  `ELEVENLABS_MODEL_ID` only if your Deepslate organization accepts it; leaving
  it unset uses the provider default.

Get the `voice_id` from `GET https://api.elevenlabs.io/v1/voices` with header
`xi-api-key: <your key>`. Do not commit the key or voice id.

No code change was needed for TTS: `src/deepslate.ts` already resolves
ElevenLabs. `DEEPSLATE_HOSTED_VOICE_ID` is **optional and not required**.

## Repository secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `LIVEKIT_URL` | Yes | LiveKit Cloud project URL (`wss://<project>.livekit.cloud`) |
| `LIVEKIT_API_KEY` | Yes | LiveKit Cloud API key |
| `LIVEKIT_API_SECRET` | Yes | LiveKit Cloud API secret |
| `DEEPSLATE_VENDOR_ID` | Yes | Deepslate vendor id |
| `DEEPSLATE_ORGANIZATION_ID` | Yes | Deepslate organization id |
| `DEEPSLATE_API_KEY` | Yes | Deepslate API key |
| `ELEVENLABS_API_KEY` | Yes | ElevenLabs API key (free plan works) |
| `ELEVENLABS_VOICE_ID` | Yes | A voice available to that ElevenLabs account |
| `DEEPSLATE_MODEL` | No | Pin an Opal model |
| `DEEPSLATE_VAD_START_MS`, `DEEPSLATE_VAD_STOP_MS`, `DEEPSLATE_VAD_CONFIDENCE`, `DEEPSLATE_VAD_MIN_VOLUME`, `DEEPSLATE_VAD_BACKBUFFER_MS` | No | Server-side VAD tuning |
| `ELEVENLABS_MODEL_ID` | No | e.g. `eleven_flash_v2_5` |
| `LIVEKIT_AGENT_NAME` | No | Explicit-dispatch name; unset = automatic dispatch |
| `DEEPSLATE_HOSTED_VOICE_ID` | No | Alternative TTS path if a hosted voice is ever added |
| `SECRET_LIST` | No | Legacy only; migrated, `PHONIC_*` entries dropped |

`GITHUB_TOKEN` is provided by Actions; it is not a repository secret you add.

## First-time creation (once, because the old agent was deleted)

1. Add all required secrets above under **Settings -> Secrets and variables ->
   Actions**.
2. Install this file as `.github/workflows/deploy.yml` (GitHub UI or a token
   with `workflows` permission). Delete the obsolete
   `.github/workflows/phonic-deploy.yml` and the stray
   `.github/workflows/deploy.yml.` in the same commit.
3. Ensure `livekit.toml` is absent (this repository already removed the dead
   one). Do not create it by hand.
4. **Actions -> Create or Deploy LiveKit Cloud Agent -> Run workflow**:
   - `operation`: `create`
   - `confirm_create`: **true** (checked)
   - `region`: blank for nearest, or your region
   - `room_smoke_test`: true
5. The run registers the new agent, deploys it, writes `livekit.toml`, checks
   health, then commits `livekit.toml` back to the branch. The agent id is in
   the run summary and the `livekit-agent-config` artifact.
6. If the push is rejected (protected branch), the job fails **loudly** and the
   artifact still contains the file. Save it manually (below) before doing
   anything else. **Do not run `create` again**, or a second agent is
   registered.

## Saving the generated `livekit.toml` manually

Download the `livekit-agent-config` artifact from the run (or copy the file from
`lk agent list`/the LiveKit dashboard) and commit it to the branch you deploy
from:

```bash
# from the repository root, with the downloaded file
cp /path/to/livekit.toml ./livekit.toml
git add livekit.toml
git commit -m "Add generated LiveKit agent config"
git push
```

The file is small and contains no secrets:

```toml
[project]
  subdomain = "<your project>"

[agent]
  id = "CA_<new agent>"
```

Commit this file. It is the **only** thing that makes later runs deploy the
existing agent instead of creating another one.

## Subsequent redeployments

1. Keep the committed `livekit.toml` on the branch.
2. **Actions -> Create or Deploy LiveKit Cloud Agent -> Run workflow**:
   - `operation`: `deploy`
   - `confirm_create`: false (ignored)
   - `region`: blank or the same region
   - `room_smoke_test`: true
3. The workflow runs `OPERATION: deploy`, waits for health, checks
   `lk agent status`, optionally joins a real room, and uploads diagnostics.

Deleting `livekit.toml` disables deploy and is only correct if the agent itself
was deleted in LiveKit Cloud.

## Guardrails and diagnostics

- Deploy refuses a missing/invalid id, a project/subdomain mismatch, or
  credential material inside `livekit.toml`.
- Create refuses to run without confirmation or when `livekit.toml` exists.
  The official action exits 0 without creating anything when the file is
  present, so this preflight is required.
- `SECRET_LIST` is built from individual repository secrets; every value gets
  `::add-mask::`, only names are printed, and legacy `PHONIC_*` entries are
  dropped.
- Health is verified with `OPERATION: status-retry` (10 minutes), then
  `lk agent status`; logs are captured to the
  `livekit-deployment-diagnostics` artifact even on failure.
- The optional smoke test is a subscribe-only participant that waits for the
  deployed agent. It passes `SMOKE_EXPECT_AGENT_NAME` when
  `LIVEKIT_AGENT_NAME` is configured, so a different agent cannot make it pass.
  It proves dispatch/room connection only, not speech or barge-in.

## Runtime resilience in the agent (independent of deployment)

- The plugin's own client retries a dropped Deepslate WebSocket three times
  with backoff. If that is exhausted, `SessionSupervisor` closes the dead
  `AgentSession` and starts a fresh one at most twice per job, serialized so a
  burst of errors cannot create duplicate sessions. No greeting is replayed.
- `@livekit/rtc-node` reconnects the room itself. Reconnecting/reconnected
  events are logged; no second session is created. A terminal disconnect stops
  the session and ends the job.
- Job shutdown closes the session, so a retried job cannot overlap a stale one.
- Audio buffering uses `RoomOutputOptions.queueSizeMs = 400` (the only agent
  audio buffer the installed SDK exposes). `@livekit/rtc-node` has no jitter
  buffer option, so none is configured.

## Live acceptance still required

Automated tests cannot prove Opal's live VAD, spoken output or barge-in. After
the first deployment, run the manual console test in the root `README.md`
(section 6) with a real microphone.
