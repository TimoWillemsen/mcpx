import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INSTRUCTIONS, render, withBlock } from "../src/agents.js";

const CLI = resolve(__dirname, "../dist/cli.js");
let project: string;
let home: string;

function mcpx(args: string[]) {
  const r = spawnSync("node", [CLI, ...args], {
    cwd: project,
    // homedir() reads HOME on macOS/Linux and USERPROFILE on Windows.
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const read = (p: string) => readFileSync(join(project, p), "utf8");

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "mcpx-agent-project-"));
  home = mkdtempSync(join(tmpdir(), "mcpx-agent-home-"));
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("instructions", () => {
  it("prints markdown by default, not JSON", () => {
    const r = mcpx(["instructions"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(INSTRUCTIONS);
  });

  it.each(["skill", "cursor", "windsurf"])("renders %s with quoted YAML frontmatter", (format) => {
    const out = render(format as "skill");
    expect(out.startsWith("---\n")).toBe(true);
    // An unquoted description containing ": " is invalid YAML.
    expect(out).toMatch(/^description: ".*"$/m);
    expect(out).toContain(INSTRUCTIONS);
  });

  it("exits 3 for an unknown format", () => {
    expect(mcpx(["instructions", "--format", "nope"]).code).toBe(3);
  });
});

describe("setup-agent", () => {
  it("writes each agent's file in its own format", () => {
    const r = mcpx(["setup-agent", "claude", "cursor", "windsurf", "codex", "gemini", "copilot"]);
    expect(r.code).toBe(0);
    const actions = JSON.parse(r.stdout).results.map((x: { action: string }) => x.action);
    expect(actions).toEqual(Array(6).fill("created"));
    expect(read(".claude/skills/mcpx/SKILL.md")).toMatch(/^---\nname: mcpx\n/);
    expect(read(".cursor/rules/mcpx.mdc")).toMatch(/alwaysApply: false/);
    expect(read(".windsurf/rules/mcpx.md")).toMatch(/trigger: model_decision/);
    for (const f of ["AGENTS.md", "GEMINI.md", ".github/copilot-instructions.md"]) {
      expect(read(f)).toContain("<!-- mcpx:begin");
    }
  });

  it("writes Agent Skills to .agents/skills and Kiro skills to .kiro/skills", () => {
    expect(mcpx(["setup-agent", "skills", "kiro"]).code).toBe(0);
    for (const f of [".agents/skills/mcpx/SKILL.md", ".kiro/skills/mcpx/SKILL.md"]) {
      expect(read(f)).toMatch(/^---\nname: mcpx\ndescription: "/);
    }
    expect(mcpx(["setup-agent", "--global", "skills"]).code).toBe(0);
    expect(existsSync(join(home, ".agents/skills/mcpx/SKILL.md"))).toBe(true);
  });

  it("is idempotent", () => {
    mcpx(["setup-agent", "claude", "codex"]);
    const r = mcpx(["setup-agent", "claude", "codex"]);
    expect(JSON.parse(r.stdout).results.map((x: { action: string }) => x.action)).toEqual([
      "unchanged",
      "unchanged",
    ]);
  });

  it("keeps the user's content in shared files and updates its block in place", () => {
    writeFileSync(join(project, "AGENTS.md"), "# Project\n\nUse pnpm.\n");
    mcpx(["setup-agent", "agents"]);
    const stale = read("AGENTS.md").replace("### Workflow", "### Old workflow") + "\n## After\n";
    writeFileSync(join(project, "AGENTS.md"), stale);
    const r = mcpx(["setup-agent", "agents"]);
    expect(JSON.parse(r.stdout).results[0].action).toBe("updated");
    const out = read("AGENTS.md");
    expect(out.startsWith("# Project\n\nUse pnpm.\n\n<!-- mcpx:begin")).toBe(true);
    expect(out).toContain("### Workflow");
    expect(out).not.toContain("### Old workflow");
    expect(out.trimEnd().endsWith("## After")).toBe(true);
    expect(out.match(/mcpx:begin/g)).toHaveLength(1);
  });

  it("installs globally under the home directory", () => {
    const r = mcpx(["setup-agent", "--global", "claude", "codex", "gemini"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(home, ".claude/skills/mcpx/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".codex/AGENTS.md"))).toBe(true);
    expect(existsSync(join(home, ".gemini/GEMINI.md"))).toBe(true);
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
  });

  it("uses a block in Windsurf's shared global rules file", () => {
    const rules = join(home, ".codeium/windsurf/memories/global_rules.md");
    mkdirSync(join(home, ".codeium/windsurf/memories"), { recursive: true });
    writeFileSync(rules, "Be concise.\n");
    expect(mcpx(["setup-agent", "--global", "windsurf"]).code).toBe(0);
    const out = readFileSync(rules, "utf8");
    expect(out.startsWith("Be concise.\n\n<!-- mcpx:begin")).toBe(true);
  });

  it("writes nothing on --dry-run", () => {
    const r = mcpx(["setup-agent", "--dry-run", "claude"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ dryRun: true, results: [{ action: "created" }] });
    expect(existsSync(join(project, ".claude"))).toBe(false);
  });

  it("refuses to overwrite a file it didn't create, unless --force", () => {
    mkdirSync(join(project, ".cursor/rules"), { recursive: true });
    writeFileSync(join(project, ".cursor/rules/mcpx.mdc"), "my own rule\n");
    expect(mcpx(["setup-agent", "cursor"]).code).toBe(3);
    expect(read(".cursor/rules/mcpx.mdc")).toBe("my own rule\n");
    expect(mcpx(["setup-agent", "cursor", "--force"]).code).toBe(0);
    expect(read(".cursor/rules/mcpx.mdc")).toContain("managed by mcpx");
  });

  it("refuses to write through a symlinked file in the project", () => {
    const victim = join(home, "victim.txt");
    writeFileSync(victim, "precious\n");
    symlinkSync(victim, join(project, "AGENTS.md"));
    const r = mcpx(["setup-agent", "agents"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stderr).error.message).toMatch(/symlink/);
    expect(readFileSync(victim, "utf8")).toBe("precious\n");
  });

  it("refuses to write through a dangling symlink in the project", () => {
    const victim = join(home, "not-there-yet.md");
    symlinkSync(victim, join(project, "AGENTS.md"));
    const r = mcpx(["setup-agent", "agents"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stderr).error.message).toMatch(/symlink/);
    expect(existsSync(victim)).toBe(false);
  });

  it("refuses a target whose parent directory is a symlink out of the project", () => {
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(project, ".claude"));
    const r = mcpx(["setup-agent", "claude"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stderr).error.message).toMatch(/outside the project/);
    expect(existsSync(join(elsewhere, "skills"))).toBe(false);
  });

  it("does write through symlinks for global targets (dotfiles setups)", () => {
    const dotfiles = join(home, "dotfiles");
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, "AGENTS.md"), "# mine\n");
    mkdirSync(join(home, ".codex"));
    symlinkSync(join(dotfiles, "AGENTS.md"), join(home, ".codex/AGENTS.md"));
    expect(mcpx(["setup-agent", "--global", "codex"]).code).toBe(0);
    expect(readFileSync(join(dotfiles, "AGENTS.md"), "utf8")).toContain("mcpx:begin");
  });

  it("validates every agent before writing anything", () => {
    const r = mcpx(["setup-agent", "claude", "nope"]);
    expect(r.code).toBe(3);
    expect(existsSync(join(project, ".claude"))).toBe(false);
  });

  it("exits 3 for agents without a global location", () => {
    for (const a of ["cursor", "copilot", "agents"]) {
      expect(mcpx(["setup-agent", "--global", a]).code).toBe(3);
    }
  });
});

describe("withBlock", () => {
  it("appends to empty and non-empty content", () => {
    expect(withBlock("", "B\n")).toBe("B\n");
    expect(withBlock("A", "B\n")).toBe("A\n\nB\n");
  });
});
