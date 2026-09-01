#!/usr/bin/env bun
/**
 * rig-state.ts — durable, validated run state for long-horizon rig skills.
 * Part of Rig (used by rig-task, rig-epic, and rig-review).
 *
 * The problem: a rig skill is a long procedure — `/rig-task` spans seven steps
 * and four delegated agents; `/rig-epic run` loops that over every child. The
 * host agent's only memory of what happened is its transcript, so a compaction
 * mid-run drops the acceptance criteria, which tests went red and why, and
 * which review findings are already fixed. The agent then re-derives that from
 * `git` and `gh`, or guesses.
 *
 * The fix: keep one small structured document per run, on disk, and treat it —
 * not the transcript — as what the next step reads. The skill patches it after
 * each step; this script validates and merges the patch OUTSIDE the model, so a
 * malformed or oversized update is rejected rather than silently persisted.
 * `rig-epic` already did this by hand for epics; this generalizes it.
 *
 * Files, under `.rig/state/` (gitignored — throwaway coordination state):
 *   <runId>.json    the current state; what `show` renders into a prompt
 *   <runId>.jsonl   append-only journal of accepted patches, for humans
 *
 * The journal exists so a failed run is debuggable. Never feed it to a model —
 * that reintroduces the history this replaces.
 *
 * Usage:
 *   rig-state.ts init <skill> <runId> [--json '{...}']
 *   rig-state.ts patch <runId> [--json '{...}'|-] [--step <label>] [--force]
 *   rig-state.ts get <runId> [--field <dotted.path>]
 *   rig-state.ts show <runId>
 *   rig-state.ts list [--skill <name>]
 *   rig-state.ts journal <runId>
 *   rig-state.ts rm <runId>
 *
 * Exit codes: 0 accepted · 1 rejected (reason on stderr, state unchanged) ·
 * 2 usage or missing run. A rejection is recoverable: fix the patch, retry.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path/posix";

// ---------------------------------------------------------------- schema ----

export type FieldSpec = {
  type: "string" | "number" | "boolean" | "string[]" | "object" | "object[]";
  enum?: string[];
  of?: Record<string, FieldSpec>;
};

export type Guard = {
  /** What this guard protects, in the message a rejected patch gets back. */
  reason: string;
  /** Return true when the state VIOLATES the guard. */
  violated: (state: State) => boolean;
};

export type SkillSchema = {
  skill: string;
  phases: string[];
  terminal: string[];
  fields: Record<string, FieldSpec>;
  guards: Guard[];
};

export type State = Record<string, unknown>;

/** Budgets. They aren't arbitrary: they're what keeps state from becoming a
 * transcript by another name. A rejected patch tells the model to summarize. */
export const LIMITS = { bytes: 8_192, stringChars: 500, arrayItems: 50 } as const;

/** Fields every skill carries. `createdAt`/`updatedAt` are tool-managed. */
const CORE_FIELDS: Record<string, FieldSpec> = {
  runId: { type: "string" },
  skill: { type: "string" },
  phase: { type: "string" },
  createdAt: { type: "string" },
  updatedAt: { type: "string" },
  nextAction: { type: "string" },
  blockers: { type: "string[]" },
  decisions: { type: "string[]" },
};

