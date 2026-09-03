# Rig on pi

[pi](https://pi.dev) is a coding agent with no built-in subagents — delegation is
an extension you opt into. That makes it a good fit for Rig: Rig's skills already
name roles indirectly (`agents.reviewer`, `agents.coder`) so they can delegate
where a harness supports it and degrade to inline personas where it doesn't. On
pi, with [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) installed,
that indirection resolves to real delegation with isolated context per role.

## What you get

| Piece | Where it lands | Why |
|---|---|---|
| Skills | `.agents/skills/<name>/` | pi scans project `.agents/skills/` natively — no index, no registration |
| Personas | `.pi/agents/rig-*.md` | `pi-subagents` reads agent definitions from `.pi/agents/` |
| `/rig` dispatcher | `.pi/prompts/rig.md` | wires each skill's `agents.*` roles to the `subagent` tool |
| Scripts, `REVIEWER.md`, `STYLE.md` | `.rig/` | one rig home for what no standard covers |
| Delegation extension | `.pi/settings.json` → `npm:pi-subagents` | pi installs it on startup once the project is trusted |
| Project profile | `.rig/config.json` | same file every target reads |

## Install

```bash
~/dev/rig/install.sh --target pi <target-project>
```

`pi` is auto-detected when the project has a `.pi/` directory, so a plain
`install.sh <project>` picks it up too. Combine targets freely —
`--target claude-code,pi` is a normal setup for a repo worked on from both.

Then start pi in the project and **approve the project-local files** — pi only
reads `.pi/` and project `.agents/skills/` after the project is trusted. On
startup it installs the packages listed in `.pi/settings.json`.

Or let the agent do it: run `/rig-onboard` (the interactive path — it detects the
stack, fills the profile, and asks before copying anything).

### Installing the kit as a pi package

The repo also carries a `pi` manifest, so you can install Rig's skills and the
`/rig` prompt globally instead of copying them per project:

```bash
pi install git:github.com/agent-rig/rig
pi install npm:pi-subagents
```

This is a real alternative for the *skills* layer, and `pi update` then pulls kit
improvements without re-running onboarding. It is **not** a complete setup: the
personas (`.pi/agents/`), the project profile (`.rig/config.json`), the review
catalog, the scripts, and CI still have to be delivered into the project, because
they're per-project or live where no standard reaches. Run `install.sh --target
pi` (or `/rig-onboard`) for those either way.

## Using it

```
/rig review find          # read-only gate: catalog + scope invariants vs the diff
/rig review fix 123       # drive PR review feedback to convergence
/rig task ABC-123         # ticket -> worktree -> code -> review -> PR
/rig debug                # the four-phase root-cause protocol
/rig plan | tidy | spike | sprint | epic | issue | worktree | doctor
```

`/rig <skill> [args]` reads the profile, reads the skill, and applies the
delegation contract in `.pi/prompts/rig.md`: children get concrete
self-contained tasks, children don't delegate further, read-only roles stay
read-only, one writer per worktree, and fixed sequences go through
`workflowScript` while convergence loops keep the parent session as controller.

You can also reach a skill directly, without the delegation wiring, via pi's own
skill commands (`/skill:rig-review`) when `enableSkillCommands` is on. That's the
right move for the read-only skills; use `/rig` for anything that fans out.

Without `pi-subagents`, everything still works — `/rig` announces which persona
it's wearing and adopts it inline, which is exactly how the skills are written to
degrade.

## Personas: what changed and what didn't

The persona *body* — the system prompt itself — is shared with every other
target and lives once, in `agents/<name>.md`. Only the frontmatter is
pi-specific, in `pi/agents/<name>.yml`; `install.sh` assembles the two. See
[`pi/agents/README.md`](../pi/agents/README.md) for the full mapping table.

The three deltas worth knowing:

- **Tool names.** pi's built-ins are `read`, `bash`, `edit`, `write`, `grep`,
  `find`, `ls`. `Glob` becomes `find`. `WebFetch`, `WebSearch`, `TodoWrite`, and
  `LSP` have no pi built-in and are dropped — the persona bodies already treat
  LSP as "when available" and fall back to grep, and web access degrades to
  `bash` + `curl`.
- **No `Task` for children.** Children don't spawn children; this session
  orchestrates. `rig-architect` and `rig-reviewer` also have no `write`/`edit`,
  which is what makes "they report, they don't fix" structural rather than
  aspirational.
- **Model tier → thinking level.** Rig's `model: opus | sonnet` is
  Claude-specific and would break on any other provider (pi's default is
  whatever you've configured). It maps to `thinking: high` for `rig-architect`,
  `rig-reviewer`, and `rig-debugger` (its four-phase protocol is reasoning-bound,
  so it's raised from the Claude-side `sonnet`), and `thinking: medium` for
  `rig-coder` and `rig-qa`.

To pin actual models per role, add `model:` to the assembled
`.pi/agents/<name>.md` — provider-qualified, e.g.
`model: anthropic/claude-opus-4-5` — or use `pi-subagents`' own per-role model
overrides and profiles. Keep that in the project, not in the kit: the kit can't
know which providers you have.

## Config notes

For this target set, in `.rig/config.json`:

- `review.patternsFile`: `.rig/REVIEWER.md`
- `style.guideFile`: `.rig/STYLE.md`
- `tracker.labelMapFile`: `.rig/label-mapping.md`
- `agents.*`: leave unset unless you renamed a persona — the defaults are
  `rig-<role>`, matching what lands in `.pi/agents/`.

## Limitations

- `pi-subagents` is a third-party extension on a fast release cadence. Rig
  depends on three things from it: agent definitions in `.pi/agents/`, the
  `subagent` tool, and `workflowScript`. If a release moves any of those, the
  `/rig` dispatcher is the one file to update.
- `intercom` (child → parent escalation) appears in four personas' tool lists and
  only exists when `pi-subagents` is installed. Harmless otherwise — pi ignores
  unknown names in a definition it isn't reading in the first place.
- CI templates are still copy-in (`ci/README.md`). GitHub Actions files must
  physically live in `.github/workflows/`; no plugin model changes that.
