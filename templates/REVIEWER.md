# Reviewer catalog — general review patterns (starter)

The **root of the `REVIEWER.md` tree**: a generic P0–P3 catalog of repo-wide
review patterns. The `reviewer` agent (and any pre-PR gate) **walks every
category below against the diff** before a change ships; a coding agent
internalizes them so it doesn't introduce the problems in the first place.

This is a starter. Prune categories that don't apply and **add your own** as you
discover recurring classes of finding — the most valuable entries are the ones
specific to your codebase's hazards. Keep entries tight; examples are
illustrative, not exhaustive.

> **Scoped `REVIEWER.md` files specialize this one.** Drop a `REVIEWER.md` next
> to a subsystem (e.g. `src/billing/REVIEWER.md`) holding the concrete
> invariants that subsystem has learned the hard way. `rig-review` resolves the
> scoped files that apply to a diff (via `scripts/scope-reviewer.ts`) and asserts
> each as a P1. See `REVIEWER.scope-template.md` for the format. (Not to be
> confused with the `rig-reviewer` *agent* — this file is the knowledge it walks.)

## How to use this catalog

For each changed file in the diff, ask every pattern's **Check**
question. Tag each finding with:

- its **pattern number**, and
- a **severity**:
  - **P0 — Block.** Security hole, data loss, broken behavior. Do not merge.
  - **P1 — Fix.** Correctness bug, missing test, contract violation. Fix before merge.
  - **P2 — Suggest.** Nice to have; ship-with-a-note.
  - **P3 — Note.** Informational.

If the diff is clean against every pattern, say so explicitly.

---

## 1. Correctness

**Pattern.** The change compiles and reads plausibly but does the wrong
thing on some input: an off-by-one, an inverted condition, a null/undefined
dereference, an unhandled empty collection, a wrong default, or a wrong
assumption about what a called function returns.

**Symptoms reviewers catch:**
- "boundary case (empty list / first / last / zero) isn't handled"
- "condition is inverted — this branch runs when it shouldn't"
- "assumes the lookup always finds a row; it can return null here"

**Check.**
- Trace the happy path and at least one edge case (empty, max, missing) by hand.
- For every value that could be `null`/`undefined`, confirm it's guarded before use.
- Confirm the change actually satisfies the stated requirement, not an adjacent one.

---

## 2. Security / trust boundary

**Pattern.** Data that crosses a trust boundary (user input, another
tenant, a third party, the network) is trusted without validation, or a
secret/privileged surface is exposed.

**Failure modes:**
- Missing authentication/authorization check on a new endpoint or action.
- **Cross-tenant / IDOR:** an operation takes a resource ID from the
  request and acts on it without confirming the caller owns it. Scope
  every ID-addressed operation to the requester's identity; never use a
  raw/unscoped accessor on a request-derived ID.
- Injection: SQL/shell/HTML built by string concatenation from input —
  use parameterized queries / safe APIs / escaping.
- **SSRF:** a server-side fetch of a user- or tenant-controlled URL.
  Constrain the scheme, resolve the host and reject private/loopback/
  link-local ranges (after DNS, and re-check on redirect), or use an
  allowlist.
- Secrets logged, serialized into a response, or committed.
- Over-broad permissions (CORS `*`, world-readable ACL, wildcard scope).

**Check.** For every new input, endpoint, or outbound call: where does
the data come from, and what stops a hostile value? Untrusted data is
trusted only *after* explicit validation/scoping. Confirm new
trust-boundary code has a negative test (a forbidden request is refused).

---

## 3. Error handling & resilience

**Pattern.** Failures are swallowed, mislabeled, or left in a partial
state — especially in anything that can be **retried or replayed** (queue
worker, cron, webhook, workflow step, idempotent request).

**Failure modes:**
- Inner `try/catch` logs and returns; the caller sees success when the
  work failed. Re-throw or don't catch.
- A deterministic failure (bad input, "already gone", policy violation)
  is thrown as a generic retriable error → the runtime retries forever.
  Distinguish deterministic from transient.
- Not idempotent under retry: a partial run leaves state that a re-run
  can't reconcile; destructive steps ordered so a retry can't recover.
- Error message discards the cause; the caller can't tell what happened.

**Check.** For every changed handler that can be retried: is the failure
class right? Do inner helpers swallow errors? Does a partial run
re-converge on retry? Is the original error preserved?

---

## 4. Concurrency & shared state

**Pattern.** Two things run at once — requests, workers, async
callbacks — and the code assumes they don't.

**Failure modes:**
- Read-modify-write without a lock/transaction/atomic op → lost update
  or TOCTOU (check-then-act where the state changes in between).
- Shared mutable module-level state mutated per request.
- Unbounded parallelism (fan-out with no concurrency cap) exhausting a
  pool, connection limit, or rate budget.
- Assuming ordering between independent async operations.

**Check.** For state read and later written: can another actor change it
in between? Guard with a transaction, atomic update, or lock. For any
new fan-out, is concurrency bounded?

---

## 5. API / contract changes (blast radius)

**Pattern.** A shared surface changed — a function signature, return
shape, exported constant, config key, DB column, or public
endpoint/response — without enumerating every consumer. Locally correct,
breaks an unrelated caller or leaves a dangling reference.

**Consumer surfaces to enumerate:**
- Callers and importers in code.
- References in CI/CD config, package manifests, IaC, and docs/runbooks.
- Persisted data / API clients that depend on the old shape
  (serialized rows, external consumers) — a shape change may need a migration.
- For a deletion: every remaining reference to the removed name.

**Check.** For each changed/removed shared symbol, list every consumer
and confirm the new contract holds for all of them. A grep/`find-references`
sweep for the old name should come back empty (or each hit accounted for).

---

## 6. Tests

**Pattern.** New behavior ships without a test that would fail if the
behavior regressed, or the added test doesn't actually exercise the change.

**Failure modes:**
- New function/branch/route/edge case with no covering test.
- Test asserts on a mock's behavior instead of the real code path.
- Test pins current output (would pass against the *old* code too) — it
  proves nothing about the new behavior.
- Bug fix without a regression test that fails before the fix.

**Check.** Does every new behavior have a test that fails without the
change? Does the test drive real code, not a mock of it? Would it survive
a harmless reword of the implementation while still catching a real
regression?

---

## 7. Style & scope

**Pattern.** The change is correct but carries noise or drifts from
project conventions.

**Failure modes:**
- Changes outside the stated scope of the task.
- Leftover debug logging, commented-out code, stray `TODO`s.
- Dead code the change orphaned.
- Ignores an established local convention (naming, file layout, the
  project's runtime/toolchain) or introduces a parallel way to do
  something the codebase already does — prefer extending existing code
  over a competing implementation.

**Check.** Is every hunk in scope? Any debug residue or dead code? Does
it match the surrounding conventions and reuse existing abstractions
rather than duplicate them?
