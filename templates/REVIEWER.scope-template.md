# Scope invariants — <subsystem name>

Template for a **scoped `REVIEWER.md`**. Copy it to a directory whose code has
learned correctness rules the hard way (e.g. `src/billing/REVIEWER.md`), replace
the body with that subsystem's invariants, and delete this paragraph. `rig-review`
resolves the scoped files that apply to a diff and has the reviewer assert every
rule below as a **P1**. See the root `REVIEWER.md` for the repo-wide lenses these
specialize.

## How to write good scope invariants

- **Behavioral, not line-pinned.** State the rule the code must satisfy, not
  "line 42 must stay." Rules outlive refactors.
- **Cite where it was paid for.** End each rule with the PR / issue where the
  bug was found (`(PR #1234 "…")`). Provenance is what makes a rule credible and
  lets a reader judge whether it still applies.
- **One rule per bullet, grouped by theme** (idempotency, retry semantics,
  failure-path compensation, …). Keep it tight — this is asserted on every diff
  that touches the scope.

## `governs:` — claim invariants over scattered code (optional)

Ancestor-walk covers code *under* this directory. If the rules also govern code
elsewhere in the tree (handlers, helpers, jobs that share no close ancestor),
declare those paths in a `governs:` block — an HTML comment (invisible in
rendered Markdown). A changed file matching any glob pulls this scope in even
though it doesn't live under this directory. Globs: `*` within a segment, `**`
across segments; `#` lines are comments.

<!-- scope-reviewer:governs
  # Example: these rules also govern the webhook + job code that lives elsewhere.
  src/handlers/billing.ts
  src/jobs/**/*-billing.ts
-->

---

## <Theme, e.g. Idempotency & concurrency>

- **<The invariant, stated as a rule the code must satisfy.>** <One sentence of
  why / the failure it prevents.> (PR #<n> "<short title>".)
- **<Next invariant.>** … (PR #<n>.)

## <Theme, e.g. Retry semantics>

- **<Invariant.>** … (PR #<n>.)
