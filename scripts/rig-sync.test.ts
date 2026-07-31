import { describe, expect, test } from "bun:test";
import { computeDrift, hasDrift, parseSurfaceDoc, renderReport, type SurfaceEl } from "./rig-sync.ts";

const ep = (id: string, extra: Partial<SurfaceEl> = {}): SurfaceEl => ({ kind: "endpoint", id, ...extra });

describe("computeDrift — classification", () => {
  test("identical surfaces are all aligned, no drift", () => {
    const s = [ep("GET /notes"), ep("POST /notes")];
    const d = computeDrift(s, s);
    expect(d.summary).toMatchObject({ aligned: 2, missing: 0, undocumented: 0, diverged: 0 });
    expect(hasDrift(d)).toBe(false);
  });

  test("in spec, not in code -> missing (work)", () => {
    const d = computeDrift([ep("GET /notes"), ep("DELETE /notes/{id}")], [ep("GET /notes")]);
    expect(d.missing.map((m) => m.id)).toEqual(["DELETE /notes/{id}"]);
    expect(d.undocumented).toHaveLength(0);
    expect(hasDrift(d)).toBe(true);
  });

  test("in code, not in spec -> undocumented (doc)", () => {
    const d = computeDrift([ep("GET /notes")], [ep("GET /notes"), ep("GET /health")]);
    expect(d.undocumented.map((u) => u.id)).toEqual(["GET /health"]);
    expect(d.missing).toHaveLength(0);
  });

  test("same id, differing attrs -> diverged with changed=['attrs']", () => {
    const d = computeDrift(
      [ep("PUT /notes/{id}", { attrs: { semantics: "replace" } })],
      [ep("PUT /notes/{id}", { attrs: { semantics: "merge" } })],
    );
    expect(d.diverged).toHaveLength(1);
    expect(d.diverged[0]!.changed).toEqual(["attrs"]);
    expect(d.aligned).toHaveLength(0);
  });

  test("same id, differing role -> diverged with changed=['role']", () => {
    const d = computeDrift(
      [{ kind: "topic", id: "orders.filled", role: "producer" }],
      [{ kind: "topic", id: "orders.filled", role: "consumer" }],
    );
    expect(d.diverged[0]!.changed).toEqual(["role"]);
  });

  test("owner/ref are location metadata, ignored in equality", () => {
    const d = computeDrift(
      [ep("GET /notes", { owner: "spec", ref: "SPEC.md:5" })],
      [ep("GET /notes", { owner: "src", ref: "src/app.js:15" })],
    );
    expect(d.summary).toMatchObject({ aligned: 1, diverged: 0 });
  });

  test("directional: extra fields the spec doesn't declare are NOT divergence", () => {
    // spec just requires the endpoint exists; code adds role/owner/ref/extra attrs
    const d = computeDrift(
      [ep("GET /notes")],
      [ep("GET /notes", { role: "route", owner: "src", ref: "src/app.js:15", attrs: { auth: true } })],
    );
    expect(d.summary).toMatchObject({ aligned: 1, diverged: 0 });
  });

  test("directional: spec declaring a field the code omits/mismatches IS divergence", () => {
    const d = computeDrift([ep("GET /notes", { attrs: { auth: true } })], [ep("GET /notes", { attrs: { auth: false } })]);
    expect(d.diverged[0]!.changed).toEqual(["attrs"]);
  });

  test("empty vs empty is clean", () => {
    expect(hasDrift(computeDrift([], []))).toBe(false);
  });

  test("everything missing when code is empty", () => {
    const d = computeDrift([ep("GET /notes"), ep("POST /notes")], []);
    expect(d.summary).toMatchObject({ missing: 2, undocumented: 0 });
  });
});

describe("computeDrift — notes-api reference shape", () => {
  const spec = ["GET /notes", "POST /notes", "GET /notes/{id}", "PUT /notes/{id}", "DELETE /notes/{id}"].map((id) =>
    ep(id),
  );
  const code = ["GET /notes", "POST /notes", "GET /notes/{id}", "PATCH /notes/{id}", "GET /health"].map((id) => ep(id));

  test("reproduces the demo's drift: 3 aligned, PUT+DELETE missing, PATCH+/health undocumented", () => {
    const d = computeDrift(spec, code);
    expect(d.summary).toMatchObject({ aligned: 3, missing: 2, undocumented: 2, diverged: 0 });
    expect(d.missing.map((m) => m.id)).toEqual(["DELETE /notes/{id}", "PUT /notes/{id}"]);
    expect(d.undocumented.map((u) => u.id)).toEqual(["GET /health", "PATCH /notes/{id}"]);
  });
});

describe("invariants + summary", () => {
  test("declared invariants are carried through unchanged", () => {
    const inv = [{ assert: "every topic has exactly one producer" }];
    const d = computeDrift([ep("GET /x")], [ep("GET /x")], inv);
    expect(d.invariants).toEqual(inv);
    expect(d.summary.invariants).toBe(1);
  });
});

describe("renderReport", () => {
  const spec = ["GET /notes", "PUT /notes/{id}", "DELETE /notes/{id}"].map((id) => ep(id));
  const code = [ep("GET /notes"), ep("PATCH /notes/{id}", { ref: "src/app.js:36" }), ep("GET /health", { ref: "src/app.js:45" })];

  test("renders each drift class with counts", () => {
    const md = renderReport(computeDrift(spec, code, [{ assert: "no undocumented endpoints" }]), {
      project: "notes-api",
      truth: "ask",
    });
    expect(md).toContain("# DRIFT — notes-api");
    expect(md).toContain("## Missing");
    expect(md).toContain("`DELETE /notes/{id}`");
    expect(md).toContain("## Undocumented");
    expect(md).toContain("`GET /health` `src/app.js:45`"); // ref surfaced
    expect(md).toContain("## Invariants");
    expect(md).toContain("truth: `ask`");
  });

  test("says 'In sync' when there is no drift", () => {
    const md = renderReport(computeDrift([ep("GET /x")], [ep("GET /x")]));
    expect(md).toContain("In sync");
    expect(md).not.toContain("## Missing");
  });
});

describe("parseSurfaceDoc", () => {
  test("accepts a bare surface array", () => {
    const { surface, invariants } = parseSurfaceDoc('[{"kind":"endpoint","id":"GET /x"}]');
    expect(surface).toHaveLength(1);
    expect(invariants).toEqual([]);
  });

  test("accepts a { surface, invariants } envelope", () => {
    const { surface, invariants } = parseSurfaceDoc(
      '{"surface":[{"kind":"endpoint","id":"GET /x"}],"invariants":[{"assert":"a"}]}',
    );
    expect(surface).toHaveLength(1);
    expect(invariants).toEqual([{ assert: "a" }]);
  });
});
