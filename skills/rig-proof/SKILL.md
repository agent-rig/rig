---
name: rig-proof
description: "Proofread agent-written prose against the project's writing-style guide. `find` (default): flag buried conclusions, passive voice, hedging, filler, jargon, and unanchored claims in a PR body, ticket, review finding, plan, writeup, or changed Markdown — read-only. `fix`: rewrite it in place. Triggers on: 'proofread', 'check the writing', 'is this readable', 'tighten this up', 'check style', 'style check', 'review the PR body', 'clean up this ticket', 'make this clearer', 'rewrite this so it reads well'."
argument-hint: "[find | fix] [<file> | <PR> | --stdin | --base <ref>] — default 'find' (read-only); 'fix' rewrites"
allowed-tools: [Bash, Read, Edit, Grep, Glob]
---

# rig-proof — proofread what an agent wrote

Two verbs over one source of truth:

- **`find`** (default) — check prose against the project's writing-style guide
  and return findings with line references. **Read-only.**
- **`fix`** — apply them, then re-check.

**The guide is the only rulebook.** Its path is `style.guideFile` in
`.rig/config.json` (default `.claude/STYLE.md`). This skill has no style
opinions of its own: read the guide, walk its rules, cite them by number. When a
project prunes or extends the guide, this skill follows automatically — the same
relationship `/rig-review` has to `REVIEWER.md`.

## Why this exists

The personas already tell agents how to write. Instructions decay under load: an
agent 40 tool-calls deep, writing the PR body last, has spent its attention
elsewhere. This is the gate that catches what the instruction missed — the same
reason `/rig-task` runs a pre-PR self-review instead of trusting that the coder
internalized the review catalog.

## Configuration

Reads `.rig/config.json`:

- `style.guideFile` — the writing-style guide, and the only rule source
  (default `.claude/STYLE.md`, then `.rig/STYLE.md`). **If no guide is found,
  say so and stop** — don't substitute your own preferences.
- `vcs.baseRef` — diff base when checking changed Markdown (default
  `origin/main`).
- `project.repo` — `owner/name` for `gh` calls when the target is a PR.

## Scope — what to check, and what to leave alone

Default to **one named target**. This skill is a proofreader, not a repo-wide
linter; pointing it at every document in the tree produces a finding pile nobody
asked for.

Resolve `$ARGUMENTS` to a target in this order:

| Argument | Target |
|---|---|
| a file path | that file |
| `--stdin`, or prose pasted into the request | that text |
| a PR number, or `pr` | the PR body (`gh pr view <n> --json body -q .body`) |
| an issue/ticket ID | that ticket's description |
| `--base <ref>`, or `diff` | Markdown files changed vs `<ref>` |
| nothing | ask what to check — don't guess, and don't default to the repo |

**Never check code.** Source files are out of scope: identifiers and comments
follow the conventions of the code around them, not a prose guide. Skip
generated files, vendored directories, and `CHANGELOG.md`.

**Only sweep the whole repo when the user explicitly asks for it.** Report
per-file counts first and let them pick where to start. Don't dump every
finding at once.

---
# `find` — the read-only pass

1. **Read the guide.** Resolve `style.guideFile`, read it, and keep its rule
   numbers — every finding cites one.

2. **Run the mechanical pass first.** It costs nothing and it removes the
   word-spotting work from your plate:

   ```bash
   <SCRIPT> --json <target-file>        # or: … --stdin  (text on stdin)
   ```

   where `<SCRIPT>` = `.claude/scripts/check-style.ts` if present, else
   `.rig/scripts/check-style.ts`, else `<RIG_DIR>/scripts/check-style.ts` (run
   with `bun`). It harvests the banned terms **from the guide itself** and greps
   for them, plus flags over-long sentences. Code, fenced blocks, and link
   targets are masked, so it never flags a snippet.

   Its findings are **candidates, not verdicts.** `just`, `simple`, and
   `obvious` have legitimate uses; a 34-word sentence can be the clearest way to
   say something. Triage each one — you're the judgment the script doesn't have.
   Drop a candidate that reads fine and say nothing about it.

   If the script is missing or reports 0 harvested terms, do the whole pass
   yourself and note that the mechanical half didn't run.

