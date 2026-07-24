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
  - `AGENTS.md`, `.cursor/`, `.github/copilot-instructions.md`, `GEMINI.md`, or
    `.windsurf/` → **`agents-md`** (universal: a neutral `rig/` dir + a `## Rig`
    index injected into `AGENTS.md`; works for Codex, Cursor, Gemini, Amp, Zed,
    Jules…). If none detected, default to `claude-code`; if unsure, ask.
- **Existing `.claude/`**: note any skills/agents already present so you can warn
  before overwriting.

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
- **`agents-md`:** copy each chosen skill's `SKILL.md` → `<target>/rig/skills/<name>.md`;
  agents → `<target>/rig/agents/`; scripts → `<target>/rig/scripts/`; starter docs →
  `<target>/rig/` (if absent). Then inject an idempotent `## Rig` section into
  `<target>/AGENTS.md` (between `<!-- rig:start -->` / `<!-- rig:end -->`
  markers — replace any existing block, don't duplicate) that lists each
  installed skill with its one-line description and trigger phrases and says
  "read `rig/skills/<name>.md` and follow it", plus a note that subagent-less
  agents should adopt the `rig/agents/` personas inline. Set
  `review.patternsFile` in the profile to `rig/REVIEWER.md` for this target.

## 5. Offer CI (optional, gated on consent)

If the user wants CI, follow `RIG_DIR/ci/README.md`: copy the chosen workflow
files into `<target>/.github/workflows/`, substitute the parameters from the
profile, and **print the full list of GitHub secrets/vars each workflow
requires** so the user can add them. Do not invent secret values. The AI
review-bot bundle additionally needs a GitHub App token — point at
`ci/README.md#review-bot-bundle` for the setup.

## 5b. Offer Smithers durable orchestration (optional, gated on consent)

[Smithers](https://smithers.sh) is a **separate, complementary** tool — a
crash-resistant AI-workflow orchestrator (multi-step runs persisted to SQLite,
resumable after a crash, human-approval gates). Rig gives you the conventions;
Smithers gives you a durable engine to *run* the long, multi-step ones. It's
**heavier** (~70 files under `.smithers/`, its own deps) and needs a JS runtime,
so it is strictly opt-in — never install it unless the user says yes.

- **Gate:** offer this only if a JS runtime is present (`bun` preferred, else
  `node`/`npx`). If neither, skip and say so.
- **On opt-in**, run in the target (or just `install.sh --with-smithers`):
  ```bash
  bunx smithers-orchestrator init --yes --no-tutorial      # or: npx … --no-tutorial --no-install
  ```
  ⚠️ The package is `smithers-orchestrator`, **not** `smithers`. `init`
  scaffolds `.smithers/` and (via its default `--skill`) installs a `smithers`
  skill into the detected coding agent(s) and appends usage guidance to an
  existing `AGENTS.md`/`CLAUDE.md`. Tell the user `.smithers/` is a real,
  committable addition to their repo.
- **Wire them together:** if `.smithers/smithers.config.ts` exists, set its
  `repoCommands.test` (and `lint`/`coverage` if known) from the Rig profile's
  `test.command` so both tools share one source of truth.
- The Smithers skill and Rig skills coexist at different layers — Rig skills are
  task-level procedures; the Smithers skill teaches the agent to drive the
  Smithers CLI. No conflict.

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
