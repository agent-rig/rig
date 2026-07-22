import { describe, expect, it } from "bun:test";
import {
  collectGovernedReviewerPaths,
  collectScopeReviewerPaths,
  globToRegExp,
  matchesAnyGlob,
  parseGovernedGlobs,
  resolveScopeReviewer,
  reviewerFileFor,
} from "./scope-reviewer.ts";

// predicate: which directories contain a REVIEWER.md
const has =
  (dirs: string[]) =>
  (dir: string): boolean =>
    dirs.includes(dir);

describe("reviewerFileFor", () => {
  it("maps a nested dir to its REVIEWER.md", () => {
    expect(reviewerFileFor("packages/api/src/orders")).toBe("packages/api/src/orders/REVIEWER.md");
  });
  it("maps the repo root ('.' or '') to a bare filename", () => {
    expect(reviewerFileFor(".")).toBe("REVIEWER.md");
    expect(reviewerFileFor("")).toBe("REVIEWER.md");
  });
});

describe("collectScopeReviewerPaths", () => {
  it("collects EVERY ancestor REVIEWER.md on the path to root, not just the nearest", () => {
    const dirs = ["packages/api/src/orders", "packages/api/src/orders/experiments"];
    const changed = ["packages/api/src/orders/experiments/foo.ts"];
    expect(collectScopeReviewerPaths(changed, has(dirs))).toEqual([
      "packages/api/src/orders/REVIEWER.md",
      "packages/api/src/orders/experiments/REVIEWER.md",
    ]);
  });

  it("includes a root-level REVIEWER.md as a bare filename", () => {
    expect(collectScopeReviewerPaths(["scripts/x.ts"], has(["."]))).toEqual(["REVIEWER.md"]);
  });

  it("dedupes when multiple changed files share one scope", () => {
    const changed = ["packages/api/src/orders/a.ts", "packages/api/src/orders/b.ts"];
    expect(collectScopeReviewerPaths(changed, has(["packages/api/src/orders"]))).toEqual([
      "packages/api/src/orders/REVIEWER.md",
    ]);
  });

  it("returns nothing when no ancestor of any changed file has a REVIEWER.md", () => {
    expect(collectScopeReviewerPaths(["packages/app/src/x.tsx"], has([]))).toEqual([]);
  });

  it("does NOT include a scope whose REVIEWER.md no changed file lives under", () => {
    // payments has a REVIEWER.md, but the only change is under orders
    expect(
      collectScopeReviewerPaths(["packages/api/src/orders/a.ts"], has(["packages/api/src/payments"])),
    ).toEqual([]);
  });

  it("collects from multiple distinct touched scopes, sorted deterministically", () => {
    const dirs = ["packages/api/src/orders", "packages/api/src/payments"];
    const changed = ["packages/api/src/payments/x.ts", "packages/api/src/orders/y.ts"];
    expect(collectScopeReviewerPaths(changed, has(dirs))).toEqual([
      "packages/api/src/orders/REVIEWER.md",
      "packages/api/src/payments/REVIEWER.md",
    ]);
  });

  it("checks only the root for a file at repo root (no directory segment)", () => {
    expect(collectScopeReviewerPaths(["README.md"], has(["."]))).toEqual(["REVIEWER.md"]);
    expect(collectScopeReviewerPaths(["README.md"], has(["packages/api/src/orders"]))).toEqual([]);
  });
});

describe("resolveScopeReviewer", () => {
  it("reads the content of each collected REVIEWER.md via the injected fs", () => {
    const fsq = {
      exists: (p: string) => p === "packages/api/src/orders/REVIEWER.md",
      read: (p: string) => `content of ${p}`,
    };
    expect(resolveScopeReviewer(["packages/api/src/orders/a.ts"], fsq)).toEqual([
      { path: "packages/api/src/orders/REVIEWER.md", content: "content of packages/api/src/orders/REVIEWER.md" },
    ]);
  });

  it("returns an empty list when no scope REVIEWER.md apply", () => {
    const fsq = { exists: () => false, read: () => "" };
    expect(resolveScopeReviewer(["packages/app/src/x.tsx"], fsq)).toEqual([]);
  });

  it("unions ancestor-walk with governs-glob scopes when fs.list is provided", () => {
    // orders/REVIEWER.md governs channels via a governs block; the changed file
    // is under channels (NOT under orders), so only the governs mapping pulls it in.
    const files = {
      "packages/api/src/orders/REVIEWER.md":
        "# orders\n<!-- scope-reviewer:governs\npackages/api/src/channels/**\n-->",
    } as Record<string, string>;
    const fsq = {
      exists: (p: string) => p in files,
      read: (p: string) => files[p] ?? "",
      list: () => Object.keys(files),
    };
    expect(resolveScopeReviewer(["packages/api/src/channels/tools.ts"], fsq)).toEqual([
      { path: "packages/api/src/orders/REVIEWER.md", content: files["packages/api/src/orders/REVIEWER.md"] },
    ]);
  });

  it("does not double-count a scope matched by BOTH ancestor walk and its own governs glob", () => {
    const files = {
      "packages/api/src/orders/REVIEWER.md": "# orders\n<!-- scope-reviewer:governs\npackages/api/src/orders/**\n-->",
    } as Record<string, string>;
    const fsq = {
      exists: (p: string) => p in files,
      read: (p: string) => files[p] ?? "",
      list: () => Object.keys(files),
    };
    const resolved = resolveScopeReviewer(["packages/api/src/orders/a.ts"], fsq);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.path).toBe("packages/api/src/orders/REVIEWER.md");
  });
});

