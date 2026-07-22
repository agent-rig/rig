---
name: rig-review
description: "Local code review, both halves. `find` (default): walk the REVIEWER.md catalog + scope invariants against a diff, two adversarial passes, return triaged P0–P3 findings — read-only. `fix`: drive review feedback to convergence, from a PR review bot OR local `find` results (spawn coder → recheck until clean). Triggers on: 'review my changes', 'review the diff', 'pre-PR review', 'review gate', 'check the diff before pushing', 'review fix', 'address the review', 'apply review feedback', 'fix the bot', 'address codex review', 'fix the findings', 'review loop'."
argument-hint: "[find | fix] [<PR>] [--source bot|local] [--rounds N] [--base <ref>] — default 'find' (read-only gate); 'fix' drives feedback to convergence"
allowed-tools: [Bash, Read, Agent]
---

# rig-review — find and fix, in one skill

Local code review with two verbs:

- **`find`** (default) — walk the project's `REVIEWER.md` catalog **and** the
  applicable per-scope invariants against a diff with a fresh-context `reviewer`
  agent (two passes), and return a triaged P0–P3 finding list. **Read-only** —
  it reports, it doesn't edit.
- **`fix`** — take review feedback and loop a `coder` agent over it until the
  review comes back clean (or a round budget is hit). Two feedback sources: a PR
  **review bot** on an open PR, or **local** `find` results.

The point is to **pre-empt the PR review bot**: every finding caught and fixed
locally is one you don't pay PR round-trip latency on. Implement/epic-style
flows call `rig-review find` then `rig-review fix --source local` so the loop
lives in one place.

## Configuration

Reads `.rig/config.json`:

- `review.patternsFile` — the P0–P3 catalog the reviewer walks (default
  `.claude/REVIEWER.md`). If absent, fall back to the kit's generic categories
  (correctness, security/trust-boundary, error-handling, concurrency,
  API/contract, tests, style) and say so.
- `review.bot` — PR review bot to poll/re-trigger: `codex`, `claude`, or `none`
  (default `none`). **`none` forces the local-only loop** for `fix`.
- `review.botRetrigger` — comment that re-triggers the bot (e.g. `@codex
  review`). Required when `bot` is not `none`.
- `review.maxRounds` — max fix↔recheck rounds before handing to a human
  (default `5`); `--rounds N` overrides.
- `vcs.baseRef` — diff base when no `<base>` is given (default `origin/main`).
- `project.repo` — `owner/name` for every `gh api` call (bot source). Never
  hardcode; derive from the git remote if unset.
- `agents.reviewer` / `agents.coder` — the project's names for those roles
  (default `rig-<role>`).

**Scope invariants (per-subsystem `REVIEWER.md`).** Beyond the root catalog, a
subsystem may carry its own `REVIEWER.md` colocated with its code — concrete
correctness invariants it "learned the hard way," each ideally citing the PR
where it was found. `scripts/scope-reviewer.ts` resolves which apply to a diff
(ancestor-walk + any `governs:` globs a scope declares). `find` collects them
and has the reviewer assert each as a **P1**. No-op if the project ships none.

## Verbs & arguments

`$ARGUMENTS` begins with an optional verb, then args:

- **`find [<base>]`** (default when no verb) — diff against `<base>` or
  `vcs.baseRef`. For a stacked/epic child, pass the integration branch.
- **`fix [<PR>] [--source bot|local] [--rounds N] [--base <ref>]`**
  - `<PR>` implies `--source bot` unless `review.bot` is `none` or `--source
    local` is set.
  - `--source` default: `bot` if a PR is given and `review.bot != none`, else
    `local`.
  - `--rounds` default `review.maxRounds`; `--base` (local only) default
    `vcs.baseRef`.

If invoked from another skill, the caller may thread `{base}`, `{ticket-id}`,
`{worktree-path}` — use them.

---
# `find` — the read-only gate

1. **Resolve the base** and confirm there's a diff:
   ```bash
   git fetch origin
   git diff --stat {base}...HEAD
   ```
   If empty, report `clean — no changes vs {base}` and stop.

   Then **collect the scope invariants** for the changed files:
   ```bash
   bun scripts/scope-reviewer.ts {base}    # or your TS runner; --files <paths> also works
   ```
   Capture as `{scope-invariants}`. Informational, never fails; if it prints "No
   scope REVIEWER.md apply", **drop the scope-invariant paragraph** below.

