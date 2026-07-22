#!/usr/bin/env bun
/**
 * scope-reviewer.ts — resolve the per-scope REVIEWER.md files that apply to a
 * changeset. Part of Rig (used by the rig-review skill).
 *
 * A REVIEWER.md holds the correctness invariants a subsystem has learned the
 * hard way. The root `.claude/REVIEWER.md` (or `rig/REVIEWER.md`) carries
 * repo-wide review lenses; scoped `<dir>/REVIEWER.md` files specialize them with
 * subsystem-specific assertions, colocated with the code they govern — the same
 * nesting model as a repo's nested `AGENTS.md`. This resolver walks each changed
 * file back to the repo root and collects EVERY ancestor `REVIEWER.md` on the
 * way; rig-review feeds the collected set to the reviewer so the LOCAL gate
 * asserts a scope's learned invariants before push, instead of the change
 * re-discovering them in PR review.
 *
 * Ancestor-walk alone under-covers when the code a scope governs is scattered
 * across sibling directories rather than nested under one — e.g. rules for a
 * subsystem whose handlers/helpers live elsewhere in the tree, sharing only a
 * far-too-broad common ancestor. So a `REVIEWER.md` may additionally declare an
 * explicit `governs:` block of path globs; a changed file matching any glob
 * pulls that scope in even though it doesn't live under the scope's directory.
 *
 * This is the READ side only. Harvesting new invariants back into a scope's
 * REVIEWER.md after a review is a deliberate, separate step — not automated here.
 *
 * Usage:
 *   scope-reviewer.ts [<base-ref>] [--json]        (run via bun, or a TS runner)
 *   scope-reviewer.ts --files <path> [<path> ...] [--json]
 *
 * Informational only — never exits non-zero. The reviewer, not this script, is
 * the gate.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path/posix";

/** The repo-root-relative path of a directory's REVIEWER.md (root → bare filename). */
export function reviewerFileFor(dir: string): string {
  return dir === "." || dir === "" ? "REVIEWER.md" : `${dir}/REVIEWER.md`;
}

/**
 * Every ancestor directory's REVIEWER.md that applies to the changed files,
 * deduped and sorted. `hasReviewer(dir)` reports whether a directory carries
 * one — injected so the walk is pure and testable without touching the fs.
 * Collects ALL ancestors on the path to root (not just the nearest), mirroring
 * how nested AGENTS.md all apply.
 */