const TASK_SCHEMA: SkillSchema = {
  skill: "rig-task",
  phases: [
    "spec", "spec-review", "red", "green", "refactor",
    "self-review", "pr-open", "review-loop", "done", "abandoned",
  ],
  terminal: ["done", "abandoned"],
  fields: {
    ...CORE_FIELDS,
    spec: {
      type: "object",
      of: {
        id: { type: "string" },
        title: { type: "string" },
        source: { type: "string", enum: ["linear", "github", "adhoc"] },
        acceptanceCriteria: { type: "string[]" },
      },
    },
    worktree: { type: "string" },
    branch: { type: "string" },
    base: { type: "string" },
    pr: {
      type: "object",
      of: {
        number: { type: "number" },
        url: { type: "string" },
        state: { type: "string", enum: ["open", "merged", "closed"] },
      },
    },
    tests: {
      type: "object",
      of: {
        command: { type: "string" },
        status: { type: "string", enum: ["not-run", "red", "green", "error"] },
        pass: { type: "number" },
        fail: { type: "number" },
        failures: { type: "string[]" },
      },
    },
    review: {
      type: "object",
      of: {
        source: { type: "string", enum: ["local", "bot"] },
        round: { type: "number" },
        p0: { type: "number" },
        p1: { type: "number" },
        p2: { type: "number" },
        open: { type: "string[]" },
        outcome: {
          type: "string",
          enum: ["pending", "clean", "actionable", "timeout", "unresolved"],
        },
      },
    },
  },
  guards: [
    {
      reason: "phase 'pr-open' requires tests.status = green (Step 4 must be GREEN before push)",
      violated: (s) => phaseAtOrPast(TASK_SCHEMA, s, "pr-open") && dig(s, "tests.status") !== "green",
    },
    {
      reason: "phase 'pr-open' requires review.p0 = 0 and review.p1 = 0 (Step 4.5 is a gate)",
      violated: (s) =>
        phaseAtOrPast(TASK_SCHEMA, s, "pr-open") &&
        (num(dig(s, "review.p0")) > 0 || num(dig(s, "review.p1")) > 0),
    },
    {
      reason: "phase 'done' requires pr.number (a finished task has a PR)",
      violated: (s) => s.phase === "done" && typeof dig(s, "pr.number") !== "number",
    },
  ],
};

const EPIC_SCHEMA: SkillSchema = {
  skill: "rig-epic",
  phases: ["plan", "start", "run", "review", "finish", "done", "abandoned"],
  terminal: ["done", "abandoned"],
  fields: {
    ...CORE_FIELDS,
    parent: {
      type: "object",
      of: {
        id: { type: "string" },
        title: { type: "string" },
        source: { type: "string", enum: ["linear", "github", "none"] },
      },
    },
    integrationBranch: { type: "string" },
    whyEpic: { type: "string" },
    children: {
      type: "object[]",
      of: {
        id: { type: "string" },
        title: { type: "string" },
        blockedBy: { type: "string[]" },
        branch: { type: "string" },
        pr: { type: "number" },
        status: { type: "string", enum: ["todo", "in-progress", "blocked", "merged"] },
      },
    },
    specReview: {
      type: "object",
      of: {
        frontLoaded: { type: "boolean" },
        outcome: { type: "string", enum: ["pending", "cleared", "halted"] },
        blockers: { type: "string[]" },
      },
    },
    combinedReview: {
      type: "object",
      of: {
        outcome: { type: "string", enum: ["pending", "clean", "applied", "paused"] },
        p0: { type: "number" },
        p1: { type: "number" },
        p2: { type: "number" },
      },
    },
  },
  guards: [
    {
      reason: "phase 'finish' requires every child at status 'merged'",
      violated: (s) =>
        phaseAtOrPast(EPIC_SCHEMA, s, "finish") &&
        childList(s).some((c) => c.status !== "merged"),
    },
    {
      reason: "phase 'review' requires at least one merged child (nothing to review yet)",
      violated: (s) =>
        s.phase === "review" && !childList(s).some((c) => c.status === "merged"),
    },
    {
      reason: "a child at status 'merged' must record its branch",
      violated: (s) => childList(s).some((c) => c.status === "merged" && !c.branch),
    },
  ],
};

const REVIEW_SCHEMA: SkillSchema = {
  skill: "rig-review",
  phases: ["find", "fix", "done", "abandoned"],
  terminal: ["done", "abandoned"],
  fields: {
    ...CORE_FIELDS,
    base: { type: "string" },
    worktree: { type: "string" },
    source: { type: "string", enum: ["local", "bot"] },
    pr: { type: "number" },
    round: { type: "number" },
    maxRounds: { type: "number" },
    outcome: {
      type: "string",
      enum: ["pending", "clean", "actionable", "timeout", "unresolved"],
    },
    findings: {
      type: "object[]",
      of: {
        id: { type: "string" },
        severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        file: { type: "string" },
        line: { type: "number" },
        summary: { type: "string" },
        status: { type: "string", enum: ["open", "fixed", "deferred", "rejected"] },
      },
    },
  },
  guards: [
    {
      reason: "outcome 'clean' requires no finding still at status 'open'",
      violated: (s) =>
        s.outcome === "clean" && findingList(s).some((f) => f.status === "open"),
    },
    {
      reason: "round must not exceed maxRounds (hand back to a human instead)",
      violated: (s) =>
        typeof s.maxRounds === "number" && num(s.round) > (s.maxRounds as number),
    },
  ],
};