2. **Spawn the `reviewer` agent** (via `agents.reviewer`) against the diff,
   working in `{worktree-path}` if a caller passed one:

   > "Review the diff `git diff {base}...HEAD`{ticket-suffix}. Read
   > `{patternsFile}` first and walk **every** pattern against the diff. (If it
   > doesn't exist, walk the generic categories: correctness,
   > security/trust-boundary, error-handling, concurrency, API/contract, tests,
   > style — and say so.) Worktree path: {worktree-path}. Be specific — file and
   > line refs. Tag each finding with its pattern number and severity
   > (P0/P1/P2/P3). If clean against every pattern, say so explicitly.
   >
   > This diff touches scopes with recorded invariants — assert the diff against
   > **every** one; a violation is a **P1** tagged `scope-invariant`.
   > Invariants:\n{scope-invariants}"

   (`{ticket-suffix}` = ` for {ticket-id}` when passed, else empty. **Omit the
   scope-invariant paragraph** when step 1 found none.)

3. **If pass 1 has any P0/P1, stop here** and report (step 5) — no value hunting
   for more before known blockers are fixed. The caller re-invokes `find` after
   `fix`, and the adversarial pass runs on that next iteration.

4. **Adversarial second pass (only when pass 1 is clean of P0/P1).** Spawn a
   **second, independent** `reviewer` call — fresh context, framed to default to
   skepticism:

   > "A prior reviewer found this diff clean of blocking issues: `git diff
   > {base}...HEAD`{ticket-suffix}. Assume that verdict is wrong and find what it
   > missed. Read `{patternsFile}` and walk every pattern independently — don't
   > anchor on 'a reviewer already passed this.' Worktree path: {worktree-path}.
   > File/line refs, tagged with pattern number and severity. Also assert the
   > diff against the recorded scope invariants below independently; a violation
   > is a **P1** tagged `scope-invariant`. Invariants:\n{scope-invariants} If you
   > also find it clean, say so; don't invent findings to justify a second
   > opinion."

   (Omit the scope-invariant lines when step 1 found none.) Merge any P0/P1 the
   second pass surfaces into the list.

5. **Classify and report** (this verb finds, it does not edit):
   - `clean — 0 findings vs {base} (2 passes)`
   - `findings — N P0/P1, M P2/P3` — each with file:line, pattern number,
     severity, and `[pass 1]`/`[pass 2]`.

   P0/P1 block (don't push). P2/P3 ship-with-a-note. To fix them, hand off to
   `fix --source local`.

---
# `fix` — drive feedback to convergence

## Source: `local` (findings from `find`)

1. **Get findings.** Use the caller's `find` output if passed; else run the
   `find` verb (`rig-review {base}`) first.
2. **Classify:** no P0/P1 → return `clean` (surface P2/P3); any P0/P1 → fix round.
3. **Fix round** (while `round <= N`):
   - Spawn **coder** (via `agents.coder`) in `{worktree-path}`:
     > "Address these review findings on {ticket-id}. Worktree: {worktree-path}.
     > Findings:\n{find_output}\n\nFor each, either apply the fix or explain in
     > one line why the finding is wrong. Don't silently skip."
   - Re-run the `find` verb (fresh context). If still P0/P1, increment `round`.
4. Return the outcome.

**Outcomes (local):**
- `clean — 0 P0/P1 vs {base}` (P2/P3, if any, listed)
- `unresolved — N P0/P1 after {N} rounds, leaving for your review`

## Source: `bot` (review bot on a PR)

Drives whatever bot `review.bot` names — mechanics are identical; only the
author login and re-trigger phrase differ. Set `REPO="$(project.repo)"` and
`RETRIGGER="$(review.botRetrigger)"` up front.

**Identifying the bot.** Match the author with a case-insensitive regex on the
login, not an exact string — most bots post under more than one identity (a
`...-connector` for reviews, a `...[bot]` for inline threads); exact match
misses half the surface and stalls polling.
- `bot: codex` → regex `chatgpt-codex-connector`.
- `bot: claude` → regex `claude`.

Loop, `round` starting at 1:

1. **Wait for the bot.** Poll ~5 min (15 × 20s). Watch review state AND inline
   comments AND reactions in one snapshot:
   ```bash
   PR=<N>
   PUSH_TIME=$(gh pr view $PR --repo "$REPO" --json commits -q '.commits[-1].committedDate')
   BOT='<login-regex for review.bot>'
   REVIEW=$(gh pr view $PR --repo "$REPO" --json reviews -q "
     [.reviews[] | select((.author.login | test(\"$BOT\"; \"i\")) and .submittedAt > \"$PUSH_TIME\")] | last | .state // \"none\"")
   REACTION=$(gh api "repos/$REPO/issues/$PR/reactions" -q "
     [.[] | select((.user.login | test(\"$BOT\"; \"i\")) and .content == \"+1\" and .created_at > \"$PUSH_TIME\")] | length")
   INLINE=$(gh api "repos/$REPO/pulls/$PR/comments" -q "
     [.[] | select((.user.login | test(\"$BOT\"; \"i\")) and .created_at > \"$PUSH_TIME\")] | length")
   ```
2. **Classify:**
   - `REACTION > 0` or `REVIEW == "APPROVED"` → **clean**, exit.
   - `REVIEW == "COMMENTED"` AND `INLINE > 0` → **actionable**, go to 3.
   - `REVIEW == "COMMENTED"` AND `INLINE == 0` → **race window**: review state can
     flip before inline threads are API-visible. Keep polling. If inlines never
     populate within budget AND the review body is boilerplate-only, treat as
     **clean** (a header-only review is a soft +1).
   - Timeout (5 min, nothing) → **timeout**, exit.

   **Never classify on review-state alone** — `COMMENTED` with empty inlines is a
   transient race, not "no findings."
3. **Fix round** (only if `round <= N`):
   - **Read and classify the bot's findings.** Pull inline threads (same regex),
     keep each comment's `id`:
     ```bash
     gh api "repos/$REPO/pulls/$PR/comments" \
       -q ".[] | select(.user.login | test(\"$BOT\"; \"i\")) | {id, path, line, body}"
     ```
     Bucket each by severity yourself (blocking = correctness/security/data-loss;
     advisory = style/nit). *(If the project ships a P1-gate classifier script,
     run it and use its output as authoritative.)*
   - Spawn **coder** (via `agents.coder`) with the review body + inline comments
     (each with `id`) and the instruction to apply fixes in `{worktree-path}`.
     Tell coder: "Address each actionable suggestion. If one is wrong, **push
     back in that comment's own inline thread — reply to it, don't open a
     top-level comment** — with the technical reason; don't silently skip":
     ```bash
     gh api --method POST "repos/$REPO/pulls/$PR/comments/<comment_id>/replies" -f body="<reason>"
     ```
   - Stage, commit, push (`fix({ticket-id}): address review`).
   - **Resolve the threads you addressed.** If merge gates on unresolved blocking
     threads, resolve each the coder actually fixed; for a blocker coder pushed
     back on, reply with rationale, resolve as explicit dismissal, and surface to
     the user — never leave an applicable blocker unresolved. Use the project's
     thread-resolution tooling if it ships one. A resolve *without* a push
     doesn't re-run a gate check — re-run the required check or let the next push
     re-trigger it.
   - Re-trigger: `gh pr comment $PR --repo "$REPO" --body "$RETRIGGER"`.
   - Increment `round`; update `PUSH_TIME` to the new commit; loop to 1.
4. **After N rounds** (or `clean`/`timeout`): the merge-queue gate is the
   authority — converge to it. If the project ships a P1-gate script, run it
   (exit 0 → `clean`; non-zero → `actionable` with blocking titles + URLs).
   Else use the final snapshot + tracked unresolved blockers.

**Outcomes (bot)** — stacked/epic flows read this to decide auto-merge:
- `clean — PR <URL> reviewed by <bot>, no unresolved blockers`
- `actionable — PR <URL> still has N unresolved blocker(s) after {N} rounds. Findings: <titles + URLs>`
- `timeout — PR <URL> open, <bot> did not respond within 5 min, leaving for your review`