export function collectScopeReviewerPaths(
  changedFiles: string[],
  hasReviewer: (dir: string) => boolean,
): string[] {
  const found = new Set<string>();
  for (const file of changedFiles) {
    let dir = dirname(file);
    while (true) {
      if (hasReviewer(dir)) found.add(reviewerFileFor(dir));
      if (dir === "." || dir === "" || dir === "/") break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...found].sort();
}

/** Matches a `REVIEWER.md` `governs:` block and captures its body. */
const GOVERNS_RE = /<!--\s*scope-reviewer:governs\b([\s\S]*?)-->/;

/**
 * The explicit path globs a `REVIEWER.md` declares it governs beyond its own
 * subtree, via a `<!-- scope-reviewer:governs ... -->` block (invisible in
 * rendered Markdown). Globs are newline- or comma-separated; comment lines
 * (`#`) and blanks are ignored. Returns `[]` when no block is present.
 */
export function parseGovernedGlobs(content: string): string[] {
  const m = content.match(GOVERNS_RE);
  if (!m) return [];
  // Drop comment/blank lines FIRST, then split the surviving lines on commas —
  // a comment line may itself contain commas (the seeded ads/billing blocks do),
  // and splitting on commas first would strand its later fragments as literal
  // globs since only the first fragment still starts with `#`.
  return m[1]
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => line.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Translate a repo-relative path glob to an anchored RegExp. `*` matches within
 * a single path segment; `**` matches across segments (any depth, including
 * none). Mirrors the subset of glob semantics used by tools like `git`/`tsc`.
 *
 * A whole-segment `**` (`a/**​/b`, or a leading `**​/b`) matches ZERO or more
 * segments, so `a/**​/b` matches both `a/b` and `a/x/y/b` — the slash on the
 * zero-segment side is folded into the optional group rather than left dangling.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // Whole-segment `**/`: match zero or more full path segments. Fold the
          // adjacent slash into the group so the zero-segment case has no stray
          // `//` — `a/**/b` matches `a/b`, and a leading `**/b` matches `b`.
          if (re.endsWith("\\/")) {
            re = `${re.slice(0, -2)}(?:/.*)?/`;
          } else {
            re += "(?:.*/)?";
          }
          i += 2; // consume the second `*` and the trailing `/`
        } else {
          re += ".*"; // trailing/unbounded `**`
          i++;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\/".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Whether `file` matches any of `globs`. */
export function matchesAnyGlob(file: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

/**
 * REVIEWER.md whose declared `governs:` globs match a changed file that does
 * NOT live under the scope's own directory (so the ancestor walk misses it).
 * `entries` pairs each REVIEWER.md path with the globs it declares. Deduped and
 * sorted, same as {@link collectScopeReviewerPaths}.
 */
export function collectGovernedReviewerPaths(
  changedFiles: string[],
  entries: { path: string; globs: string[] }[],
): string[] {
  const found = new Set<string>();
  for (const { path, globs } of entries) {
    if (globs.length && changedFiles.some((f) => matchesAnyGlob(f, globs))) found.add(path);
  }
  return [...found].sort();
}

/**
 * Resolve the applicable REVIEWER.md to `{ path, content }` records via an
 * injected fs (`exists`/`read` take repo-root-relative paths), so callers and
 * tests share one code path. Unions two sources: the ancestor walk, and — when
 * `fs.list` (all repo REVIEWER.md paths) is provided — any scope whose declared
 * `governs:` globs match a changed file. Without `list`, this is the pure
 * ancestor-walk behavior.
 */
export function resolveScopeReviewer(
  changedFiles: string[],
  fs: { exists: (p: string) => boolean; read: (p: string) => string; list?: () => string[] },
): { path: string; content: string }[] {
  const paths = new Set(collectScopeReviewerPaths(changedFiles, (dir) => fs.exists(reviewerFileFor(dir))));
  if (fs.list) {
    const entries = fs.list().map((path) => ({ path, globs: parseGovernedGlobs(fs.read(path)) }));
    for (const p of collectGovernedReviewerPaths(changedFiles, entries)) paths.add(p);
  }
  return [...paths].sort().map((path) => ({ path, content: fs.read(path) }));
}

function gitChangedFiles(base: string, root: string): string[] {
  // Capture stderr (rather than inheriting it) so a missing-base failure doesn't
  // spill git's raw error onto our stdout ahead of the JSON/text we control.
  // `--no-renames` splits a rename into its delete (old path) + add (new path)
  // so a file moved OUT of a governed tree still resolves the old scope's
  // REVIEWER.md — rename detection would emit only the destination path.
  const out = execFileSync("git", ["diff", "--no-renames", "--name-only", `${base}...HEAD`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Every tracked REVIEWER.md in the repo (root + any depth), for `governs:` resolution. */
function gitReviewerFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "REVIEWER.md", "*/REVIEWER.md"], { cwd: root, encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return []; // honor the "never exits non-zero" contract — degrade to ancestor-walk only
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

  const filesIdx = rest.indexOf("--files");
  let base = "origin/main";
  let changed: string[];
  if (filesIdx >= 0) {
    changed = rest.slice(filesIdx + 1);
  } else {
    base = rest[0] ?? "origin/main";
    try {
      changed = gitChangedFiles(base, root);
    } catch (err) {
      // Honor the "never exits non-zero" contract: a base ref that isn't
      // present locally (e.g. an unfetched integration branch from /rig-epic
      // review) must degrade gracefully, not spill a raw stack trace. Keep the
      // output shape consistent with the caller's requested mode so a machine
      // reader in --json mode still gets parseable JSON (empty scopes +
      // an error field), not a plain-text line it can't parse.
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      if (json) {
        console.log(JSON.stringify({ base, changed: 0, scopes: [], error: msg }, null, 2));
      } else {
        console.log(`No scope REVIEWER.md resolved — could not diff against base "${base}": ${msg}`);
      }
      return;
    }
  }

  const resolved = resolveScopeReviewer(changed, {
    exists: (p) => existsSync(join(root, p)),
    read: (p) => readFileSync(join(root, p), "utf8"),
    list: () => gitReviewerFiles(root),
  });

  if (json) {
    console.log(JSON.stringify({ base, changed: changed.length, scopes: resolved }, null, 2));
    return;
  }
  if (!resolved.length) {
    console.log(`No scope REVIEWER.md apply to the ${changed.length} changed file(s) vs ${base}.`);
    return;
  }
  console.log(`# Scope reviewer notes — ${resolved.length} scope(s) touched vs ${base}`);
  console.log("Treat each assertion below as a P1 the diff must satisfy for its scope.\n");
  for (const { path, content } of resolved) {
    console.log(`----- ${path} -----`);
    console.log(content.trimEnd());
    console.log("");
  }
}

if (import.meta.main) main();
