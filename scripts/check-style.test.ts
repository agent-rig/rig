import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  bannedSide,
  checkText,
  findLongSentences,
  findTermHits,
  guideSections,
  isTermLike,
  maskCode,
  maskNonProse,
  normalizeQuotes,
  parseGuide,
  resolveGuidePath,
  termRegExp,
  type Term,
} from "./check-style.ts";

/** A miniature guide with the same shape as templates/STYLE.md. */
const GUIDE = `# Writing style

Preamble prose with a \`backticked\` word that is not a rule.

## Rules

### 7. Concrete nouns

| Instead of | Write |
|---|---|
| \`leverage\`, \`utilize\` | \`use\` |
| \`robust\` | say what it does |

### 8. Cut filler

Delete words that survive their own removal: \`basically\`, \`in order to\`,
\`it's worth noting that\`. Delete hedge stacks too — \`it seems like it might be\`
is \`it might be\`, or better, go check.

### 9. No jargon

| Instead of | Write |
|---|---|
| \`blast radius\` | \`affected callers\` |

Never call work \`easy\` or \`trivial\`.

- **Do:** \`The handler calls getByToken.\`
- **Don't:** \`getByToken is called by the handler.\`
`;

describe("isTermLike", () => {
  it("accepts word-shaped runs", () => {
    for (const t of ["basically", "blast radius", "low-hanging fruit", "it's worth noting that"]) {
      expect(isTermLike(t)).toBe(true);
    }
  });
  it("rejects identifiers, flags, and example markup", () => {
    for (const t of ["session.tenantId", "--filter", "click [here](…)", "tests: 412 pass", "api/invoices.ts:88"]) {
      expect(isTermLike(t)).toBe(false);
    }
  });
  it("rejects runs too long to be a term", () => {
    expect(isTermLike("a".repeat(40))).toBe(false);
  });
});

describe("guideSections", () => {
  it("splits on numbered rule headings and drops the preamble", () => {
    const rules = guideSections(GUIDE).map((s) => s.rule);
    expect(rules).toEqual(["7. Concrete nouns", "8. Cut filler", "9. No jargon"]);
  });
  it("keeps a rule's body with its heading", () => {
    const filler = guideSections(GUIDE).find((s) => s.rule.startsWith("8."))!;
    expect(filler.body).toContain("basically");
    expect(filler.body).not.toContain("blast radius");
  });
  it("returns nothing for a guide with no rule sections", () => {
    expect(guideSections("# Title\n\nJust prose.\n")).toEqual([]);
  });
});

describe("bannedSide", () => {
  it("takes the tail when the marker points forward", () => {
    expect(bannedSide("Descriptive link text: `good`, never `bad`.")).toContain("`bad`");
    expect(bannedSide("Descriptive link text: `good`, never `bad`.")).not.toContain("`good`");
  });
  it("takes the head when the marker points backward", () => {
    const s = "Delete hedge stacks — `it seems like it might be` is `it might be`.";
    expect(bannedSide(s)).toContain("it seems like it might be");
    expect(bannedSide(s)).not.toContain("`it might be`");
  });
  it("keeps the whole sentence when there is no marker", () => {
    const s = "Delete these: `basically`, `very`.";
    expect(bannedSide(s)).toBe(s);
  });
  it("honors whichever marker comes first", () => {
    const s = "Write `a`, not `b` — `c` is `d`.";
    // The forward marker appears first, so everything after it is in scope.
    expect(bannedSide(s)).toContain("`b`");
    expect(bannedSide(s)).not.toContain("`a`");
  });
});