export const SCHEMAS: Record<string, SkillSchema> = {
  "rig-task": TASK_SCHEMA,
  "rig-epic": EPIC_SCHEMA,
  "rig-review": REVIEW_SCHEMA,
};

// ------------------------------------------------------------- utilities ----

function dig(state: State, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, key) => (isPlainObject(acc) ? (acc as State)[key] : undefined),
    state,
  );
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childList(state: State): Array<Record<string, unknown>> {
  return Array.isArray(state.children) ? (state.children as Array<Record<string, unknown>>) : [];
}

function findingList(state: State): Array<Record<string, unknown>> {
  return Array.isArray(state.findings) ? (state.findings as Array<Record<string, unknown>>) : [];
}

/** True when the state's phase is at or past `target` in the declared order. */
export function phaseAtOrPast(schema: SkillSchema, state: State, target: string): boolean {
  const here = schema.phases.indexOf(String(state.phase));
  const there = schema.phases.indexOf(target);
  if (here < 0 || there < 0) return false;
  // Terminal phases sit past every gate but shouldn't re-assert a gate they
  // already passed through — `abandoned` is a stop, not a completed run.
  if (state.phase === "abandoned") return false;
  return here >= there;
}

// ----------------------------------------------------------------- merge ----

/**
 * Deep-merge `patch` into `base`. A `null` value deletes its key. Arrays
 * replace wholesale — treating them as atomic values keeps merge unambiguous,
 * so "add one finding" means "send the new list", not "append and hope".
 */
export function mergePatch(base: State, patch: State): State {
  const out: State = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergePatch(out[key] as State, value as State);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ------------------------------------------------------------ validation ----

export type Rejection = { ok: false; reasons: string[] };
export type Acceptance = { ok: true; state: State };

function checkValue(path: string, spec: FieldSpec, value: unknown, reasons: string[]): void {
  const fail = (want: string) => reasons.push(`${path}: expected ${want}, got ${JSON.stringify(value)}`);
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") return fail("a string");
      if (value.length > LIMITS.stringChars)
        reasons.push(`${path}: ${value.length} chars exceeds the ${LIMITS.stringChars}-char limit — summarize it`);
      if (spec.enum && !spec.enum.includes(value))
        reasons.push(`${path}: "${value}" is not one of ${spec.enum.join(" | ")}`);
      return;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) fail("a number");
      return;
    case "boolean":
      if (typeof value !== "boolean") fail("a boolean");
      return;
    case "string[]":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return fail("an array of strings");
      if (value.length > LIMITS.arrayItems)
        reasons.push(`${path}: ${value.length} items exceeds the ${LIMITS.arrayItems}-item limit — keep what the next step needs`);
      for (const [i, v] of value.entries())
        if (String(v).length > LIMITS.stringChars)
          reasons.push(`${path}[${i}]: ${String(v).length} chars exceeds the ${LIMITS.stringChars}-char limit — summarize it`);
      return;
    case "object":
      if (!isPlainObject(value)) return fail("an object");
      checkFields(path, spec.of ?? {}, value as State, reasons);
      return;
    case "object[]":
      if (!Array.isArray(value)) return fail("an array of objects");
      if (value.length > LIMITS.arrayItems)
        reasons.push(`${path}: ${value.length} items exceeds the ${LIMITS.arrayItems}-item limit`);
      for (const [i, item] of value.entries()) {
        if (!isPlainObject(item)) {
          reasons.push(`${path}[${i}]: expected an object, got ${JSON.stringify(item)}`);
          continue;
        }
        checkFields(`${path}[${i}]`, spec.of ?? {}, item as State, reasons);
      }
      return;
  }
}

function checkFields(
  path: string,
  fields: Record<string, FieldSpec>,
  value: State,
  reasons: string[],
): void {
  for (const [key, v] of Object.entries(value)) {
    const spec = fields[key];
    const where = path ? `${path}.${key}` : key;
    if (!spec) {
      reasons.push(`${where}: unknown key. Known keys: ${Object.keys(fields).sort().join(", ")}`);
      continue;
    }
    if (v === null) continue; // a delete; nothing to type-check
    checkValue(where, spec, v, reasons);
  }
}

/**
 * Validate a candidate state against its skill schema: known keys, right types,
 * declared phase, budget, and every guard. This runs outside the model on
 * purpose — a state the model can't corrupt is the whole point.
 */
