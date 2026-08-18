import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the pi adapter's core invariant: the persona BODY lives once in
// agents/<name>.md and only the frontmatter is target-specific
// (pi/agents/<name>.yml). Nothing enforces that at runtime — install.sh just
// concatenates the two — so drift between the trees is caught here instead.

const ROOT = join(import.meta.dir, "..");
const AGENTS_DIR = join(ROOT, "agents");
const PI_AGENTS_DIR = join(ROOT, "pi", "agents");

/** pi built-ins, plus the tools pi-subagents contributes. */
const KNOWN_PI_TOOLS = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "intercom",
]);

/** Roles the skills rely on being unable to mutate the worktree. */
const READ_ONLY_ROLES = ["rig-architect", "rig-reviewer"];

const personaNames = readdirSync(AGENTS_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""))
  .sort();

/** Split a `---`-fenced markdown file into its frontmatter lines and body. */
function splitPersona(text: string): { frontmatter: string[]; body: string } {
  const lines = text.split("\n");
  const fences: number[] = [];
  for (const [i, line] of lines.entries()) {
    if (/^---\s*$/.test(line)) fences.push(i);
    if (fences.length === 2) break;
  }
  if (fences.length < 2) throw new Error("persona has no closing frontmatter fence");
  const [open, close] = fences as [number, number];
  return {
    frontmatter: lines.slice(open + 1, close),
    body: lines.slice(close + 1).join("\n").trim(),
  };
}

/** First value for `key:` in a list of frontmatter lines. */
function field(lines: string[], key: string): string | undefined {
  const hit = lines.find((l) => l.startsWith(`${key}:`));
  return hit?.slice(key.length + 1).trim();
}

function commaList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

it("finds personas to check", () => {
  expect(personaNames.length).toBeGreaterThan(0);
});

describe.each(personaNames)("%s", (name) => {
  const source = readFileSync(join(AGENTS_DIR, `${name}.md`), "utf-8");
  const piPath = join(PI_AGENTS_DIR, `${name}.yml`);

  it("has pi frontmatter, so the pi target doesn't silently skip it", () => {
    // install.sh warns and skips when this file is missing — a new persona
    // would land on Claude Code and quietly not exist on pi.
    expect(() => readFileSync(piPath, "utf-8")).not.toThrow();
  });

  it("keeps name and description byte-identical to the shared persona", () => {
    // These are what the model matches on when picking an agent; drift means
    // the same role behaves differently depending on the harness.
    const src = splitPersona(source).frontmatter;
    const pi = readFileSync(piPath, "utf-8").split("\n");
    expect(field(pi, "name")).toBe(field(src, "name"));
    expect(field(pi, "name")).toBe(name);
    expect(field(pi, "description")).toBe(field(src, "description"));
  });

  it("declares only tools pi actually has", () => {
    const tools = commaList(field(readFileSync(piPath, "utf-8").split("\n"), "tools"));
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(KNOWN_PI_TOOLS).toContain(tool);
  });

  it("does not let a child delegate further", () => {
    // The parent session is the orchestrator; nested fan-out is not our model.
    const tools = commaList(field(readFileSync(piPath, "utf-8").split("\n"), "tools"));
    expect(tools).not.toContain("subagent");
  });

  it("assembles into a well-formed pi agent definition", () => {
    // Mirrors assemble_pi_agent() in install.sh.
    const frontmatter = readFileSync(piPath, "utf-8");
    const { body } = splitPersona(source);
    const assembled = `---\n${frontmatter}---\n\n${body}`;
    const parsed = splitPersona(assembled);
    expect(field(parsed.frontmatter, "name")).toBe(name);
    expect(parsed.body).toBe(body);
    expect(parsed.body.length).toBeGreaterThan(0);
  });
});

describe.each(READ_ONLY_ROLES)("%s is read-only by construction", (name) => {
  it("has neither write nor edit", () => {
    // rig-review/rig-plan/rig-epic delegate to these for reporting only; the
    // guarantee is structural (no tool) rather than a plea in the prompt.
    const tools = commaList(field(readFileSync(join(PI_AGENTS_DIR, `${name}.yml`), "utf-8").split("\n"), "tools"));
    expect(tools).not.toContain("write");
    expect(tools).not.toContain("edit");
  });
});
