import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = resolve(__dirname, "../dist/cli.js");
const require = createRequire(import.meta.url);
const EVERYTHING = join(
  require.resolve("@modelcontextprotocol/server-everything/package.json"),
  "../dist/index.js",
);

let configDir: string;

function writeConfig(dir: string, config: unknown) {
  writeFileSync(join(dir, "servers.json"), JSON.stringify(config));
}

function mcpx(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    env: { ...process.env, MCPX_CONFIG_DIR: configDir, MCPX_OUTPUT: "", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const json = (s: string) => JSON.parse(s);

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "mcpx-test-"));
  writeConfig(configDir, {
    everything: {
      command: "node",
      args: [EVERYTHING, "stdio"],
      env: { SECRET_TOKEN: "do-not-print" },
    },
    missing: { command: "mcpx-definitely-not-a-binary" },
    ro: { command: "node", args: [EVERYTHING, "stdio"], readOnly: true },
    allow: { command: "node", args: [EVERYTHING, "stdio"], allowedTools: ["echo", "get-*"] },
    hangs: { command: "node", args: ["-e", "setInterval(() => {}, 1000)"] },
  });
});

afterAll(() => rmSync(configDir, { recursive: true, force: true }));

describe("output format", () => {
  it("defaults to JSON when stdout is not a terminal", () => {
    expect(json(mcpx(["servers"]).stdout).servers).toBeDefined();
  });

  it("uses MCPX_OUTPUT as the default", () => {
    const r = mcpx(["servers"], { MCPX_OUTPUT: "text" });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^everything\b/);
  });

  it("lets --json override MCPX_OUTPUT=text, for errors too", () => {
    const r = mcpx(["--json", "servers"], { MCPX_OUTPUT: "text" });
    expect(json(r.stdout).servers).toBeDefined();
    const e = mcpx(["--json", "tools", "nope"], { MCPX_OUTPUT: "text" });
    expect(e.code).toBe(3);
    expect(json(e.stderr).error.kind).toBe("config");
  });

  it("prints text errors with MCPX_OUTPUT=text", () => {
    const r = mcpx(["tools", "nope"], { MCPX_OUTPUT: "text" });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^mcpx: /);
  });

  it("rejects an invalid MCPX_OUTPUT as a usage error", () => {
    const r = mcpx(["servers"], { MCPX_OUTPUT: "yaml" });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(json(r.stderr).error.message).toContain("MCPX_OUTPUT");
  });

  it("rejects --json together with --text", () => {
    expect(mcpx(["--json", "--text", "servers"]).code).toBe(3);
  });
});

describe("servers", () => {
  it("lists servers as JSON without env values", () => {
    const r = mcpx(["servers"]);
    expect(r.code).toBe(0);
    const out = json(r.stdout);
    expect(out.servers.map((s: { name: string }) => s.name)).toEqual([
      "everything",
      "missing",
      "ro",
      "allow",
      "hangs",
    ]);
    expect(out.servers[0]).toMatchObject({
      transport: "stdio",
      command: "node",
      envKeys: ["SECRET_TOKEN"],
    });
    expect(r.stdout).not.toContain("do-not-print");
  });

  it("exits 3 when the config file is missing", () => {
    const r = mcpx(["servers"], { MCPX_CONFIG_DIR: join(configDir, "nope") });
    expect(r.code).toBe(3);
    expect(json(r.stderr).error.kind).toBe("config");
  });

  it("lists an invalid entry with its error, but exits 3 when it is used", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpx-bad-"));
    writeConfig(dir, { bad: { neither: true } });
    const list = mcpx(["servers"], { MCPX_CONFIG_DIR: dir });
    const use = mcpx(["tools", "bad"], { MCPX_CONFIG_DIR: dir });
    rmSync(dir, { recursive: true, force: true });
    expect(list.code).toBe(0);
    expect(json(list.stdout).servers[0]).toMatchObject({ name: "bad", error: expect.any(String) });
    expect(use.code).toBe(3);
    expect(json(use.stderr).error.message).toMatch(/invalid config for "bad"/);
  });

  it("exits 3 when the config is not an object", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpx-bad-"));
    writeConfig(dir, [1, 2]);
    const r = mcpx(["servers"], { MCPX_CONFIG_DIR: dir });
    rmSync(dir, { recursive: true, force: true });
    expect(r.code).toBe(3);
  });
});

