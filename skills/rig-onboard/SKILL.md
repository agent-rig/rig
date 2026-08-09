---
name: rig-onboard
description: Onboard the current project into Rig — detect the stack, fill a project profile, and copy in the skills, agents, scripts, and CI workflows you choose. Triggers on 'onboard', 'set up rig', 'install rig', 'adopt these skills', 'onboard me into the skills'.
---

# Rig onboarding

You are onboarding **the current working project** (the "target") into Rig.
Your job is to detect what the project is, agree a **project profile** with the
user, copy in the pieces they want, and leave them with a working, documented
setup. Be interactive but efficient — detect aggressively, ask only what you
cannot infer.

## 0. Locate the kit (`RIG_DIR`)

The kit lives in a directory (`RIG_DIR`) separate from the target project — you
copy files *out of* it. Resolve `RIG_DIR` in this order:

1. An explicit local path in the invocation args.
2. This skill's own location (`.../rig/skills/rig-onboard/`) → `RIG_DIR` is two
   levels up (the repo root that contains `skills/`, `agents/`, `ci/`).
3. `~/dev/rig`, then `~/rig`.
4. **Remote (the zero-setup path).** If none of the above exist — which is the
   case when the user just pointed you at a GitHub URL for this skill — clone the
   kit to a temp dir and use that as `RIG_DIR`:

   ```bash
   RIG_DIR="$(mktemp -d)/rig"
   git clone --depth 1 <RIG_REPO_URL> "$RIG_DIR"
   ```

   Derive `<RIG_REPO_URL>` from the URL you were given: strip any
   `/blob/<branch>/…` or `raw.githubusercontent.com/…` suffix back to the repo
   root (e.g. `https://github.com/agent-rig/rig`). Cloning is strongly
   preferred over fetching files one-by-one — the kit is ~40 small text files
   and a shallow clone grabs them all at once. If `git` isn't available, fall
   back to fetching individual raw files as you need them.

Then confirm the resolved `RIG_DIR` with the user before copying anything.
Never copy a file onto itself — if the target project *is* the kit, stop and say so.

## 1. Detect the stack (no questions yet)

Read, don't ask. Gather:

- **Runtime / package manager**: presence of `bun.lockb`/`bunfig.toml` → bun;
  `pnpm-lock.yaml` → pnpm; `yarn.lock` → yarn; `package-lock.json` → npm; else
  inspect `package.json`. Note the monorepo tool (`turbo.json`, `nx.json`,
  workspaces) and package layout (`packages/*`, `apps/*`).
- **Test command**: read `package.json` scripts (`test`, `test:integration`,
  `test:e2e`). Detect whether tests boot a database (docker in test setup,
  `testcontainers`, a `test-setup.ts` preload, a Postgres dep).
- **VCS**: `git remote get-url origin` → `project.repo`; `git symbolic-ref
  refs/remotes/origin/HEAD` or the default branch → `vcs.defaultBranch` +
  `vcs.baseRef`. Check branch protection / merge queue only if `gh` is available.
- **Tracker**: is a Linear MCP server connected? Do existing branch names /
  recent PR titles carry a ticket prefix (e.g. `ABC-123`)? If neither, default
  `tracker.provider: "none"`.
- **Review bot**: scan recent PRs (if `gh` available) for a bot reviewer
  ("codex", "claude"). Otherwise `review.bot: "none"`.
- **Agent(s) / delivery target**: which coding agent does this project use? Map
  from repo markers to delivery **targets** (may be more than one):
  - `.claude/` or `CLAUDE.md` → **`claude-code`** (native: `.claude/skills/`,
    `.claude/agents/`).
  - `AGENTS.md`, `.agents/`, `.cursor/`, `.github/copilot-instructions.md`,
    `GEMINI.md`, or `.windsurf/` → **`agents-md`** (universal: skills land in
    `.agents/skills/<name>/` — the standard cross-agent "Agent Skills" layout
    that Codex, Cursor, Gemini CLI, Copilot, and Rovo Dev auto-discover
    natively, so no per-skill index file is needed; agents/scripts/review
    patterns stay under `.rig/`, the same home as the config profile, since
    nothing else standardizes those; plus a minimal `## Rig` pointer block
    injected into `AGENTS.md`). If none detected, default to `claude-code`; if
    unsure, ask.
- **Existing `.claude/` or `.agents/skills/`**: note any skills/agents already
  present so you can warn before overwriting. Also check for a legacy
  `.rig/skills/*.md` flat-file layout from a pre-`.agents/skills/` onboarding —
  see "Re-running" below.

Summarize what you found in a short table before moving on.

## 2. Fill the profile (ask only the gaps)

Present the detected values and ask the user to confirm or correct. Only surface
questions you genuinely couldn't infer. The knobs are defined in
`RIG_DIR/rig.schema.json` and documented in `RIG_DIR/docs/config.md`; the
important ones to settle:

- `test.command` (+ integration/e2e/requiresDatabase)
- `sourceScope` (default path skills operate on)
- `vcs.baseRef`, `vcs.defaultBranch`, `vcs.protectedBranchMergeQueue`
- `tracker.provider` and, if not "none": team, project, `ticketPrefix`,
  `githubIntegration`