3. **Read the prose yourself** for what no grep catches. This is the half that
   matters:

   - **Buried conclusion.** Does the first sentence carry the answer, or does
     the reader wade through process narration to reach it? This is the most
     common defect and the most expensive.
   - **Passive voice** where the actor matters — especially in a sentence the
     reader has to act on.
   - **Hedge stacks.** `it seems like it might possibly` — either go check, or
     say plainly that you didn't.
   - **Unanchored claims.** An assertion about the code with no `file:line`,
     command, count, or SHA behind it.
   - **Unmarked guesses.** Something inferred, presented as observed.
   - **Structure.** Three-plus parallel items still in a paragraph; a
     comparison that wants a table; ordered steps in prose.
   - **Self-narration** — preamble, apology, closing offer of further help.
   - **Untestable acceptance criteria**, when the target is a ticket.
   - Anything else the guide's rules call for that the script can't see.

4. **Report.** Lead with the verdict, then findings in document order. One entry
   per finding, each citing the guide rule and the line:

   ```
   3 findings — 2 that change how it reads, 1 nit

   12:1  [rule 1: answer first] The verdict is in the last paragraph. Move
         "the filter breaks the webhook path" to the first sentence.
   18:34 [rule 3: active voice] "the lookup should be scoped" — say who
         scopes it.
   24:7  [rule 8: cut filler] "it's worth noting that" — delete.
   ```

   Rank by how much each one costs a reader: a buried conclusion outranks a
   filler word. If the prose is clean, say so in one line and stop — don't pad
   the report to look thorough. Then offer `fix`.

---
# `fix` — apply the findings

1. **Get findings.** Use the caller's `find` output if passed; else run `find`.
2. **Rewrite.** Apply the changes to the target, smallest edit that fixes each
   finding.
   - **Preserve meaning exactly.** Rewriting prose must not change a claim, a
     number, a file path, a severity, or a conclusion. If a sentence is unclear
     because the *underlying fact* is unclear, that's not a writing problem —
     report it and leave the sentence alone.
   - **Never touch code, code spans, or fenced blocks.** Not the identifiers in
     them, not the commands.
   - Keep the artifact's required structure. A PR body still needs its tracker
     link and `## Architecture` note; a ticket still needs its acceptance
     criteria.
3. **Re-check.** Run `find` again. Report what changed and what you left, with
   the reason for each thing you left.
4. **Show the diff for a durable artifact.** A local file you may edit
   directly. When the target is already published — a PR body, a filed ticket —
   show the rewrite and get a yes first, then push it (`gh pr edit --body`,
   `gh issue edit --body`, Linear `save_issue`).

## Calling it from another skill

`find` is cheap and read-only, so the flows run it **before** the artifact
lands, not after:

- **`/rig-task` Step 5** — on the PR body, before `gh pr create`.
- **`/rig-issue create`** — on the ticket body, before filing.
- **`/rig-spike`** — on the writeup, before posting it back to the ticket.

A caller may thread `{target}` or pipe the draft text in on stdin. Return the
finding list, and the rewritten text when called with `fix`.

## Notes

- **Read-only by default.** `find` reports; only `fix` edits.
- **Degrades:** no guide → say so and stop. No `check-style.ts` → model-only
  pass. Neither is a hard failure.
- **Not a bug hunter.** Wrong claims are `/rig-review`'s job; this checks how
  the writing reads, not whether it's true. If you notice a false claim while
  proofreading, say so — but don't go looking.
- **Don't proofread the same artifact twice.** If `find` came back clean once
  and the text hasn't changed, there's nothing to add.
