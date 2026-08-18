#!/usr/bin/env bun
/**
 * check-style.ts — the deterministic half of the rig-proof skill: find the
 * writing-style violations that don't need a model.
 *
 * Rig's writing-style guide (`style.guideFile` in .rig/config.json, default
 * `.claude/STYLE.md`) is the single source of truth for how agents write prose.
 * A useful share of it is mechanically checkable: the banned filler and jargon
 * terms live in the guide as backticked words, either in `Instead of | Write`
 * tables or in sentences that tell you to cut something. This script HARVESTS
 * THOSE TERMS FROM THE GUIDE ITSELF and greps the target text for them, so it
 * can never drift from what the personas were told. Prune a rule from the
 * guide and this stops enforcing it; add a row to a table and it starts.
 *
 * It carries no style opinions of its own. The only judgment baked in here is
 * sentence length (guide rule "one idea per sentence"), and that threshold is
 * a flag.
 *
 * Everything else — buried conclusions, passive voice, hedge stacks, claims
 * with no file:line behind them — needs a reader, and is the model's half of
 * the rig-proof pass. Running this first means the model spends its attention
 * on judgment instead of on word-spotting.
 *
 * Usage:
 *   check-style.ts <file> [<file> ...] [--json] [--guide <path>]
 *   check-style.ts --stdin [--json] [--guide <path>]      (text on stdin)
 *   check-style.ts --terms [--json]                       (dump what it loaded)
 *
 *   --guide <path>       override the guide (default: style.guideFile, else
 *                        .claude/STYLE.md, else .rig/STYLE.md)
 *   --max-sentence <n>   flag sentences longer than n words (default 30; 0 off)
 *   --strict             exit 1 when there are findings (default: always 0 —
 *                        the rig-proof skill is the gate, not this script)
 *
 * Code is never flagged: fenced blocks, inline code spans (including ones that
 * wrap across lines), link targets, and YAML frontmatter are masked before
 * matching, so `leverage` in a snippet or a URL stays quiet. Expects prose —
 * point it at Markdown or piped text, not at a source file.
 */
import { existsSync, readFileSync } from "node:fs";

/** A banned term harvested from the guide, with where it came from. */
export interface Term {
  /** The literal term to look for, lowercased. */
  term: string;
  /** What the guide says to write instead, when it offers a replacement. */
  suggestion?: string;
  /** The guide rule this came from, e.g. "8. Cut filler". */
  rule: string;
}

export interface Finding {
  line: number;
  column: number;
  /** The text as it appears in the target. */
  match: string;
  rule: string;
  message: string;
}

/**
 * Curly quotes and dashes break literal matching: a guide that says
 * `it's worth noting that` must still match prose written with U+2019. Fold
 * both sides to ASCII before comparing.
 */
