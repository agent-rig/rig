#!/usr/bin/env bun
/**
 * check-review-p1.ts — block merge on unresolved, still-applicable P1
 * (blocking) findings from your AI review bot.
 *
 * Many review bots never use GitHub's APPROVED state; they post findings as
 * inline review threads whose first comment carries a severity marker (a "P1"
 * shields.io badge, or the literal word "blocking"). Teams routinely merge past
 * these. This gate fails while any such P1 thread is still open AND still
 * applies to the code, and goes green when none remain.
 *
 * "Still applies" = NOT outdated: when a later commit changes the hunk the
 * finding points at, GitHub marks the thread `isOutdated` and we ignore it — so
 * the normal fix-then-push flow clears the gate automatically. A finding
 * addressed elsewhere, or a deliberate won't-fix, must be resolved explicitly
 * (resolve the thread via the GitHub UI or `gh api graphql`).
 *
 * Scope: P1 (blocking) only — the P2/P3 nit-flow and the clean fast path stay
 * untouched.
 *
 * ── rig config this mirrors (.rig/config.json) ──────────────────
 *   review.bot        → the review bot whose threads gate the merge. Set the
 *                       bot's GitHub login below (or REVIEW_BOT_LOGIN env var).
 *   review.maxRounds  → not read here; consumed by the /rig-review fix loop that
 *                       resolves these findings. Documented so the pair is
 *                       discoverable together.
 *
 * Runs under bun OR node (plain TS, no deps; shells out to `gh`).
 *
 * Usage:  check-review-p1.ts <pr-number> [owner/repo]
 *   bun scripts/check-review-p1.ts 123 my-org/my-app
 *   node scripts/check-review-p1.ts 123 my-org/my-app   (after tsc/tsx)
 * Exit 1 if any unresolved, non-outdated P1 thread remains; 2 on bad usage.
 */
import { execFileSync } from "node:child_process";

// ── CONFIGURE ──────────────────────────────────────────────────────────────
// The GitHub login of your review bot. Replace the placeholder, or set the
// REVIEW_BOT_LOGIN env var. Matched as a case-insensitive SUBSTRING so both
// `<name>` and `<name>[bot]` threads are caught — exact equality would drop the
// `[bot]` variant and let the gate go green with a live P1.
const REVIEW_BOT_LOGIN = process.env.REVIEW_BOT_LOGIN ?? "<REVIEW_BOT_LOGIN>";
const BOT = new RegExp(REVIEW_BOT_LOGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

// A thread is "P1/blocking" if its first comment carries either marker.
const P1 = /badge\/P1-|(^|[^a-z])blocking([^a-z]|$)/i;
// ───────────────────────────────────────────────────────────────────────────

const pr = Number(process.argv[2]);
const repo = process.argv[3] ?? process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
if (!pr || !repo) {
  console.error("usage: check-review-p1.ts <pr-number> [owner/repo]");
  console.error("  (owner/repo may also come from GH_REPO / GITHUB_REPOSITORY)");
  process.exit(2);
}
const [owner, name] = repo.split("/");

const QUERY = `
query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      reviewThreads(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          isResolved isOutdated
          comments(first:1){ nodes{ author{login} body url } }
        }
      }
    }
  }
}`;

type Thread = {
  isResolved: boolean;
  isOutdated: boolean;
  comments: { nodes: { author: { login: string } | null; body: string; url: string }[] };
};

function fetchThreads(): Thread[] {
  const all: Thread[] = [];
  let cursor: string | null = null;
  do {
    const args = [
      "api", "graphql",
      "-f", `query=${QUERY}`,
      "-f", `owner=${owner}`,
      "-f", `name=${name}`,
      "-F", `pr=${pr}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const page = JSON.parse(out).data.repository.pullRequest.reviewThreads;
    all.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

const isBot = (t: Thread): boolean => {
  const c = t.comments.nodes[0];
  return !!c && !!c.author?.login && BOT.test(c.author.login);
};

// Synchronous sleep that works under both bun and node (no deps): block the
// thread with Atomics.wait on a throwaway shared buffer.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Race guard: a review-triggered run can fire before the bot's just-submitted
// inline threads are visible to the GraphQL reviewThreads API (eventual
// consistency). Inside that window we'd see ZERO bot threads and pass with a
// live P1. So if no bot thread is visible yet, poll briefly before concluding
// clean; stop the moment one appears. On a genuinely bot-free PR there's nothing
// to wait for, so it costs the full window once — set REVIEW_P1_MAX_WAIT_MS=0 to
// skip (e.g. local/manual runs).
const MAX_WAIT_MS = Number(process.env.REVIEW_P1_MAX_WAIT_MS ?? 15_000);
const POLL_INTERVAL_MS = 3_000;

let threads = fetchThreads();
const deadline = Date.now() + MAX_WAIT_MS;
while (!threads.some(isBot) && Date.now() < deadline) {
  sleepSync(POLL_INTERVAL_MS);
  threads = fetchThreads();
}

const offenders = threads.filter(
  (t) => isBot(t) && !t.isResolved && !t.isOutdated && P1.test(t.comments.nodes[0].body),
);

if (offenders.length) {
  console.error(
    `✗ ${offenders.length} unresolved P1 finding(s) still apply to PR #${pr} — resolve or dismiss before merge:\n`,
  );
  for (const t of offenders) {
    const c = t.comments.nodes[0];
    // First line is often `**<sub>![P1 Badge](...)</sub>  Title**` — strip the
    // badge markup to leave the finding title.
    const firstLine = c.body.split("\n")[0];
    const bold = firstLine.match(/\*\*(.+?)\*\*/)?.[1] ?? firstLine;
    const title = bold.replace(/<\/?sub>/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim() || "(finding)";
    console.error(`    • ${title}\n      ${c.url}`);
  }
  console.error(
    "\nAddress each (push a fix — the thread auto-outdates), or resolve it explicitly" +
      "\n(resolve the thread in the GitHub UI, or via `gh api graphql` resolveReviewThread) if it's a won't-fix.",
  );
  process.exit(1);
}

console.log(`✓ review-P1 gate: no unresolved, applicable P1 findings on PR #${pr}`);