describe("parseGuide", () => {
  const terms = parseGuide(GUIDE);
  const find = (t: string) => terms.find((x) => x.term === t);

  it("harvests table terms with their replacement", () => {
    expect(find("leverage")).toEqual({ term: "leverage", suggestion: "use", rule: "7. Concrete nouns" });
    expect(find("utilize")?.suggestion).toBe("use");
    expect(find("robust")?.suggestion).toBe("say what it does");
  });
  it("harvests a prose list introduced by a cue verb", () => {
    expect(find("basically")).toBeDefined();
    expect(find("in order to")).toBeDefined();
    expect(find("it's worth noting that")).toBeDefined();
  });
  it("harvests the bad half of a hedge sentence, not the recommended form", () => {
    expect(find("it seems like it might be")).toBeDefined();
    expect(find("it might be")).toBeUndefined();
  });
  it("does not harvest the guide's own Do/Don't examples", () => {
    expect(terms.some((t) => t.term.includes("getbytoken"))).toBe(false);
  });
  it("attributes each term to the rule it came from", () => {
    expect(find("blast radius")?.rule).toBe("9. No jargon");
    expect(find("easy")?.rule).toBe("9. No jargon");
  });
  it("ignores backticks in the preamble", () => {
    expect(find("backticked")).toBeUndefined();
  });
  it("returns terms sorted and deduped", () => {
    expect(terms.map((t) => t.term)).toEqual([...new Set(terms.map((t) => t.term))].sort());
  });
});

describe("normalizeQuotes", () => {
  it("folds curly apostrophes so a term still matches", () => {
    expect(normalizeQuotes("it’s")).toBe("it's");
  });
});

describe("maskCode", () => {
  it("blanks fenced blocks, inline spans, and link targets", () => {
    const masked = maskCode("a `leverage` b\n```\nleverage\n```\n[x](http://very-simple)");
    expect(masked).not.toContain("leverage");
    expect(masked).not.toContain("very-simple");
  });
  it("preserves length and line structure so offsets still hold", () => {
    const src = "a `bb` c\n```\nx\n```\nd";
    expect(maskCode(src).length).toBe(src.length);
    expect(maskCode(src).split("\n").length).toBe(src.split("\n").length);
  });
});

describe("maskNonProse", () => {
  it("blanks headings, table rows, and blockquotes", () => {
    const masked = maskNonProse("## robust\n| robust |\n> robust\nrobust");
    expect(masked.split("\n").filter((l) => l.includes("robust"))).toEqual(["robust"]);
  });
  it("blanks YAML frontmatter, which is metadata rather than prose", () => {
    const src = "---\nname: x\ndescription: robust robust robust\n---\n\nrobust\n";
    const masked = maskNonProse(src);
    expect(masked.split("\n").filter((l) => l.includes("robust"))).toEqual(["robust"]);
  });
  it("only blanks frontmatter at the very top of the file", () => {
    const src = "text\n\n---\ndescription: robust\n---\n";
    expect(maskNonProse(src)).toContain("robust");
  });
  it("preserves length", () => {
    const src = "## h\n| a |\ntext";
    expect(maskNonProse(src).length).toBe(src.length);
    const fm = "---\na: b\n---\nc";
    expect(maskNonProse(fm).length).toBe(fm.length);
  });
});

describe("termRegExp", () => {
  it("matches common inflections of a single word", () => {
    for (const form of ["leverage", "leverages", "leveraged", "leveraging"]) {
      expect(form.match(termRegExp("leverage"))).not.toBeNull();
    }
  });
  it("does not match a term embedded in a longer word", () => {
    expect("adjust the readjustment".match(termRegExp("just"))).toBeNull();
  });
  it("matches a multi-word term that wrapped across lines", () => {
    expect("the blast\nradius grew".match(termRegExp("blast radius"))).not.toBeNull();
  });
});

describe("findTermHits", () => {
  const terms: Term[] = [
    { term: "basically", rule: "8. Cut filler" },
    { term: "leverage", suggestion: "use", rule: "7. Concrete nouns" },
  ];

  it("reports line, column, and the guide's replacement", () => {
    const hits = findTermHits("ok line\nwe basically leverage it\n", terms);
    expect(hits.map((h) => [h.line, h.column, h.match])).toEqual([
      [2, 4, "basically"],
      [2, 14, "leverage"],
    ]);
    expect(hits[1].message).toBe('"leverage" — write use');
    expect(hits[0].message).toBe('cut "basically"');
  });
  it("ignores hits inside code", () => {
    expect(findTermHits("`basically` and\n```\nleverage\n```\n", terms)).toEqual([]);
  });
  it("flattens a wrapped match into one line of output", () => {
    const hits = findTermHits("we\nbasically ship", terms);
    expect(hits[0].match).toBe("basically");
  });
});