describe("parseGovernedGlobs", () => {
  it("extracts newline- and comma-separated globs from a governs block", () => {
    const content = "# payments\n<!-- scope-reviewer:governs\na/**, b/*.ts\nc/d.ts\n-->\n## rules";
    expect(parseGovernedGlobs(content)).toEqual(["a/**", "b/*.ts", "c/d.ts"]);
  });
  it("ignores # comment lines and blanks inside the block", () => {
    const content = "<!-- scope-reviewer:governs\n  # a note\n\npackages/x/**\n-->";
    expect(parseGovernedGlobs(content)).toEqual(["packages/x/**"]);
  });
  it("drops comment lines that themselves contain commas (no stranded fragments)", () => {
    const content =
      "<!-- scope-reviewer:governs\n  # rules for pause, disable, and budget owner\n  packages/x/**\n-->";
    expect(parseGovernedGlobs(content)).toEqual(["packages/x/**"]);
  });
  it("returns [] when there is no governs block", () => {
    expect(parseGovernedGlobs("# just a heading\n- a rule")).toEqual([]);
  });
});

describe("globToRegExp / matchesAnyGlob", () => {
  it("`*` stays within one path segment", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/nested/a.ts")).toBe(false);
  });
  it("`**` spans path segments at any depth", () => {
    expect(globToRegExp("src/**").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/**").test("src/deep/nested/a.ts")).toBe(true);
  });
  it("a whole-segment `**` matches zero segments (direct child) as well as deep ones", () => {
    const g = "packages/x/**/foo.ts";
    expect(globToRegExp(g).test("packages/x/foo.ts")).toBe(true); // zero segments
    expect(globToRegExp(g).test("packages/x/bar/foo.ts")).toBe(true); // one segment
    expect(globToRegExp(g).test("packages/x/bar/baz/foo.ts")).toBe(true); // many
    expect(globToRegExp(g).test("packages/xy/foo.ts")).toBe(false); // segment boundary preserved
  });
  it("a leading whole-segment `**` matches zero segments too", () => {
    expect(globToRegExp("**/foo.ts").test("foo.ts")).toBe(true);
    expect(globToRegExp("**/foo.ts").test("a/b/foo.ts")).toBe(true);
  });
  it("escapes regex metacharacters in literal path parts", () => {
    expect(globToRegExp("a/b.ts").test("a/b.ts")).toBe(true);
    expect(globToRegExp("a/b.ts").test("a/bXts")).toBe(false); // the '.' is literal, not "any char"
  });
  it("prefix-globs a specific family like sync-*.ts", () => {
    const g = "packages/api/src/jobs/sync-*.ts";
    expect(matchesAnyGlob("packages/api/src/jobs/sync-release.ts", [g])).toBe(true);
    expect(matchesAnyGlob("packages/api/src/jobs/scheduled-job.ts", [g])).toBe(false);
  });
});

describe("collectGovernedReviewerPaths", () => {
  it("pulls in a scope whose glob matches a changed file outside its dir", () => {
    const entries = [
      { path: "packages/api/src/payments/REVIEWER.md", globs: ["packages/api/src/handlers/payments.ts"] },
    ];
    expect(collectGovernedReviewerPaths(["packages/api/src/handlers/payments.ts"], entries)).toEqual([
      "packages/api/src/payments/REVIEWER.md",
    ]);
  });
  it("ignores a scope whose globs match nothing in the changeset", () => {
    const entries = [{ path: "packages/api/src/orders/REVIEWER.md", globs: ["packages/api/src/channels/**"] }];
    expect(collectGovernedReviewerPaths(["packages/api/src/handlers/payments.ts"], entries)).toEqual([]);
  });
  it("ignores a scope that declares no globs", () => {
    const entries = [{ path: "packages/api/src/orders/REVIEWER.md", globs: [] }];
    expect(collectGovernedReviewerPaths(["packages/api/src/orders/a.ts"], entries)).toEqual([]);
  });
});