- `review.patternsFile`, `review.bot` (+ `botRetrigger` if a bot)

Do **not** ask about `agents` overrides unless the user already has agents with
clashing names — the defaults are the kit's own `rig-<role>` agents.

## 3. Pick the pieces

Show the menu (from `RIG_DIR/README.md`) and let the user choose. Recommend a
default set based on detection:

- **Always useful**: `rig-debug`, `rig-tidy`, `rig-spike`, `rig-review` + agents
  `rig-debugger`, `rig-reviewer`, `rig-architect`.
- **If a tracker is configured**: `rig-issue`, `rig-sprint`, `rig-epic` (the
  multi-item integration-branch arc; also works tracker-less via its state file).
- **If the project uses PRs / worktrees**: `rig-worktree`, `rig-task` (the
  end-to-end ticket→PR orchestrator; `rig-sprint` calls it) + agents `rig-qa`,
  `rig-coder`. (`rig-review` — always useful above — carries both the `find`
  gate and the `fix` loop.)
- **CI**: offer the workflow templates separately (Step 5) — they're heavier and
  need secrets.

## 4. Write the profile and deliver the skills (per target)

First write the shared, agent-agnostic profile: **`.rig/config.json`** in the
target from the agreed values (include `"$schema"` pointing at the kit schema).

Then deliver for **each** target from Step 1. The mechanical path is
`RIG_DIR/install.sh --target <t1,t2> <target> <skills…>` — you may just run it;
or do the copies yourself as below. Either way, **never overwrite** an existing
skill/agent/catalog without diff-and-confirm.

- **`claude-code`:** copy chosen `RIG_DIR/skills/<name>/` →
  `<target>/.claude/skills/<name>/`; `RIG_DIR/agents/*.md` →
  `<target>/.claude/agents/`; `RIG_DIR/scripts/*` → `<target>/.claude/scripts/`
  (`chmod +x`); and starter `REVIEWER.md` / `label-mapping.md` →
  `<target>/.claude/` **only if absent**.
- **`agents-md`:** skills are delivered as full directories — copy each chosen
  `RIG_DIR/skills/<name>/` → `<target>/.agents/skills/<name>/` (same shape as
  the `claude-code` copy, just a different root). This is the location the
  target agent already scans on its own, so **no per-skill index or "read and
  follow" pointer is written** — the agent auto-discovers each skill from its
  `SKILL.md` frontmatter `description`. Everything the standard doesn't cover
  keeps living under `.rig/` (the same dir as the shared config profile, so
  there's still one rig home for non-skill pieces): agents →
  `<target>/.rig/agents/`; scripts → `<target>/.rig/scripts/`; starter docs
  (`REVIEWER.md`, `label-mapping.md`) → `<target>/.rig/` (if absent). Then
  inject/refresh an idempotent `## Rig` section into `<target>/AGENTS.md`
  (between `<!-- rig:start -->` / `<!-- rig:end -->` markers — replace any
  existing block, don't duplicate). Keep this block short: a pointer to
  `.rig/config.json` for project settings, and a note that subagent-less
  agents should adopt the `.rig/agents/` personas inline — it no longer
  enumerates skills. Set `review.patternsFile` in the profile to
  `.rig/REVIEWER.md` for this target.

## 5. Offer CI (optional, gated on consent)

If the user wants CI, follow `RIG_DIR/ci/README.md`: copy the chosen workflow
files into `<target>/.github/workflows/`, substitute the parameters from the
profile, and **print the full list of GitHub secrets/vars each workflow
requires** so the user can add them. Do not invent secret values. The AI
review-bot bundle additionally needs a GitHub App token — do the copy-and-wire
yourself, then hand the human `docs/auto-fix-app.md` (the click-by-click App +
secrets setup you can't do for them). See `ci/README.md#review-bot-bundle`.

## 6. Verify and summarize

- Sanity-check: `.rig/config.json` parses; every copied skill's config
  references resolve; scripts are executable.
- If the target is a git repo you did not create, **do not commit** — leave the
  changes staged/unstaged for the user to review, and tell them what changed.
- Print a summary: profile written, skills/agents/scripts installed, CI
  workflows added (+ required secrets), and 3 suggested first commands to try
  (e.g. `/rig-debug`, `/rig-review`, `/rig-tidy`).

## Re-running

Onboarding is idempotent-ish: re-running detects the existing
`.rig/config.json`, offers to update it, and only copies pieces that are
missing or that the user explicitly asks to refresh. Use it to pull kit updates.

Projects onboarded before this change may still have the old flat
`.rig/skills/<name>.md` files and a `## Rig` block that lists them by name.
Re-running onboarding delivers skills into `.agents/skills/<name>/` and
replaces the `## Rig` block (it's idempotent between the markers), but it will
**not** delete the old `.rig/skills/*.md` files on its own — `copy_no_clobber`
and the rest of the install path only ever add files, never remove them. Point
this out in your Step 1 summary and Step 6 wrap-up, and — because you're
interactive and a human is present to confirm — offer to delete the now-dead
`.rig/skills/` directory for them. Don't delete it silently, and don't do this
from `install.sh` (non-interactive, no consent to delete).