describe("tools", () => {
  it("lists tools as JSON", () => {
    const r = mcpx(["tools", "everything"]);
    expect(r.code).toBe(0);
    const out = json(r.stdout);
    expect(out.server).toBe("everything");
    const echo = out.tools.find((t: { name: string }) => t.name === "echo");
    expect(echo).toMatchObject({ name: "echo", description: expect.any(String) });
  });

  it("lists tools as text with --text", () => {
    const r = mcpx(["--text", "tools", "everything"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^echo\t/m);
  });

  it("exits 3 for an unknown server", () => {
    const r = mcpx(["tools", "nope"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(json(r.stderr).error).toMatchObject({ kind: "config", exitCode: 3 });
  });

  it("exits 3 when the server command does not exist", () => {
    const r = mcpx(["tools", "missing"]);
    expect(r.code).toBe(3);
  });

  it("never hangs on an unresponsive server", () => {
    const start = Date.now();
    const r = mcpx(["--timeout", "1000", "tools", "hangs"]);
    expect(r.code).toBe(1);
    expect(json(r.stderr).error.kind).toBe("timeout");
    expect(Date.now() - start).toBeLessThan(8000);
  });
});

describe("describe", () => {
  it("returns the full tool definition including inputSchema", () => {
    const r = mcpx(["describe", "everything", "echo"]);
    expect(r.code).toBe(0);
    const { tool } = json(r.stdout);
    expect(tool.name).toBe("echo");
    expect(tool.inputSchema.properties.message).toBeDefined();
  });

  it("exits 3 for an unknown tool", () => {
    const r = mcpx(["describe", "everything", "nope"]);
    expect(r.code).toBe(3);
  });
});

describe("call", () => {
  it("returns the CallToolResult as JSON", () => {
    const r = mcpx(["call", "everything", "echo", '{"message":"hi"}']);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toEqual({
      content: [{ type: "text", text: "Echo: hi" }],
    });
  });

  it("prints text content with --text", () => {
    const r = mcpx(["--text", "call", "everything", "get-sum", '{"a":2,"b":3}']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("The sum of 2 and 3 is 5.");
  });

  it("exits 1 when the tool reports an error", () => {
    const r = mcpx(["call", "everything", "get-sum", '{"a":"x"}']);
    expect(r.code).toBe(1);
    expect(json(r.stdout).isError).toBe(true);
  });

  it("exits 1 for an unknown tool", () => {
    const r = mcpx(["call", "everything", "nope"]);
    expect(r.code).toBe(1);
  });

  it.each([["{bad"], ["[1,2]"], ['"str"']])("exits 3 for bad args %s", (args) => {
    const r = mcpx(["call", "everything", "echo", args]);
    expect(r.code).toBe(3);
    expect(json(r.stderr).error.kind).toBe("usage");
  });
});

describe("call with key=value arguments and --unwrap", () => {
  it("converts key=value pairs with the tool's schema", () => {
    const r = mcpx(["--text", "call", "everything", "get-sum", "a=2", "b=40"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("The sum of 2 and 40 is 42.");
  });

  it("exits 3 with a hint for an unknown argument, before calling the tool", () => {
    const r = mcpx(["call", "everything", "get-sum", "aa=1", "b=2"]);
    expect(r.code).toBe(3);
    expect(json(r.stderr).error.message).toMatch(/did you mean "a"/);
  });

  it("exits 3 for a value of the wrong type", () => {
    expect(mcpx(["call", "everything", "get-sum", "a=two", "b=1"]).code).toBe(3);
  });

  it("--unwrap prints structuredContent as JSON", () => {
    const r = mcpx(["call", "everything", "get-structured-content", "location=Chicago", "--unwrap"]);
    expect(r.code).toBe(0);
    expect(Object.keys(json(r.stdout)).sort()).toEqual(["conditions", "humidity", "temperature"]);
  });

  it("--unwrap prints plain text as-is", () => {
    const r = mcpx(["call", "everything", "echo", "message=hi there", "--unwrap"]);
    expect(r.stdout).toBe("Echo: hi there\n");
  });

  it("--unwrap still exits 1 for a tool error", () => {
    expect(mcpx(["call", "everything", "get-sum", '{"a":"x"}', "--unwrap"]).code).toBe(1);
  });
});

describe("doctor", () => {
  it("reports each check and exits 1 when something fails", () => {
    const r = mcpx(["--timeout", "3000", "doctor"]);
    expect(r.code).toBe(1);
    const out = json(r.stdout);
    expect(out.ok).toBe(false);
    const byServer = Object.fromEntries(
      out.checks.filter((c: { server?: string }) => c.server).map((c: { server: string; status: string }) => [c.server, c.status]),
    );
    expect(byServer).toMatchObject({ everything: "ok", missing: "fail", hangs: "fail" });
    expect(out.checks.find((c: { check: string }) => c.check === "node").status).toBe("ok");
  });

  it("checks one server and exits 0 when it is fine", () => {
    const r = mcpx(["doctor", "everything"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout).checks.filter((c: { server?: string }) => c.server)).toHaveLength(1);
  });

  it("--offline doesn't connect", () => {
    const r = mcpx(["--timeout", "3000", "doctor", "--offline"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout).checks.some((c: { check: string }) => c.check === "server")).toBe(false);
  });

  it("warns when servers.json is writable by others", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "mcpx-perm-"));
    writeConfig(dir, {});
    chmodSync(join(dir, "servers.json"), 0o666);
    const r = mcpx(["doctor", "--offline"], { MCPX_CONFIG_DIR: dir });
    rmSync(dir, { recursive: true, force: true });
    const perm = json(r.stdout).checks.find((c: { check: string }) => c.check === "config permissions");
    expect(perm.status).toBe("warn");
  });
});

describe("guardrails", () => {
  it("readOnly allows tools annotated readOnlyHint: true", () => {
    const r = mcpx(["call", "ro", "echo", '{"message":"hi"}']);
    expect(r.code).toBe(0);
  });

  it("readOnly blocks other tools with exit 4", () => {
    const r = mcpx(["call", "ro", "toggle-simulated-logging"]);
    expect(r.code).toBe(4);
    expect(json(r.stderr).error).toMatchObject({ kind: "policy", exitCode: 4 });
  });

  it("allowedTools supports exact names and prefix* patterns", () => {
    expect(mcpx(["call", "allow", "echo", '{"message":"hi"}']).code).toBe(0);
    expect(mcpx(["call", "allow", "get-sum", '{"a":1,"b":2}']).code).toBe(0);
    const r = mcpx(["call", "allow", "toggle-simulated-logging"]);
    expect(r.code).toBe(4);
    expect(json(r.stderr).error.message).toMatch(/not in allowedTools/);
  });

  it("tools hides blocked tools and reports how many; --all shows them marked", () => {
    const listed = json(mcpx(["tools", "ro"]).stdout);
    expect(listed.tools.map((t: { name: string }) => t.name)).not.toContain("toggle-simulated-logging");
    expect(listed.hiddenByPolicy).toBeGreaterThan(0);
    const all = json(mcpx(["tools", "ro", "--all"]).stdout);
    const toggle = all.tools.find((t: { name: string }) => t.name === "toggle-simulated-logging");
    expect(toggle.blocked).toMatch(/readOnly/);
  });

  it("servers without a policy report no hiddenByPolicy", () => {
    expect(json(mcpx(["tools", "everything"]).stdout).hiddenByPolicy).toBeUndefined();
  });

  it("describe still works for a blocked tool, and says it is blocked", () => {
    const r = mcpx(["describe", "ro", "toggle-simulated-logging"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout).blocked).toMatch(/readOnly/);
  });
});

describe("audit log", () => {
  const log = () =>
    readFileSync(join(configDir, "audit.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

  it("records every call with outcome and exit code, but never arguments or results", () => {
    mcpx(["call", "everything", "echo", '{"message":"audit-secret-123"}']);
    mcpx(["call", "allow", "toggle-simulated-logging"]);
    mcpx(["call", "everything", "get-sum", '{"a":"x"}']);
    const entries = log().slice(-3);
    expect(entries.map((e) => [e.server, e.tool, e.outcome, e.exitCode])).toEqual([
      ["everything", "echo", "ok", 0],
      ["allow", "toggle-simulated-logging", "blocked", 4],
      ["everything", "get-sum", "tool_error", 1],
    ]);
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(["durationMs", "exitCode", "outcome", "server", "tool", "ts"]);
    }
    const raw = readFileSync(join(configDir, "audit.log"), "utf8");
    expect(raw).not.toContain("audit-secret-123");
    expect(raw).not.toContain("Echo:");
  });

  it("is only readable by the user", () => {
    if (process.platform === "win32") return;
    expect(statSync(join(configDir, "audit.log")).mode & 0o777).toBe(0o600);
  });

  it("does not log commands other than call", () => {
    const before = log().length;
    mcpx(["tools", "everything"]);
    mcpx(["servers"]);
    expect(log().length).toBe(before);
  });
});

describe("usage", () => {
  it("exits 3 for an unknown command", () => {
    expect(mcpx(["bogus"]).code).toBe(3);
  });

  it("exits 3 for missing arguments", () => {
    expect(mcpx(["describe", "everything"]).code).toBe(3);
  });

  it("exits 0 for --help", () => {
    expect(mcpx(["--help"]).code).toBe(0);
  });
});
