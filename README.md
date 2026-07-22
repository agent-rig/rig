# Rig

A **copy-in** kit of battle-tested Claude Code skills, agents, and CI workflow
templates — extracted from a production Bun/monorepo so any project can adopt
them. Nothing here is hardwired to the origin project: every project-specific
value (test command, issue tracker, base branch, review bot, source layout) is
read at runtime from a small **project profile** you fill in during onboarding.

## What's in the box

| Layer | Contents | How it's delivered |
|---|---|---|
| **Skills** (`skills/`) | `rig-debug`, `rig-spike`, `rig-tidy`, `rig-issue`, `rig-worktree`, `rig-review` (`find`/`fix`), `rig-task`, `rig-sprint`, `rig-epic` | Copied into `<project>/.claude/skills/` |
| **Agents** (`agents/`) | `rig-debugger`, `rig-reviewer`, `rig-architect`, `rig-qa`, `rig-coder` | Copied into `<project>/.claude/agents/` |
| **Support docs** (`templates/`) | starter `REVIEWER.md` (+ `REVIEWER.scope-template.md`), `label-mapping.md` | Copied into `<project>/.claude/` (only if absent) |
| **Scripts** (`scripts/`) | `setup-worktree.sh`, `remove-worktree.sh`, `mint-gh-app-token.sh`, `scope-reviewer.ts` | Copied into `<project>/.claude/scripts/` |
| **CI templates** (`ci/`) | `security-scan`, `label-pr`, `image-build`, `slack-notify`, `test-gate`, `test-e2e`, and the **AI review-bot bundle** (`review-bot-gate`, `auto-review-fix`, `pr-review-labels`) | Copied into `<project>/.github/workflows/` (see `ci/README.md`) |
| **Onboarding** (`skills/rig-onboard/`) | The agent-driven installer skill | Run once against a target project |

## Works with your agent (not just Claude Code)

Skills are just markdown procedures — portable content. Only the *placement,
format, and invocation* differ per agent, so install/onboarding delivers Rig in
your agent's own conventions via **targets** (auto-detected from repo markers):

| Target | Delivered as | Covers |
|---|---|---|
| **`claude-code`** | `.claude/skills/<name>/`, `.claude/agents/`, `.claude/scripts/` (native skills + subagents) | Claude Code |
| **`agents-md`** | a neutral `rig/` dir + an idempotent `## Rig` index injected into `AGENTS.md` ("read `rig/skills/<name>.md` and follow it") | Codex, Cursor, Gemini, Amp, Zed, Jules — any `AGENTS.md`-reading agent |

For agents without subagents, the `rig/agents/` personas are adopted **inline**
rather than delegated — the skills reference roles through the `agents.*`
indirection, so they degrade cleanly. Pick targets explicitly with
`install.sh --target claude-code,agents-md`, or let detection choose.

## Simplest onboarding (zero setup)

Open Claude Code **in the project you want to onboard** and paste one line:

> Onboard this repo into Rig by following
> `https://github.com/agent-rig/rig/blob/main/skills/rig-onboard/SKILL.md`

Claude fetches that onboarding skill, clones the kit to a temp dir, **detects
your stack** (package manager, test command, base branch, issue tracker, review
bot), asks only what it can't infer, writes `.rig/config.json`, and copies
in the skills, agents, and scripts you pick — offering CI workflows separately
with the exact secrets each needs. Nothing is installed globally and nothing is
committed for you; you review the changes and commit. That's the whole path — no
clone, no config editing, no prior install.

## Other ways in

- **Keep a local copy of the kit** (handy if you'll onboard several repos):
  ```bash
  git clone https://github.com/agent-rig/rig ~/dev/rig
  ```
  then in your project just say `/rig-onboard` — it finds `~/dev/rig` automatically.
- **No agent at all:** `~/dev/rig/install.sh <target-project>` copies the
  default set and drops a config stub for you to edit by hand. It auto-detects
  your agent target(s); override with `--target claude-code,agents-md`.

## The project profile

Everything parameterizable is driven by **`.rig/config.json`** in your
project. Skills read it at runtime — they never hardcode your specifics. See
[`docs/config.md`](docs/config.md) for every knob, `rig.schema.json` for
the machine-readable schema, and `rig.config.example.json` for a filled-in
reference (the origin project's own values).

## Design principles

- **Config over forking.** A parameterizable skill reads `.rig/config.json`
  rather than being edited per project. Update the kit → re-run onboarding → get
  the improvement without re-diffing your local edits.
- **Graceful degradation.** `tracker.provider: "none"` strips all ticket steps;
  `review.bot: "none"` turns `rig-review fix` into a local-only loop. A skill never
  hard-fails because a project doesn't use a given tool.
- **CI is copy-in, not a plugin.** GitHub Actions files must physically live in
  `.github/workflows/`, so they're delivered as parameterized templates with an
  install guide, not as a runtime dependency.
- **Review knowledge compounds where the code is.** The review catalog is a
  tree of `REVIEWER.md` files (root repo-wide lenses + per-subsystem invariants
  colocated with the code, mirroring nested `AGENTS.md`). `rig-review` resolves
  the scoped files a diff touches and asserts them as P1s, so a subsystem's
  hard-won invariants stop getting re-discovered in PR review.

## License

MIT — see [`LICENSE`](LICENSE).
