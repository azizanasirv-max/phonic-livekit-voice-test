# Deployment workflow activation

`deployment/deploy.yml` is the repaired deployment workflow. It is kept here,
rather than in `.github/workflows/`, because the GitHub App used for this task
(`cline-cloud[bot]`) lacks the GitHub `workflows` permission. Pushes that touch
`.github/workflows/**` are rejected by GitHub:

```
! [remote rejected] ... (refusing to allow a GitHub App to create or update
workflow `.github/workflows/deploy.yml` without `workflows` permission)
```

This is a permission control, not a code problem. It was **not** bypassed.

## Activate it (repository administrator)

```bash
# 1. Install the repaired workflow as the only deploy workflow.
cp deployment/deploy.yml .github/workflows/deploy.yml
git rm .github/workflows/phonic-deploy.yml '.github/workflows/deploy.yml.'

# 2. Commit and push with a token that has the `workflows` permission.
git add .github/workflows
git commit -m "Deploy the existing LiveKit agent with Deepslate Opal"
git push

# 3. Run it manually (Actions -> Deploy LiveKit Cloud Agent -> Run workflow).
gh workflow run deploy.yml --ref <branch>
```

Do **not** dispatch the old `phonic-deploy.yml`: its preflight requires the
removed provider's API-key secret and it would ship this code without the
Deepslate configuration.

## Required repository secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `LIVEKIT_URL` | Yes | Existing LiveKit Cloud deployment credential |
| `LIVEKIT_API_KEY` | Yes | Existing LiveKit Cloud deployment credential |
| `LIVEKIT_API_SECRET` | Yes | Existing LiveKit Cloud deployment credential |
| `DEEPSLATE_VENDOR_ID` | Yes | Deepslate vendor id |
| `DEEPSLATE_ORGANIZATION_ID` | Yes | Deepslate organization id |
| `DEEPSLATE_API_KEY` | Yes | Deepslate API key |
| `DEEPSLATE_HOSTED_VOICE_ID` | One TTS path | Deepslate-hosted voice |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | Alternative TTS path | ElevenLabs voice |

Optional: `DEEPSLATE_MODEL`, the `DEEPSLATE_VAD_*` tuning variables,
`ELEVENLABS_MODEL_ID`, `LIVEKIT_AGENT_NAME`.

The workflow still understands the legacy `SECRET_LIST` secret, migrates any
useful entries and drops removed-provider entries. Individual secrets win.

## What the workflow preserves

- Project subdomain and agent id are read from the committed `livekit.toml`
  (`shopify-execution-fwmg7op6`, `CA_y4mXvu49sfag`). It never regenerates the
  file and never uses the LiveKit `create` operation.
- Deployment is `livekit/deploy-action` `OPERATION: deploy`, followed by
  `status-retry`, `lk agent status`, an optional real-room join smoke test, and
  bounded `lk agent logs` collection.
