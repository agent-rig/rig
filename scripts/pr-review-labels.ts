#!/usr/bin/env bun
/**
 * pr-review-labels.ts — advisory PR-review labeler.
 *
 * This is NOT a gate. It never blocks a merge and reads no approval state. It
 * classifies the *diff* and emits a small set of descriptive labels so a
 * reviewer knows what kind of scrutiny a PR needs. Enforcement of "a human
 * reviewed" stays native (branch-protection review count + CODEOWNERS routing);
 * this just helps reviewers do the right thing.
 *
 * Three general lenses (a PR may get more than one):
 *   - "Review: Architecture"  — new package / module dir / dependency / migration,
 *                               OR a core-domain touch. Look for
 *                               extract-vs-duplicate + soundness.
 *   - "Review: Sensitive Path" — crown-jewel paths (auth / secrets / tenancy /
 *                               billing / infra). Security/tenancy scrutiny.
 *   - "Review: Large"          — big diff (excl. lockfiles/snapshots/baselines).
 *
 * ── CONFIGURE the path lists below for your repo ──
 * The heuristics are generic; the specific path globs are placeholders. Edit the
 * PLACEHOLDER arrays (SENSITIVE_PATHS, DOMAIN_PATHS, MIGRATION_DIRS, and the
 * new-package / new-module globs) to match your layout, then commit.
 *
 * Usage:  bun scripts/pr-review-labels.ts <pr-number> [owner/repo]
 * Emits label_architecture / label_sensitive / label_large booleans to
 * $GITHUB_OUTPUT for the workflow to sync. Always exits 0 (advisory only).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const LABEL_ARCHITECTURE = "Review: Architecture";
export const LABEL_SENSITIVE = "Review: Sensitive Path";
export const LABEL_LARGE = "Review: Large";

// A PR is "Large" past either bound (noise files below are excluded first).
export const FILE_THRESHOLD = 30;
export const LINE_THRESHOLD = 800;

// Generated / mechanical files excluded from the size budget.
const NOISE = [
  /(^|\/)bun\.lock(b)?$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /\.snap$/,
  /(^|\/)\.tsc-baseline\//,
  /(^|\/)\.eslint-baseline\//,
];
const isNoise = (f: string) => NOISE.some((rx) => rx.test(f));

// ─── PLACEHOLDER: crown-jewel paths → "Review: Sensitive Path" ───────────────
// Paths that warrant security / tenancy scrutiny. Root-anchored; a trailing "/"
// matches a directory prefix, no trailing "/" matches an exact file or its
// subtree. EDIT for your repo (examples shown — replace them).
export const SENSITIVE_PATHS = [
  "/src/auth/",
  "/src/kms/",
  "/src/billing/",
  "/infra/",
  "/.github/workflows/",
];

// ─── PLACEHOLDER: core-domain areas → contribute to "Review: Architecture" ───
// Foundational concept surfaces. A touch here flags Architecture even for a small
// diff (the blind spot: a domain decision built incrementally with nothing
// surfacing it). GROW as blind spots surface. EDIT for your repo.
export const DOMAIN_PATHS = [
  "/src/ledger/",
  "/src/billing/",
];

// ─── PLACEHOLDER: migration file locations (new file here ⇒ architectural) ───
// EDIT the globs to wherever your repo keeps DB migrations.
const MIGRATION_DIRS = [
  /(^|\/)migrations\/.+\.sql$/,
  /(^|\/)supabase\/migrations\/.+\.sql$/,
];

// ─── PLACEHOLDER: layout globs for structural "new X" detection ──────────────
// A newly-added file matching NEW_PACKAGE_MANIFEST marks a brand-new package.
// NEW_MODULE_DIR_PREFIX is a RegExp tested against a candidate directory path
// (with a trailing "/") to decide whether a newly-created dir counts as a "new
// module". EDIT both for your monorepo layout (defaults assume `packages/*`).
const NEW_PACKAGE_MANIFEST = /^packages\/[^/]+\/package\.json$/;
const NEW_MODULE_DIR_PREFIX = /^packages\/[^/]+\/src\/[^/]/;
// ─────────────────────────────────────────────────────────────────────────────

export type FileChange = {
  filename: string;
  additions: number;
  deletions: number;
  status?: string; // added | modified | removed | renamed
  patch?: string;
  previousFilename?: string; // for renames — the pre-rename path
};

/** gitignore-style glob → anchored RegExp. `*` stops at `/`, `**` crosses it. */
function globToRegExp(pat: string): RegExp {
  let out = "";
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === "*") {
      if (pat[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp("^" + out + "(/.*)?$");
}

/** Root-anchored CODEOWNERS-style match: dir prefixes (`foo/`), exact files, globs. */
export function matchesPattern(file: string, pattern: string): boolean {
  const p = pattern.replace(/^\//, "");
  if (!p) return false;
  if (p.endsWith("/")) return file.startsWith(p);
  if (!/[*?[\]]/.test(p)) return file === p || file.startsWith(p + "/");
  return globToRegExp(p).test(file);
}

/** Does a changed file touch a pattern (current OR pre-rename path)? */
export function touches(f: FileChange, pattern: string): boolean {
  return matchesPattern(f.filename, pattern) || (!!f.previousFilename && matchesPattern(f.previousFilename, pattern));
}

/**
 * Is the diff architectural? Structural markers (new package / new module dir /
 * new dependency / new migration) or a core-domain touch. `baseDirs` = dirs on
 * the base ref (for new-dir detection); pass `null` when unknown (trees-API
 * error/truncation) to skip the new-dir marker rather than false-fire.
 */
export function isArchitectural(files: FileChange[], baseDirs: Set<string> | null): boolean {
  // New package.
  if (files.some((f) => f.status === "added" && NEW_PACKAGE_MANIFEST.test(f.filename))) return true;

  // New migration.
  if (files.some((f) => f.status === "added" && MIGRATION_DIRS.some((rx) => rx.test(f.filename)))) return true;

  // New versioned dependency in a package.json.
  if (
    files.some(
      (f) =>
        /(^|\/)package\.json$/.test(f.filename) &&
        (f.patch ?? "")
          .split("\n")
          .some((l) => /^\+\s*"[^"]+"\s*:\s*"([\^~]?\d|\*|npm:|workspace:|github:|file:|https?:)/.test(l)),
    )
  ) {
    return true;
  }

  // Core-domain touch (current or pre-rename path).
  if (DOMAIN_PATHS.some((p) => files.some((f) => touches(f, p)))) return true;

  // New module directory — only when the base dir set is KNOWN (null = skip,
  // don't count every ancestor as new).
  if (baseDirs) {
    for (const f of files) {
      if (f.status !== "added") continue;
      const parts = f.filename.split("/");
      for (let i = parts.length - 1; i >= 1; i--) {
        const dir = parts.slice(0, i).join("/");
        if (!NEW_MODULE_DIR_PREFIX.test(dir + "/")) continue;
        if (!baseDirs.has(dir)) return true;
      }
    }
  }

  return false;
}

export type Labels = { architecture: boolean; sensitivePath: boolean; large: boolean };

/** Pure classifier: which advisory labels apply to this diff. */
export function classify(files: FileChange[], baseDirs: Set<string> | null): Labels {
  const effective = files.filter((f) => !isNoise(f.filename));
  const lines = effective.reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0);
  return {
    architecture: isArchitectural(files, baseDirs),
    sensitivePath: SENSITIVE_PATHS.some((p) => files.some((f) => touches(f, p))),
    large: effective.length > FILE_THRESHOLD || lines > LINE_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// gh wiring (only runs as a script; the logic above is pure + easily unit-tested)
// ---------------------------------------------------------------------------

function ghJson<T>(path: string): T {
  const out = execFileSync("gh", ["api", path, "-H", "Accept: application/vnd.github+json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as T;
}

function ghPaginate<T>(path: string): T[] {
  const all: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const chunk = ghJson<T[]>(`${path}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    all.push(...chunk);
    if (chunk.length < 100) break;
  }
  return all;
}

// Dirs on the base tree, or null when undeterminable (skip new-dir detection).
function baseDirsFromTree(repo: string, sha: string): Set<string> | null {
  try {
    const tree = ghJson<{ tree: { path: string; type: string }[]; truncated: boolean }>(
      `repos/${repo}/git/trees/${sha}?recursive=1`,
    );
    if (tree.truncated) return null;
    return new Set(tree.tree.filter((t) => t.type === "tree").map((t) => t.path));
  } catch {
    return null;
  }
}

function main() {
  const pr = Number(process.argv[2]);
  const repo = process.argv[3] ?? process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
  if (!pr || !repo) {
    console.error("usage: bun scripts/pr-review-labels.ts <pr-number> [owner/repo]");
    process.exit(2);
  }

  const meta = ghJson<{ base: { sha: string } }>(`repos/${repo}/pulls/${pr}`);
  const rawFiles = ghPaginate<{
    filename: string;
    additions: number;
    deletions: number;
    status: string;
    patch?: string;
    previous_filename?: string;
  }>(`repos/${repo}/pulls/${pr}/files`);
  const files: FileChange[] = rawFiles.map((f) => ({
    filename: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    status: f.status,
    patch: f.patch,
    previousFilename: f.previous_filename,
  }));
  const baseDirs = baseDirsFromTree(repo, meta.base.sha);
  const labels = classify(files, baseDirs);

  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    appendFileSync(
      ghOut,
      `label_architecture=${labels.architecture}\nlabel_sensitive=${labels.sensitivePath}\nlabel_large=${labels.large}\n`,
    );
  }

  const applied = [
    labels.architecture && LABEL_ARCHITECTURE,
    labels.sensitivePath && LABEL_SENSITIVE,
    labels.large && LABEL_LARGE,
  ].filter(Boolean);
  console.log(
    applied.length
      ? `PR #${pr} advisory labels: ${applied.join(", ")}`
      : `PR #${pr}: no advisory review labels (routine change).`,
  );
}

if (import.meta.main) main();