export function validateState(schema: SkillSchema, state: State): Rejection | Acceptance {
  const reasons: string[] = [];
  checkFields("", schema.fields, state, reasons);

  if (typeof state.phase !== "string" || !schema.phases.includes(state.phase)) {
    reasons.push(
      `phase: "${String(state.phase)}" is not a ${schema.skill} phase. Declared: ${schema.phases.join(" → ")}`,
    );
  }

  const size = JSON.stringify(state).length;
  if (size > LIMITS.bytes)
    reasons.push(
      `state is ${size} bytes, over the ${LIMITS.bytes}-byte budget — drop what no later step reads`,
    );

  if (reasons.length === 0) {
    for (const guard of schema.guards) if (guard.violated(state)) reasons.push(guard.reason);
  }

  return reasons.length ? { ok: false, reasons } : { ok: true, state };
}

/**
 * Apply a patch to a state and validate the result. Rejects a move off a
 * terminal phase unless `force` — a finished run doesn't quietly restart.
 */
export function applyPatch(
  schema: SkillSchema,
  current: State,
  patch: State,
  opts: { force?: boolean; now: string } = { now: "" },
): Rejection | Acceptance {
  if (!isPlainObject(patch)) return { ok: false, reasons: ["patch: expected a JSON object"] };
  for (const key of ["runId", "skill", "createdAt"]) {
    if (key in patch) return { ok: false, reasons: [`${key} is set at init and never patched`] };
  }
  if (
    !opts.force &&
    schema.terminal.includes(String(current.phase)) &&
    "phase" in patch &&
    patch.phase !== current.phase
  ) {
    return {
      ok: false,
      reasons: [
        `run is at terminal phase '${current.phase}'; start a new run rather than reopening it (--force overrides)`,
      ],
    };
  }
  const merged = mergePatch(current, patch);
  if (opts.now) merged.updatedAt = opts.now;
  return validateState(schema, merged);
}

// ----------------------------------------------------------------- render ---

/**
 * Render the state as the compact block a skill pastes into the next step's
 * prompt. Line-oriented so it greps, and so a diff between two steps reads.
 */
