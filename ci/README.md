# CI workflow templates

These are **copy-in** GitHub Actions templates. Unlike skills, workflows can't
read `.rig/config.json` at runtime — Actions run before any of that exists —
so each template is parameterized with clearly-marked `<PLACEHOLDER>` tokens,
workflow inputs, and repo `vars`/`secrets`. Fill them once when you install.

Copy the ones you want into your project's `.github/workflows/`, edit the
placeholders, add the listed secrets, and commit.

> **Companion scripts.** Some workflows call a script in the kit's `scripts/`
> (noted as `(+ scripts/…)` below). Copy those to your **repo root** `scripts/`
> — that's the path the workflows reference (`scripts/check-review-p1.ts`, etc.).
> This is a different location from the skill helper scripts, which the `onboard`
> skill / `install.sh` place in `.claude/scripts/`. If your repo keeps CI helpers
> elsewhere, update the path in the workflow to match.

## The templates

| File | What it does | Fill in | Secrets / vars |
|---|---|---|---|
| `test-gate.yml` | Path-filtered, sharded test matrix with a single aggregate gate check (what branch protection requires). | package list, setup step (bun/node), test command; optional Postgres service | — |
| `test-e2e.yml` | Playwright end-to-end via docker-compose, with layer cache. | compose file path, context dir, image tag | — |
| `security-scan.yml` | gitleaks no-new-secrets range scan + Semgrep (OWASP/TS/secrets). Optional custom trust-boundary gate. | trust-boundary path allowlist; optional custom gate script | — |
| `label-pr.yml` (+ `labeler.example.yml`) | Auto-labels PRs by changed paths and conventional-commit title. | area rules in `labeler.example.yml` → `.github/labeler.yml` | — |
| `image-build.yml` | Generic container build + push to a registry. | image name, build context, trigger paths | registry login (GHCR uses `GITHUB_TOKEN`) |
| `slack-notify.yml` | Reusable (`workflow_call`) CI Slack notifier. | — | `SLACK_CI_WEBHOOK_URL` |

## review-bot-bundle

An opinionated "AI code review + auto-fix" loop. Adopt as a set. It assumes a PR
review bot (e.g. Codex or Claude) posts inline findings, and mirrors the
`review.*` keys of your project profile.

| File | What it does | Fill in | Secrets / vars |
|---|---|---|---|
| `review-bot-gate.yml` (+ `scripts/check-review-p1.ts`) | Required check that stays red while an unresolved **P1/blocking** bot finding exists on the PR. | `<REVIEW_BOT_LOGIN>` | — (uses `GITHUB_TOKEN`) |
| `pr-review-labels.yml` (+ `scripts/pr-review-labels.ts`) | Advisory labels (`Review: Architecture`/`Sensitive Path`/`Large`) when a PR touches significant surfaces. | core-domain path globs in the script | — |
| `auto-review-fix.yml` (+ `scripts/mint-gh-app-token.sh`) | On a posted review (or trigger), runs the Claude Code CLI headless to apply feedback and pushes the fix under a least-privilege GitHub App token. | model (optional); enable marker | `CLAUDE_CI_ANTHROPIC_API_KEY` (secret), `AUTO_FIX_APP_ID` + `AUTO_FIX_INSTALLATION_ID` (vars), `AUTO_FIX_APP_PRIVATE_KEY` (secret) |

### review-bot-bundle setup

1. **Enable marker.** `auto-review-fix.yml` only runs when `.github/auto-review-fix.enabled` exists on the default branch. Create it to turn the loop on; delete it to turn it off.
2. **GitHub App (for pushing fixes).** Create a GitHub App with `contents: write` + `pull_requests: write`, install it on the repo, and set:
   - Variable `AUTO_FIX_APP_ID` = the App's ID
   - Variable `AUTO_FIX_INSTALLATION_ID` = the installation ID
   - Secret `AUTO_FIX_APP_PRIVATE_KEY` = the App's PEM private key
   `mint-gh-app-token.sh` exchanges these for a short-lived installation token so the fix commit is attributed to the App, not a human PAT.
3. **Anthropic key.** Secret `CLAUDE_CI_ANTHROPIC_API_KEY` for the headless Claude Code CLI.
4. **Bot login.** Set `<REVIEW_BOT_LOGIN>` in `review-bot-gate.yml` to your review bot's GitHub login so the P1 gate reads the right threads.

> The gate (`review-bot-gate.yml`) is safe to adopt alone. `auto-review-fix.yml` is
> the heavier piece — it writes to your repo — so it's opt-in via the marker file.

## Making the gate a required check

`test-gate.yml`'s final aggregate job (and optionally `review-bot-gate.yml`) are
designed to be the single required status in branch protection. Never mark a
check required until it has produced at least one green run on your default
branch and, if you use a merge queue, one green `merge_group` run — otherwise you
wedge merges.
