import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercises scripts/rig-tracker.sh against a mock `gh` (RIG_TRACKER_GH), so the
// adapter's selection/link logic is gated without a live GitHub Project board.
// The ProjectV2 *write* paths (set-status/add-to-project) need a real board to
// integration-test and are intentionally not covered here.

const SCRIPT = join(import.meta.dir, "rig-tracker.sh");
const dir = mkdtempSync(join(tmpdir(), "rig-tracker-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A single mock `gh`: canned issue-list (honors --label AND --limit), project
// item-list (honors --limit), project field-list (Status options, for status
// validation), and pr view/edit (body comes from $MOCK_PR_BODY).
//
// The board deliberately returns a NON-Todo item first, so a naive candidate
// fetch that truncates by the result --limit (the #66 bug: next uses --limit 1)
// drops the dispatchable item out before the column intersection.
const mockGh = join(dir, "gh");
writeFileSync(
  mockGh,
  `#!/usr/bin/env bash
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  lbl=""; lim=1000
  for ((i=1;i<=$#;i++)); do
    [ "\${!i}" = "--label" ] && { j=$((i+1)); lbl="\${!j}"; }
    [ "\${!i}" = "--limit" ] && { j=$((i+1)); lim="\${!j}"; }
  done
  all='[{"number":10,"title":"Epic A","url":"u10","labels":[{"name":"epic"}],"state":"OPEN"},
       {"number":11,"title":"Sprint B","url":"u11","labels":[{"name":"sprint"}],"state":"OPEN"},
       {"number":12,"title":"Plain C","url":"u12","labels":[],"state":"OPEN"}]'
  if [ -n "$lbl" ]; then echo "$all" | jq -c --arg l "$lbl" --argjson n "$lim" '[.[]|select(.labels[]?.name==$l)][:$n]';
  else echo "$all" | jq -c --argjson n "$lim" '.[:$n]'; fi
  exit 0
fi
if [ "$1" = "project" ] && [ "$2" = "item-list" ]; then
  lim=1000; for ((i=1;i<=$#;i++)); do [ "\${!i}" = "--limit" ] && { j=$((i+1)); lim="\${!j}"; }; done
  echo '{"items":[{"id":"i11","content":{"number":11},"status":"Done"},
    {"id":"i10","content":{"number":10},"status":"Todo"},
    {"id":"i12","content":{"number":12},"status":"Todo"}]}' | jq -c --argjson n "$lim" '{items: (.items[:$n])}'
  exit 0
fi
if [ "$1" = "project" ] && [ "$2" = "field-list" ]; then
  echo '{"fields":[{"name":"Status","options":[{"name":"Todo","id":"o1"},{"name":"In Progress","id":"o2"},{"name":"In Review","id":"o3"},{"name":"Done","id":"o4"}]}]}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo "\${MOCK_PR_BODY:-a body}"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then echo "edited" >&2; exit 0; fi
echo "unexpected gh call: $*" >&2; exit 1
`,
);
chmodSync(mockGh, 0o755);

function config(obj: unknown): string {
  const p = join(dir, `cfg-${Math.abs(hash(JSON.stringify(obj)))}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function run(cfgPath: string, args: string[], extraEnv: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bash", SCRIPT, ...args], {
    env: { ...process.env, RIG_CONFIG: cfgPath, RIG_TRACKER_GH: mockGh, ...extraEnv },
  });
  return {
    code: p.exitCode,
    out: p.stdout.toString().trim(),
    err: p.stderr.toString().trim(),
  };
}

const GH = {
  tracker: {
    provider: "github",
    shapeLabels: { epic: "epic", sprint: "sprint" },
    board: { owner: "o", projectNumber: 1, statusField: "Status", statusOptions: { todo: "Todo", done: "Done" } },
  },
};

describe("rig-tracker select", () => {
  it("provider=none returns an empty set", () => {
    const r = run(config({ tracker: { provider: "none" } }), ["select"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  it("github, no filters → all open issues in contract shape", () => {
    const r = run(config(GH), ["select", "--limit", "50"]);
    expect(r.code).toBe(0);
    const items = JSON.parse(r.out);
    expect(items.map((i: any) => i.number).sort()).toEqual([10, 11, 12]);
    expect(items[0]).toHaveProperty("id");
    expect(items[0]).toHaveProperty("url");
    expect(items[0]).toHaveProperty("labels");
    expect(items[0]).toHaveProperty("blockedBy");
  });

  it("github, --label filters by label", () => {
    const r = run(config(GH), ["select", "--label", "epic"]);
    expect(JSON.parse(r.out).map((i: any) => i.number)).toEqual([10]);
  });

  it("--dispatchable = Todo column ∩ shape label (→ only Epic A)", () => {
    const r = run(config(GH), ["select", "--dispatchable"]);
    const items = JSON.parse(r.out);
    expect(items.map((i: any) => i.number)).toEqual([10]);
    expect(items[0].status).toBe("Todo"); // status is stamped on the board path
  });

  it("--status filters by board column (Todo → #10,#12)", () => {
    const r = run(config(GH), ["select", "--status", "Todo"]);
    expect(JSON.parse(r.out).map((i: any) => i.number).sort()).toEqual([10, 12]);
  });

  it("next = dispatchable, limit 1", () => {
    const r = run(config(GH), ["next"]);
    expect(JSON.parse(r.out)).toHaveLength(1);
  });

  it("next finds the dispatchable item even when it isn't first on the board (#66)", () => {
    // Board yields a Done item first; the result --limit of 1 must NOT truncate
    // the board/label candidates before the Todo∩shape intersection.
    const r = run(config(GH), ["next"]);
    expect(r.code).toBe(0);
    const items = JSON.parse(r.out);
    expect(items).toHaveLength(1);
    expect(items[0].number).toBe(10);
    expect(items[0].status).toBe("Todo");
  });
});

describe("rig-tracker select --status validation (#67)", () => {
  it("a column that doesn't exist on the board errors (not a silent [])", () => {
    const r = run(config(GH), ["select", "--status", "Nope"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not a column");
  });

  it("a valid but empty column returns [] with exit 0 (distinct from a typo)", () => {
    // "In Review" is a real board option with no items in it.
    const r = run(config(GH), ["select", "--status", "In Review"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });
});

describe("rig-tracker link-pr", () => {
  it("appends a closing ref when the body lacks one", () => {
    const r = run(config(GH), ["link-pr", "10", "99"], { MOCK_PR_BODY: "no refs here" });
    expect(JSON.parse(r.out)).toMatchObject({ linked: true, already: false });
  });

  it("is idempotent when the body already closes the issue", () => {
    const r = run(config(GH), ["link-pr", "10", "99"], { MOCK_PR_BODY: "Fixes #10 already" });
    expect(JSON.parse(r.out)).toMatchObject({ linked: true, already: true });
  });

  it("provider=none is a no-op", () => {
    const r = run(config({ tracker: { provider: "none" } }), ["link-pr", "1", "2"]);
    expect(JSON.parse(r.out)).toMatchObject({ linked: false });
  });
});

describe("rig-tracker dispatch", () => {
  it("unknown verb exits non-zero", () => {
    const r = run(config(GH), ["frobnicate"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("unknown verb");
  });
});
