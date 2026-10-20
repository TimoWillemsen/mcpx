import { afterEach, describe, expect, it } from "vitest";
import { configDir, expandEnv, parseEntry, resolveServer } from "../src/config.js";
import { outputFormat, sanitizeForTerminal, table } from "../src/output.js";

describe("expandEnv", () => {
  afterEach(() => {
    delete process.env.MCPX_TEST_VAR;
  });

  it("substitutes ${VAR} references", () => {
    process.env.MCPX_TEST_VAR = "abc";
    expect(expandEnv("Bearer ${MCPX_TEST_VAR}", "x")).toBe("Bearer abc");
  });

  it("leaves strings without references alone", () => {
    expect(expandEnv("plain $NOT_A_REF", "x")).toBe("plain $NOT_A_REF");
  });

  it("throws a config error naming the variable when unset", () => {
    expect(() => expandEnv("${MCPX_TEST_VAR}", "srv.headers.Authorization")).toThrow(
      /srv\.headers\.Authorization references \$\{MCPX_TEST_VAR\}/,
    );
  });
});

describe("parseEntry", () => {
  it("accepts https and localhost http", () => {
    expect(parseEntry("a", { url: "https://mcp.example.com/mcp" }).error).toBeUndefined();
    expect(parseEntry("b", { url: "http://localhost:3000/mcp" }).error).toBeUndefined();
    expect(parseEntry("c", { url: "http://127.0.0.1:3000/mcp" }).error).toBeUndefined();
  });

  it("rejects plain http to remote hosts", () => {
    expect(parseEntry("a", { url: "http://mcp.example.com/mcp" }).error).toMatch(/https/);
  });

  it("rejects entries that are neither stdio nor http", () => {
    expect(parseEntry("a", { foo: 1 }).error).toMatch(/command.*url/);
  });

  it("rejects unknown keys", () => {
    expect(parseEntry("a", { command: "x", bogus: true }).error).toMatch(/bogus/);
  });
});

describe("compatibility with other clients' configs", () => {
  it('accepts "type" from Claude Code / Cursor / Claude Desktop entries', () => {
    expect(parseEntry("a", { type: "stdio", command: "x" }).error).toBeUndefined();
    expect(parseEntry("b", { type: "http", url: "https://x.example.com/mcp" }).error).toBeUndefined();
    expect(parseEntry("c", { type: "sse", url: "https://x.example.com/sse" }).error).toBeUndefined();
    expect(parseEntry("d", { type: "websocket", url: "https://x.example.com" }).error).toBeDefined();
  });
});

describe("configDir", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("prefers MCPX_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
    process.env.MCPX_CONFIG_DIR = "/a";
    expect(configDir()).toBe("/a");
    delete process.env.MCPX_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(configDir()).toMatch(/^[\\/]xdg[\\/]mcpx$/);
    delete process.env.XDG_CONFIG_HOME;
    expect(configDir()).toMatch(/\.config[\\/]mcpx$/);
  });
});

describe("resolveServer", () => {
  it("expands ${VAR} in oauth.clientSecret", () => {
    process.env.MCPX_TEST_VAR = "shh";
    const r = resolveServer("s", {
      url: "https://x.example.com/mcp",
      oauth: { clientId: "id", clientSecret: "${MCPX_TEST_VAR}" },
    });
    expect("url" in r && r.oauth?.clientSecret).toBe("shh");
    delete process.env.MCPX_TEST_VAR;
  });
});

describe("sanitizeForTerminal", () => {
  it("strips ANSI escapes and control characters but keeps newlines and tabs", () => {
    const evil = "ok\x1b[2J\x1b[1;1Hfake prompt\x1b]0;title\x07\r\nline2\tcol\x00\x08\x9b";
    expect(sanitizeForTerminal(evil)).toBe("okfake prompt\nline2\tcol");
  });

  it("leaves ordinary text, including unicode, alone", () => {
    const s = "Echo: héllo — ✓ 日本語\nsecond line";
    expect(sanitizeForTerminal(s)).toBe(s);
  });
});

describe("table", () => {
  const rows = [
    ["echo", "Echoes"],
    ["get-sum", "Adds"],
  ];

  it("uses tabs when not a TTY", () => {
    expect(table(rows, false)).toBe("echo\tEchoes\nget-sum\tAdds");
  });

  it("pads columns on a TTY", () => {
    expect(table(rows, true)).toBe("echo     Echoes\nget-sum  Adds");
  });
});

describe("outputFormat", () => {
  it("is text on a terminal and JSON when piped", () => {
    expect(outputFormat({}, true, {})).toBe("text");
    expect(outputFormat({}, false, {})).toBe("json");
  });

  it("takes MCPX_OUTPUT over the terminal check, and flags over both", () => {
    expect(outputFormat({}, true, { MCPX_OUTPUT: "json" })).toBe("json");
    expect(outputFormat({}, false, { MCPX_OUTPUT: "TEXT" })).toBe("text");
    expect(outputFormat({ json: true }, true, { MCPX_OUTPUT: "text" })).toBe("json");
    expect(outputFormat({ text: true }, false, { MCPX_OUTPUT: "json" })).toBe("text");
  });

  it("rejects an unknown MCPX_OUTPUT", () => {
    expect(() => outputFormat({}, false, { MCPX_OUTPUT: "yaml" })).toThrow(/MCPX_OUTPUT/);
  });
});