export function renderCompact(state: State): string {
  const lines: string[] = [
    `# ${state.skill} state · ${state.runId} · phase: ${state.phase}`,
  ];
  const skip = new Set(["skill", "runId", "phase", "createdAt", "updatedAt"]);
  const emit = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (value.length === 0) return void lines.push(`${key}: (none)`);
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${isPlainObject(item) ? renderInline(item as State) : String(item)}`);
      }
      return;
    }
    if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value as State)) emit(`${key}.${k}`, v);
      return;
    }
    lines.push(`${key}: ${String(value)}`);
  };
  for (const [key, value] of Object.entries(state)) {
    if (!skip.has(key)) emit(key, value);
  }
  lines.push(`updated: ${String(state.updatedAt ?? "unknown")}`);
  return lines.join("\n");
}

function renderInline(obj: State): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
    .join(" ");
}

// ------------------------------------------------------------------ store ---

export function stateDir(root = process.cwd()): string {
  return join(root, ".rig", "state");
}

export function statePath(runId: string, root = process.cwd()): string {
  return join(stateDir(root), `${runId}.json`);
}

export function journalPath(runId: string, root = process.cwd()): string {
  return join(stateDir(root), `${runId}.jsonl`);
}

/** Run IDs become filenames, so keep them to a safe, readable alphabet. */
export function validRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId) && !runId.includes("..");
}

function readState(runId: string, root: string): State {
  const path = statePath(runId, root);
  if (!existsSync(path)) die(2, `no run '${runId}' — run 'rig-state init <skill> ${runId}' first`);
  return JSON.parse(readFileSync(path, "utf8")) as State;
}

function writeState(state: State, root: string): void {
  const path = statePath(String(state.runId), root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function appendJournal(runId: string, entry: Record<string, unknown>, root: string): void {
  const path = journalPath(runId, root);
  mkdirSync(dirname(path), { recursive: true });
  const prior = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, `${prior}${JSON.stringify(entry)}\n`);
}

// -------------------------------------------------------------------- cli ---

function die(code: number, message: string): never {
  process.stderr.write(`rig-state: ${message}\n`);
  process.exit(code);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function readPatchArg(argv: string[]): State {
  const inline = flag(argv, "--json");
  const raw = !inline || inline === "-" ? readFileSync(0, "utf8") : inline;
  try {
    return JSON.parse(raw) as State;
  } catch (err) {
    die(1, `patch is not valid JSON: ${(err as Error).message}`);
  }
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  const root = flag(argv, "--root") ?? process.cwd();
  const now = new Date().toISOString();

  switch (command) {
    case "init": {
      const [skill, runId] = rest;
      if (!skill || !runId) die(2, "usage: rig-state init <skill> <runId> [--json '{...}']");
      const schema = SCHEMAS[skill];
      if (!schema) die(2, `unknown skill '${skill}'. Known: ${Object.keys(SCHEMAS).join(", ")}`);
      if (!validRunId(runId)) die(2, `run id '${runId}' must be alphanumeric with . _ -, under 80 chars`);
      if (existsSync(statePath(runId, root))) die(2, `run '${runId}' already exists — patch it instead`);
      const seed = argv.includes("--json") ? readPatchArg(argv) : {};
      const state = mergePatch(
        { runId, skill, phase: schema.phases[0], createdAt: now, updatedAt: now },
        seed,
      );
      const result = validateState(schema, state);
      if (!result.ok) die(1, `rejected:\n  - ${result.reasons.join("\n  - ")}`);
      writeState(result.state, root);
      appendJournal(runId, { ts: now, step: "init", patch: seed }, root);
      process.stdout.write(`${renderCompact(result.state)}\n`);
      return;
    }
    case "patch": {
      const [runId] = rest;
      if (!runId) die(2, "usage: rig-state patch <runId> --json '{...}' [--step <label>]");
      const current = readState(runId, root);
      const schema = SCHEMAS[String(current.skill)];
      if (!schema) die(2, `run '${runId}' names unknown skill '${current.skill}'`);
      const patch = readPatchArg(argv);
      const result = applyPatch(schema, current, patch, { force: argv.includes("--force"), now });
      if (!result.ok) {
        // Rollback-and-retry: state is untouched, and the reasons say what to fix.
        process.stderr.write(`rig-state: patch rejected:\n  - ${result.reasons.join("\n  - ")}\n`);
        process.stdout.write(`${renderCompact(current)}\n`);
        process.exit(1);
      }
      writeState(result.state, root);
      appendJournal(runId, { ts: now, step: flag(argv, "--step") ?? "", patch }, root);
      process.stdout.write(`${renderCompact(result.state)}\n`);
      return;
    }
    case "get": {
      const [runId] = rest;
      if (!runId) die(2, "usage: rig-state get <runId> [--field <dotted.path>]");
      const state = readState(runId, root);
      const field = flag(argv, "--field");
      if (field) {
        const value = dig(state, field);
        if (value === undefined) process.exit(1);
        process.stdout.write(`${typeof value === "object" ? JSON.stringify(value) : String(value)}\n`);
        return;
      }
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
      return;
    }
    case "show": {
      const [runId] = rest;
      if (!runId) die(2, "usage: rig-state show <runId>");
      process.stdout.write(`${renderCompact(readState(runId, root))}\n`);
      return;
    }
    case "list": {
      const dir = stateDir(root);
      if (!existsSync(dir)) return;
      const want = flag(argv, "--skill");
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
        const state = JSON.parse(readFileSync(join(dir, file), "utf8")) as State;
        if (want && state.skill !== want) continue;
        process.stdout.write(
          `${state.runId}\t${state.skill}\t${state.phase}\t${state.updatedAt ?? ""}\t${state.nextAction ?? ""}\n`,
        );
      }
      return;
    }
    case "journal": {
      const [runId] = rest;
      if (!runId) die(2, "usage: rig-state journal <runId>");
      const path = journalPath(runId, root);
      if (!existsSync(path)) die(2, `no journal for '${runId}'`);
      process.stdout.write(readFileSync(path, "utf8"));
      return;
    }
    case "rm": {
      const [runId] = rest;
      if (!runId) die(2, "usage: rig-state rm <runId>");
      if (!validRunId(runId)) die(2, `run id '${runId}' is not a valid id`);
      for (const path of [statePath(runId, root), journalPath(runId, root)]) {
        if (existsSync(path)) rmSync(path);
      }
      return;
    }
    default:
      die(2, "usage: rig-state <init|patch|get|show|list|journal|rm> [args]");
  }
}

if (import.meta.main) main(process.argv.slice(2));