export function normalizeQuotes(s: string): string {
  return s.replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

/**
 * Is this harvested string actually a TERM, rather than an example sentence or
 * a code identifier that happened to be backticked?
 *
 * The guide backticks a lot of things — flags (`--filter`), identifiers
 * (`session.tenantId`), whole example sentences, link markup. Only word-shaped
 * runs are terms worth grepping for. This filter is what keeps the harvest
 * clean without the guide needing a machine-readable annex.
 */
export function isTermLike(s: string): boolean {
  return /^[a-z][a-z' -]{1,34}$/i.test(s) && !/\s{2,}/.test(s);
}

/** Every backticked span in a string, in order. */
function backticked(s: string): string[] {
  return [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
}

/**
 * The guide's rule sections, keyed by their heading label ("8. Cut filler").
 * Rules live under `### <n>. <title>`; anything before the first one is
 * preamble and carries no terms.
 */
export function guideSections(guide: string): { rule: string; body: string }[] {
  const out: { rule: string; body: string }[] = [];
  const re = /^###\s+(\d+\.\s*.+?)\s*$/gm;
  const heads = [...guide.matchAll(re)];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index! + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index! : guide.length;
    out.push({ rule: heads[i][1].trim(), body: guide.slice(start, end) });
  }
  return out;
}

/** Sentences that mark an example rather than state a rule. */
const EXAMPLE_MARKER = /\*\*(Do|Don't)/i;
/** Verbs that introduce something the guide is telling you not to write. */
const CUE = /\b(delete|cut|no|never|avoid|skip|omit|replace)\b/i;
/**
 * A cue sentence usually names the bad form AND the good one, so harvesting
 * every backtick in it would ban the guide's own recommendation. Two markers
 * separate them, pointing opposite ways:
 *
 *   "…, never `click [here]`"                     → bad form FOLLOWS
 *   "`it seems like it might be` is `it might be`" → bad form PRECEDES
 *
 * Take the first marker that appears and keep the side it points at.
 */
const BAD_FOLLOWS = /,\s*(?:not|never|rather than)\s+/i;
const BAD_PRECEDES = /\s+(?:is|becomes)\s+/i;

/** The slice of a cue sentence that holds the banned form. */
export function bannedSide(sentence: string): string {
  const after = sentence.match(BAD_FOLLOWS);
  const before = sentence.match(BAD_PRECEDES);
  if (after && (!before || after.index! < before.index!)) return sentence.slice(after.index! + after[0].length);
  if (before) return sentence.slice(0, before.index!);
  return sentence;
}

/** Terms from the `Instead of | Write` tables in a rule section. */
function tableTerms(body: string, rule: string): Term[] {
  const out: Term[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || /^\|[\s|:-]+\|?$/.test(t)) continue;
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|");
    if (cells.length < 2) continue;
    const suggestion = cells[1].trim().replace(/`/g, "") || undefined;
    for (const term of backticked(cells[0])) {
      if (isTermLike(term)) out.push({ term: term.toLowerCase(), suggestion, rule });
    }
  }
  return out;
}

/**
 * Terms from prose that tells you to cut something ("Delete words that survive
 * their own removal: `basically`, `essentially`, …").
 */
function proseTerms(body: string, rule: string): Term[] {
  const out: Term[] = [];
  // Drop table rows (handled above) and flatten wrapped lines so a sentence
  // split across three lines is still one sentence.
  const flat = body
    .split("\n")
    .filter((l) => !l.trim().startsWith("|"))
    .join(" ");
  // Split on sentence-final punctuation only. NOT on ":" — the guide's filler
  // list reads "Delete words that survive their own removal: `basically`, …",
  // and splitting at the colon strands the list from the cue verb that bans it.
  for (const raw of flat.split(/(?<=[.!?])\s+/)) {
    const sentence = raw.trim();
    if (!sentence || EXAMPLE_MARKER.test(sentence) || !CUE.test(sentence)) continue;
    for (const term of backticked(bannedSide(sentence))) {
      if (isTermLike(term)) out.push({ term: term.toLowerCase(), rule });
    }
  }
  return out;
}

/**
 * Every banned term the guide defines, deduped (first mention wins, so a term
 * with a replacement beats a bare mention of the same word).
 */
export function parseGuide(guide: string): Term[] {
  const seen = new Map<string, Term>();
  for (const { rule, body } of guideSections(normalizeQuotes(guide))) {
    for (const t of [...tableTerms(body, rule), ...proseTerms(body, rule)]) {
      const existing = seen.get(t.term);
      if (!existing) seen.set(t.term, t);
      else if (!existing.suggestion && t.suggestion) seen.set(t.term, t);
    }
  }
  return [...seen.values()].sort((a, b) => a.term.localeCompare(b.term));
}

/**
 * Blank out code and link targets, preserving every character position so
 * line/column arithmetic on the result still describes the original.
 */
export function maskCode(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/```[\s\S]*?```/g, blank) // fenced blocks
    .replace(/~~~[\s\S]*?~~~/g, blank)
    // Inline spans, INCLUDING ones that wrap across lines — a quoted example
    // sentence is routinely broken over three lines, and leaving it unmasked
    // reads it as the author's own prose. Bounded so one stray backtick can't
    // swallow the rest of the document.
    .replace(/`[^`]{1,400}`/g, blank)
    .replace(/\]\([^)\n]*\)/g, blank); // link targets
}

/** Line and 1-based column of an absolute offset. */
function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - (before.lastIndexOf("\n") + 1) + 1;
  return { line, column };
}

/**
 * A term becomes a whitespace-tolerant, word-bounded, case-insensitive regex.
 *
 * Whitespace is flexible so a term that wrapped across two lines still matches,
 * and a short suffix is allowed so the guide banning `leverage` also catches
 * "leveraged" and "leveraging" without the guide having to list every form.
 */
export function termRegExp(term: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]+");
  const lead = /^[a-z]/i.test(term) ? "\\b" : "";
  if (!/[a-z]$/i.test(term)) return new RegExp(`${lead}${escape(term)}`, "gi");

  // English drops the final "e" and turns "y" into "i" before a suffix, so a
  // literal stem+suffix would miss "leveraging" and "easily". Both branches
  // require one alternative, and the original spelling is among them.
  let body: string;
  if (/e$/i.test(term)) body = `${escape(term.slice(0, -1))}(?:e|es|ed|ing|ely)`;
  else if (/y$/i.test(term)) body = `${escape(term.slice(0, -1))}(?:y|ies|ied|ily)`;
  else body = `${escape(term)}(?:s|es|d|ed|ing|ly)?`;
  return new RegExp(`${lead}${body}\\b`, "gi");
}

