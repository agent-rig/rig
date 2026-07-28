# The auto-fix GitHub App

The [`auto-review-fix.yml`](../ci/workflows/auto-review-fix.yml) workflow (see
[`ci/README.md#review-bot-bundle`](../ci/README.md#review-bot-bundle)) pushes its
fix commits under a **dedicated GitHub App**, not the default `GITHUB_TOKEN`.
This page is the click-by-click to create that App and wire it up.

## Why an App (not `GITHUB_TOKEN`)

GitHub deliberately **suppresses workflow runs on commits pushed by
`GITHUB_TOKEN`** (anti-recursion). A fix pushed that way lands its checks in
`action_required`, waiting for a human to click *"Approve and run"* — which
defeats a hands-off loop. A push authenticated by a **GitHub App installation
token** triggers the review bot's re-review and all downstream checks normally.
The App is least-privilege (three repo perms), single-repo, and revocable.

---

## For the human — create + install the App (~5 min)

You need repo admin (or org owner) to create and install an App.

1. **New App.** Go to **<https://github.com/settings/apps>** → **New GitHub App**.
   (Org-owned repo: **Org → Settings → Developer settings → GitHub Apps → New GitHub App**.)
2. **Name** it, e.g. `<repo>-auto-review-fix`. **Homepage URL:** your repo URL (any valid URL).
3. **Webhook:** **uncheck "Active"** — this App only mints tokens; it receives no webhooks.
4. **Repository permissions** (leave everything else *No access*):
   - **Contents:** Read and write  — push the fix commit
   - **Pull requests:** Read and write  — comment / re-trigger the bot
   - **Issues:** Read and write  — the issue-comment trigger path
5. **Where can this GitHub App be installed?** → **Only on this account.**
6. **Create GitHub App.** On the App's page, note the **App ID** (near the top) → this is `AUTO_FIX_APP_ID`.
7. **Private key.** Scroll to **Private keys → Generate a private key** — a `.pem` downloads.
   This is `AUTO_FIX_APP_PRIVATE_KEY`. Store it as a secret; never commit it.
8. **Install.** App page → **Install App** (left nav) → your account → **Only select repositories**
   → pick the target repo → **Install**.
9. **Installation ID.** After installing you land on
   `https://github.com/settings/installations/<INSTALLATION_ID>`
   (org: `…/organizations/<org>/settings/installations/<INSTALLATION_ID>`).
   The trailing number is `AUTO_FIX_INSTALLATION_ID`.

## Add the repo secrets + variables

**Repo → Settings → Secrets and variables → Actions.**

| Kind | Name | Value |
|---|---|---|
| Secret | `AUTO_FIX_APP_PRIVATE_KEY` | contents of the `.pem` (or its base64) |
| Variable | `AUTO_FIX_APP_ID` | the App ID (step 6) |
| Variable | `AUTO_FIX_INSTALLATION_ID` | the Installation ID (step 9) |
| Secret | `CLAUDE_CI_ANTHROPIC_API_KEY` | an Anthropic API key for the headless CLI (BYOK) |
| Variable | `REVIEW_BOT_LOGIN` *(optional)* | your review bot's login, so only its reviews trigger the fix — **Cursor Bugbot → `cursor[bot]`**. Omit to run on any submitted review. |

> Prefer a key **dedicated to CI** for `CLAUDE_CI_ANTHROPIC_API_KEY`, so agent
> spend is budgeted and revocable on its own.

## Turn it on

The workflow is **opt-in** via a marker file — commit an empty file on the
**default branch**:

```bash
touch .github/auto-review-fix.enabled
git add .github/auto-review-fix.enabled
git commit -m "ci: enable auto-review-fix"
git push
```

Delete the marker to turn it off. The gate reads the marker on `origin/main`, so
the loop is controlled from the default branch, not from a PR branch.

## Match your review bot

`auto-review-fix.yml` drives whatever bot `review.bot` names in
`.rig/config.json`. Set `REVIEW_BOT_LOGIN` to that bot's **review author login**:

| `review.bot` | `REVIEW_BOT_LOGIN` | re-trigger (`review.botRetrigger`) |
|---|---|---|
| `bugbot` (Cursor Bugbot) | `cursor[bot]` | `bugbot run` |
| `codex` | the login the connector posts reviews under (identity regex `chatgpt-codex-connector`, see `skills/rig-review`) | `@codex review` |
| `claude` | the bot's review login | its trigger phrase |

> **Bugbot note.** On a *clean* PR, Bugbot posts **no review** — it only completes
> a `Cursor Bugbot` **check-run** — so the fix workflow simply doesn't fire, which
> is correct. Bugbot also posts an *empty* review object alongside its findings
> review; with `REVIEW_BOT_LOGIN=cursor[bot]` that empty review may trigger one
> harmless no-op run (the `/rig-review fix` loop finds nothing and exits).

## Verify

Open a PR and let the bot review it. In **Actions**, `auto-review-fix` runs
`gate → fix`; a fix commit appears on the PR branch attributed to your App, and
the bot re-reviews. If `fix` **fails fast** with *"Missing required CI
credentials"*, one of the secrets/vars above is unset.

## Security posture

- **Least privilege:** three repo permissions, single-repo install, no webhooks.
- **Revocable:** delete the App (or its installation) to stop it instantly; the
  marker file toggles the loop without touching credentials.
- **Fixing is not merging:** branch protection + required checks still gate the
  actual merge — this only drives review feedback to clean.
