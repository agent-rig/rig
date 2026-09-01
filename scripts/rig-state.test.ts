import { describe, expect, it } from "bun:test";
import {
  applyPatch,
  LIMITS,
  mergePatch,
  phaseAtOrPast,
  renderCompact,
  SCHEMAS,
  validateState,
  validRunId,
  type State,
} from "./rig-state.ts";

const TASK = SCHEMAS["rig-task"]!;
const EPIC = SCHEMAS["rig-epic"]!;
const REVIEW = SCHEMAS["rig-review"]!;
const NOW = "2026-09-01T00:00:00.000Z";

function task(extra: State = {}): State {
  return mergePatch(
    { runId: "abc-18", skill: "rig-task", phase: "spec", createdAt: NOW, updatedAt: NOW },
    extra,
  );
}

function epic(extra: State = {}): State {
  return mergePatch(
    { runId: "abc-42", skill: "rig-epic", phase: "start", createdAt: NOW, updatedAt: NOW },
    extra,
  );
}

function reasons(result: ReturnType<typeof validateState>): string[] {
  return result.ok ? [] : result.reasons;
}

describe("mergePatch", () => {
  it("deep-merges nested objects instead of replacing them", () => {
    const merged = mergePatch({ tests: { command: "bun test", status: "red" } }, { tests: { status: "green" } });
    expect(merged).toEqual({ tests: { command: "bun test", status: "green" } });
  });

  it("deletes a key when the patch sets it to null", () => {
    expect(mergePatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });

  it("deletes a nested key without disturbing its siblings", () => {
    expect(mergePatch({ pr: { number: 4, url: "u" } }, { pr: { url: null } })).toEqual({ pr: { number: 4 } });
  });

  it("replaces arrays wholesale rather than appending", () => {
    expect(mergePatch({ blockers: ["a", "b"] }, { blockers: ["c"] })).toEqual({ blockers: ["c"] });
  });

  it("leaves the base object untouched", () => {
    const base = { a: 1 };
    mergePatch(base, { a: 2 });
    expect(base).toEqual({ a: 1 });
  });
});

describe("validateState — shape", () => {
  it("accepts a well-formed task state", () => {
    expect(validateState(TASK, task({ base: "origin/main" })).ok).toBe(true);
  });

  it("rejects an unknown top-level key and lists the known ones", () => {
    const out = reasons(validateState(TASK, task({ scratchpad: "notes" })));
    expect(out.join()).toContain("scratchpad: unknown key");
    expect(out.join()).toContain("worktree");
  });

  it("rejects an unknown nested key", () => {
    expect(reasons(validateState(TASK, task({ tests: { flakes: 2 } }))).join()).toContain("tests.flakes: unknown key");
  });

  it("rejects a wrong type", () => {
    expect(reasons(validateState(TASK, task({ branch: 7 }))).join()).toContain("branch: expected a string");
  });

  it("rejects a value outside a field's enum", () => {
    expect(reasons(validateState(TASK, task({ tests: { status: "mostly" } }))).join()).toContain(
      "not one of not-run | red | green | error",
    );
  });

  it("rejects an undeclared phase and names the declared ones", () => {
    expect(reasons(validateState(TASK, task({ phase: "vibing" }))).join()).toContain("is not a rig-task phase");
  });

  it("rejects a string array holding non-strings", () => {
    expect(reasons(validateState(TASK, task({ blockers: ["ok", 3] }))).join()).toContain("an array of strings");
  });

  it("checks every element of an object array", () => {
    const out = reasons(validateState(EPIC, epic({ children: [{ id: "a", status: "todo" }, { id: "b", status: "nope" }] })));
    expect(out.join()).toContain("children[1].status");
  });
});

describe("validateState — budgets", () => {
  it("rejects a string longer than the per-string limit", () => {
    const out = reasons(validateState(TASK, task({ nextAction: "x".repeat(LIMITS.stringChars + 1) })));
    expect(out.join()).toContain("summarize it");
  });

  it("rejects an array past the item limit", () => {
    const out = reasons(validateState(TASK, task({ decisions: Array.from({ length: LIMITS.arrayItems + 1 }, () => "d") })));
    expect(out.join()).toContain("item limit");
  });

  it("rejects a state past the byte budget", () => {
    const filler = Array.from({ length: 40 }, () => "y".repeat(400));
    const out = reasons(validateState(TASK, task({ decisions: filler, blockers: filler })));
    expect(out.join()).toContain("byte budget");
  });
});

describe("guards — rig-task", () => {
  const green = { tests: { status: "green" }, review: { p0: 0, p1: 0 }, pr: { number: 9 } };

  it("blocks pr-open while the suite is red", () => {
    expect(reasons(validateState(TASK, task({ phase: "pr-open", tests: { status: "red" } }))).join()).toContain(
      "tests.status = green",
    );
  });

  it("blocks pr-open with an unresolved P1", () => {
    const out = reasons(validateState(TASK, task({ phase: "pr-open", tests: { status: "green" }, review: { p0: 0, p1: 1 } })));
    expect(out.join()).toContain("Step 4.5 is a gate");
  });

  it("allows pr-open once the suite is green and the self-review is clean", () => {
    expect(validateState(TASK, task({ phase: "pr-open", ...green })).ok).toBe(true);
  });

  it("blocks done without a PR number", () => {
    const out = reasons(validateState(TASK, task({ phase: "done", tests: { status: "green" }, review: { p0: 0, p1: 0 } })));
    expect(out.join()).toContain("a finished task has a PR");
  });

  it("does not re-assert a passed gate on an abandoned run", () => {
    expect(validateState(TASK, task({ phase: "abandoned", tests: { status: "red" } })).ok).toBe(true);
  });

  it("still applies the gate to a phase past pr-open", () => {
    const out = reasons(validateState(TASK, task({ phase: "review-loop", tests: { status: "red" } })));
    expect(out.join()).toContain("tests.status = green");
  });
});

describe("guards — rig-epic", () => {
  it("blocks finish while a child is unmerged", () => {
    const state = epic({
      phase: "finish",
      children: [
        { id: "1", status: "merged", branch: "b1" },
        { id: "2", status: "todo" },
      ],
    });
    expect(reasons(validateState(EPIC, state)).join()).toContain("every child at status 'merged'");
  });

  it("blocks review before any child has merged", () => {
    const state = epic({ phase: "review", children: [{ id: "1", status: "in-progress" }] });
    expect(reasons(validateState(EPIC, state)).join()).toContain("at least one merged child");
  });

  it("requires a merged child to record its branch", () => {
    const state = epic({ phase: "run", children: [{ id: "1", status: "merged" }] });
    expect(reasons(validateState(EPIC, state)).join()).toContain("must record its branch");
  });

  it("accepts a finish with every child merged and branched", () => {
    const state = epic({ phase: "finish", children: [{ id: "1", status: "merged", branch: "b1" }] });
    expect(validateState(EPIC, state).ok).toBe(true);
  });
});

describe("guards — rig-review", () => {
  const base = { runId: "pr-418", skill: "rig-review", phase: "fix", createdAt: NOW, updatedAt: NOW };

  it("blocks a clean outcome while a finding is open", () => {
    const state = mergePatch(base, { outcome: "clean", findings: [{ id: "f1", severity: "P1", status: "open" }] });
    expect(reasons(validateState(REVIEW, state)).join()).toContain("still at status 'open'");
  });

  it("accepts a clean outcome once every finding is fixed or deferred", () => {
    const state = mergePatch(base, {
      outcome: "clean",
      findings: [
        { id: "f1", severity: "P1", status: "fixed" },
        { id: "f2", severity: "P2", status: "deferred" },
      ],
    });
    expect(validateState(REVIEW, state).ok).toBe(true);
  });

  it("blocks a round past maxRounds", () => {
    expect(reasons(validateState(REVIEW, mergePatch(base, { round: 6, maxRounds: 5 }))).join()).toContain(
      "hand back to a human",
    );
  });
});

describe("applyPatch", () => {
  it("stamps updatedAt on an accepted patch", () => {
    const result = applyPatch(TASK, task(), { phase: "red" }, { now: "2026-09-02T00:00:00.000Z" });
    expect(result.ok && result.state.updatedAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it("leaves the current state untouched when it rejects", () => {
    const current = task({ tests: { status: "red" } });
    const result = applyPatch(TASK, current, { phase: "pr-open" }, { now: NOW });
    expect(result.ok).toBe(false);
    expect(current.phase).toBe("spec");
  });

  it("refuses to patch the identity fields", () => {
    expect(reasons(applyPatch(TASK, task(), { runId: "other" }, { now: NOW })).join()).toContain("never patched");
  });

  it("refuses to move a run off a terminal phase", () => {
    const done = task({ phase: "done", tests: { status: "green" }, review: { p0: 0, p1: 0 }, pr: { number: 9 } });
    expect(reasons(applyPatch(TASK, done, { phase: "red" }, { now: NOW })).join()).toContain("terminal phase");
  });

  it("allows the terminal move under --force", () => {
    const done = task({ phase: "done", tests: { status: "green" }, review: { p0: 0, p1: 0 }, pr: { number: 9 } });
    expect(applyPatch(TASK, done, { phase: "review-loop" }, { force: true, now: NOW }).ok).toBe(true);
  });

  it("rejects a non-object patch", () => {
    expect(applyPatch(TASK, task(), [] as unknown as State, { now: NOW }).ok).toBe(false);
  });
});

describe("phaseAtOrPast", () => {
  it("is true at the target phase", () => {
    expect(phaseAtOrPast(TASK, task({ phase: "pr-open" }), "pr-open")).toBe(true);
  });

  it("is false before it", () => {
    expect(phaseAtOrPast(TASK, task({ phase: "green" }), "pr-open")).toBe(false);
  });

  it("is false for an abandoned run", () => {
    expect(phaseAtOrPast(TASK, task({ phase: "abandoned" }), "pr-open")).toBe(false);
  });
});

describe("renderCompact", () => {
  const rendered = renderCompact(
    task({
      phase: "green",
      spec: { id: "ABC-18", title: "Add rate limiting" },
      tests: { status: "green", pass: 412 },
      blockers: [],
      decisions: ["Reuse TokenBucket rather than add a dependency"],
    }),
  );

  it("leads with the skill, run, and phase", () => {
    expect(rendered.split("\n")[0]).toBe("# rig-task state · abc-18 · phase: green");
  });

  it("flattens nested objects to dotted keys", () => {
    expect(rendered).toContain("tests.status: green");
    expect(rendered).toContain("spec.id: ABC-18");
  });

  it("marks an empty list rather than dropping it", () => {
    expect(rendered).toContain("blockers: (none)");
  });

  it("lists array items one per line", () => {
    expect(rendered).toContain("  - Reuse TokenBucket rather than add a dependency");
  });
});

describe("validRunId", () => {
  it("accepts a ticket-shaped id", () => {
    expect(validRunId("abc-18")).toBe(true);
  });

  it("rejects a path traversal", () => {
    expect(validRunId("../escape")).toBe(false);
  });

  it("rejects a separator", () => {
    expect(validRunId("a/b")).toBe(false);
  });

  it("rejects an over-long id", () => {
    expect(validRunId("a".repeat(81))).toBe(false);
  });
});