describe("findLongSentences", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

  it("catches a sentence that wraps across lines", () => {
    const text = `${words(20)}\n${words(20)}.`;
    expect(findLongSentences(text, 30)).toHaveLength(1);
    expect(findLongSentences(text, 30)[0].match).toBe("40 words");
  });
  it("leaves a sentence at the limit alone", () => {
    expect(findLongSentences(`${words(30)}.`, 30)).toEqual([]);
  });
  it("treats a list marker as a sentence break even with no period before it", () => {
    expect(findLongSentences(`- ${words(20)}\n- ${words(20)}\n`, 30)).toEqual([]);
  });
  it("treats a blank line as a sentence break", () => {
    expect(findLongSentences(`${words(20)}\n\n${words(20)}\n`, 30)).toEqual([]);
  });
  it("does not flag a wide table row or a long heading", () => {
    expect(findLongSentences(`| ${words(60)} |\n`, 30)).toEqual([]);
    expect(findLongSentences(`## ${words(60)}\n`, 30)).toEqual([]);
  });
  it("is off at 0", () => {
    expect(findLongSentences(`${words(200)}.`, 0)).toEqual([]);
  });
});

describe("checkText", () => {
  it("returns both passes ordered by position", () => {
    const terms: Term[] = [{ term: "basically", rule: "8. Cut filler" }];
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const found = checkText(`${long}.\nwe basically ship.\n`, terms, 30);
    expect(found.map((f) => f.line)).toEqual([1, 2]);
  });
});

describe("resolveGuidePath", () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);

  it("prefers an explicit override", () => {
    expect(resolveGuidePath("docs/S.md", () => undefined, exists(["docs/S.md", ".claude/STYLE.md"]))).toBe("docs/S.md");
  });
  it("resolves to nothing when the override is missing, rather than checking a different guide", () => {
    expect(resolveGuidePath("nope.md", () => undefined, exists([".claude/STYLE.md"]))).toBeUndefined();
  });
  it("reads style.guideFile from the profile", () => {
    const cfg = () => JSON.stringify({ style: { guideFile: "docs/house.md" } });
    expect(resolveGuidePath(undefined, cfg, exists(["docs/house.md"]))).toBe("docs/house.md");
  });
  it("falls back to the conventional locations when the profile points nowhere", () => {
    const cfg = () => JSON.stringify({ style: { guideFile: "gone.md" } });
    expect(resolveGuidePath(undefined, cfg, exists([".rig/STYLE.md"]))).toBe(".rig/STYLE.md");
  });
  it("prefers .claude/ over .rig/ when both exist", () => {
    expect(resolveGuidePath(undefined, () => undefined, exists([".claude/STYLE.md", ".rig/STYLE.md"]))).toBe(
      ".claude/STYLE.md",
    );
  });
  it("survives a malformed profile", () => {
    expect(resolveGuidePath(undefined, () => "{not json", exists([".claude/STYLE.md"]))).toBe(".claude/STYLE.md");
  });
  it("resolves to nothing when there is no guide anywhere", () => {
    expect(resolveGuidePath(undefined, () => undefined, exists([]))).toBeUndefined();
  });
});

// Guards the shipped guide against a restructure that silently breaks harvesting:
// the script's whole contract is that its rules come from STYLE.md, so a parse
// that quietly yields nothing would look exactly like clean prose.
describe("the shipped templates/STYLE.md", () => {
  const shipped = readFileSync(join(import.meta.dir, "..", "templates", "STYLE.md"), "utf8");
  const terms = parseGuide(shipped);

  it("still yields a substantial term list", () => {
    expect(terms.length).toBeGreaterThan(20);
  });
  it("covers the filler, vagueness, and jargon rules", () => {
    const byRule = new Set(terms.map((t) => t.rule.replace(/\..*/, "")));
    expect(byRule.has("7")).toBe(true);
    expect(byRule.has("8")).toBe(true);
    expect(byRule.has("9")).toBe(true);
  });
  it("harvests the terms the personas name explicitly", () => {
    const names = terms.map((t) => t.term);
    for (const t of ["basically", "simply", "just", "leverage", "functionality", "blast radius", "low-hanging fruit"]) {
      expect(names).toContain(t);
    }
  });
  it("is itself clean against its own mechanical rules", () => {
    expect(checkText(shipped, terms, 30)).toEqual([]);
  });
});