/** Every banned-term hit in the text. */
export function findTermHits(text: string, terms: Term[]): Finding[] {
  const masked = maskCode(normalizeQuotes(text));
  const out: Finding[] = [];
  for (const t of terms) {
    for (const m of masked.matchAll(termRegExp(t.term))) {
      const { line, column } = position(masked, m.index!);
      const flat = m[0].replace(/\s+/g, " ");
      out.push({
        line,
        column,
        match: m[0].replace(/\s+/g, " "),
        rule: t.rule,
        message: t.suggestion ? `"${flat}" — write ${t.suggestion}` : `cut "${flat}"`,
      });
    }
  }
  return out;
}

/**
 * Blank out lines that are labels rather than prose: headings, table rows,
 * blockquote markers. A 12-column table row is not a run-on sentence, and a
 * heading has no verb to be long-winded with. Length-preserving, like maskCode.
 */
export function maskNonProse(text: string): string {
  // YAML frontmatter is metadata. A skill's `description` is a deliberate
  // keyword-and-trigger list, not a sentence, and reading it as prose flags
  // every well-written skill file.
  const withoutFrontmatter = text.replace(/^---\n[\s\S]*?\n---(?=\n|$)/, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  return withoutFrontmatter
    .split("\n")
    .map((line) => (/^\s*(#{1,6}\s|\||>)/.test(line) ? line.replace(/[^\n]/g, " ") : line))
    .join("\n");
}

/** Split on a separator while keeping each piece's absolute offset. */
function splitWithOffsets(text: string, sep: RegExp): { text: string; offset: number }[] {
  const re = new RegExp(sep.source, sep.flags.includes("g") ? sep.flags : `${sep.flags}g`);
  const out: { text: string; offset: number }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: text.slice(last, m.index), offset: last });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  out.push({ text: text.slice(last), offset: last });
  return out;
}

/**
 * Where one sentence ends and the next begins:
 *
 *   1. terminal punctuation followed by something that can start a sentence
 *      (the capital-letter lookahead keeps "e.g. foo" and "1.5" intact),
 *   2. a blank line, so a paragraph with no period can't swallow the next one,
 *   3. a newline into a list marker — a bullet is its own sentence even when
 *      the bullet before it never reached a period.
 */
const SENTENCE_BREAK = /(?<=[.!?])[ \t]*\n?[ \t]*(?=[A-Z"`(\[]|$)|\n[ \t]*\n|\n(?=[ \t]*(?:[-*+]\s|\d+[.)]\s))/;

/**
 * Sentences over `max` words (guide rule: one idea per sentence).
 *
 * Sentences wrap across lines, so this scans the whole text rather than line by
 * line — a 55-word sentence spread over four lines is exactly the case worth
 * catching. A blank line ends a sentence too, so a paragraph that never reaches
 * a period doesn't swallow the one after it.
 */
export function findLongSentences(text: string, max: number): Finding[] {
  if (max <= 0) return [];
  const masked = maskNonProse(maskCode(normalizeQuotes(text)));
  const out: Finding[] = [];
  for (const s of splitWithOffsets(masked, SENTENCE_BREAK)) {
    const words = s.text.trim().split(/\s+/).filter(Boolean);
    if (words.length <= max) continue;
    // Point at the first word, not at the leading whitespace.
    const lead = s.text.length - s.text.replace(/^\s+/, "").length;
    const { line, column } = position(masked, s.offset + lead);
    out.push({
      line,
      column,
      match: `${words.length} words`,
      rule: "one idea per sentence",
      message: `${words.length}-word sentence — split it (limit ${max})`,
    });
  }
  return out;
}

/** Both mechanical passes, ordered by position. */
export function checkText(text: string, terms: Term[], maxSentence: number): Finding[] {
  return [...findTermHits(text, terms), ...findLongSentences(text, maxSentence)].sort(
    (a, b) => a.line - b.line || a.column - b.column,
  );
}

/**
 * Where the guide lives: an explicit override, then `style.guideFile` from the
 * project profile, then the two locations rig installs to.
 */
export function resolveGuidePath(
  override: string | undefined,
  readConfig: () => string | undefined,
  exists: (p: string) => boolean,
): string | undefined {
  // An override that isn't there resolves to nothing rather than falling back:
  // silently checking a different guide than the one you named is worse than
  // saying you couldn't find it.
  if (override) return exists(override) ? override : undefined;
  const raw = readConfig();
  if (raw) {
    try {
      const configured = JSON.parse(raw)?.style?.guideFile;
      if (typeof configured === "string" && exists(configured)) return configured;
    } catch {
      // A malformed profile is not this script's problem — fall through to the
      // conventional locations rather than failing the whole pass.
    }
  }
  return [".claude/STYLE.md", ".rig/STYLE.md"].find(exists);
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const strict = args.includes("--strict");
  const wantTerms = args.includes("--terms");
  const useStdin = args.includes("--stdin");
  const guideIdx = args.indexOf("--guide");
  const maxIdx = args.indexOf("--max-sentence");
  const maxSentence = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 30;
  // Consume flag values BY POSITION. Matching on value would swallow a target
  // that happens to be the same path as --guide (checking the guide itself).
  const consumed = new Set([guideIdx, maxIdx].filter((i) => i >= 0).map((i) => i + 1));
  const files = args.filter((a, i) => !a.startsWith("--") && !consumed.has(i));

  const guidePath = resolveGuidePath(
    guideIdx >= 0 ? args[guideIdx + 1] : undefined,
    () => (existsSync(".rig/config.json") ? readFileSync(".rig/config.json", "utf8") : undefined),
    existsSync,
  );
  if (!guidePath) {
    const msg =
      guideIdx >= 0
        ? `guide not found: ${args[guideIdx + 1]}`
        : "no writing-style guide found — set style.guideFile, or pass --guide <path>";
    if (json) console.log(JSON.stringify({ error: msg, terms: 0, findings: [] }, null, 2));
    else console.log(msg);
    return;
  }

  const terms = parseGuide(readFileSync(guidePath, "utf8"));

  if (wantTerms) {
    if (json) console.log(JSON.stringify({ guide: guidePath, terms }, null, 2));
    else {
      console.log(`# ${terms.length} term(s) harvested from ${guidePath}\n`);
      for (const t of terms) console.log(`  ${t.term}${t.suggestion ? ` → ${t.suggestion}` : ""}   [${t.rule}]`);
    }
    return;
  }

  const targets: { name: string; text: string }[] = useStdin
    ? [{ name: "(stdin)", text: readFileSync(0, "utf8") }]
    : files.filter(existsSync).map((f) => ({ name: f, text: readFileSync(f, "utf8") }));

  if (!targets.length) {
    const msg = "nothing to check — pass one or more files, or --stdin";
    if (json) console.log(JSON.stringify({ guide: guidePath, terms: terms.length, error: msg, findings: [] }, null, 2));
    else console.log(msg);
    return;
  }

  const results = targets.map((t) => ({ file: t.name, findings: checkText(t.text, terms, maxSentence) }));
  const total = results.reduce((n, r) => n + r.findings.length, 0);

  if (json) {
    console.log(JSON.stringify({ guide: guidePath, terms: terms.length, total, files: results }, null, 2));
  } else if (!terms.length) {
    // Loud, because a silent zero-term parse looks exactly like clean prose.
    console.log(`⚠ ${guidePath} yielded 0 terms — the guide's rule sections may have been restructured.`);
  } else if (!total) {
    console.log(`✓ mechanical style pass clean (${terms.length} terms from ${guidePath})`);
  } else {
    console.log(`${total} mechanical style finding(s) — ${terms.length} terms from ${guidePath}\n`);
    for (const r of results) {
      if (!r.findings.length) continue;
      console.log(`----- ${r.file} -----`);
      for (const f of r.findings) console.log(`  ${f.line}:${f.column}  ${f.message}   [${f.rule}]`);
      console.log("");
    }
    console.log("These are the cheap ones. The rig-proof model pass covers buried");
    console.log("conclusions, passive voice, hedging, and unanchored claims.");
  }

  if (strict && total > 0) process.exit(1);
}

if (import.meta.main) main();
