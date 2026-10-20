import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = resolve(__dirname, "../dist/cli.js");
const FIXTURE = resolve(__dirname, "fixtures/http-server.mjs");
const TOKEN = "fixture-secret-token";

let fixture: ChildProcess;
let base: string;
let configDir: string;

function mcpx(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    env: { ...process.env, MCPX_CONFIG_DIR: configDir, FX_TOKEN: TOKEN, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const json = (s: string) => JSON.parse(s);

beforeAll(async () => {
  fixture = spawn("node", [FIXTURE], {
    env: { ...process.env, FIXTURE_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const line = await new Promise<string>((res) =>
    createInterface({ input: fixture.stdout! }).once("line", res),
  );
  base = `http://127.0.0.1:${json(line).port}`;

  configDir = mkdtempSync(join(tmpdir(), "mcpx-http-test-"));
  writeFileSync(
    join(configDir, "servers.json"),
    JSON.stringify({
      fx: { url: `${base}/mcp`, headers: { Authorization: "Bearer ${FX_TOKEN}" } },
      noauth: { url: `${base}/mcp` },
      redirect: { url: `${base}/redirect`, headers: { Authorization: "Bearer ${FX_TOKEN}" } },
      insecure: { url: "http://example.com/mcp" },
      readonly: {
        url: `${base}/mcp`,
        headers: { Authorization: "Bearer ${FX_TOKEN}" },
        readOnly: true,
      },
    }),
  );
});

afterAll(() => {
  fixture?.kill();
  rmSync(configDir, { recursive: true, force: true });
});

describe("streamable HTTP", () => {
  it("lists tools with a bearer token from the environment", () => {
    const r = mcpx(["tools", "fx"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout).tools.map((t: { name: string }) => t.name)).toEqual(["echo", "fail"]);
  });

  it("calls a tool", () => {
    const r = mcpx(["call", "fx", "echo", '{"message":"hi"}']);
    expect(r.code).toBe(0);
    expect(json(r.stdout).content[0].text).toBe("Echo: hi");
  });

  it("exits 1 when the tool reports an error", () => {
    const r = mcpx(["call", "fx", "fail"]);
    expect(r.code).toBe(1);
    expect(json(r.stdout).isError).toBe(true);
  });

  it("terminates its session on exit", async () => {
    mcpx(["tools", "fx"]);
    const res = await fetch(`${base}/debug/sessions`);
    expect(await res.json()).toEqual({ open: 0 });
  });

  it("exits 2 when the server rejects the token, without echoing it", () => {
    const r = mcpx(["tools", "fx"], { FX_TOKEN: "wrong-token" });
    expect(r.code).toBe(2);
    expect(json(r.stderr).error.kind).toBe("auth");
    expect(r.stderr + r.stdout).not.toContain("wrong-token");
  });

  it("exits 2 when no credentials are configured", () => {
    expect(mcpx(["tools", "noauth"]).code).toBe(2);
  });

  it("exits 3 when a referenced env var is unset", () => {
    const r = mcpx(["tools", "fx"], { FX_TOKEN: "" });
    expect(r.code).toBe(3);
    expect(json(r.stderr).error.message).toMatch(/\$\{FX_TOKEN\}/);
  });

  it("does not follow cross-origin redirects", () => {
    const r = mcpx(["tools", "redirect"]);
    expect(r.code).toBe(1);
    expect(json(r.stderr).error.message).toMatch(/not followed/);
  });

  it("readOnly blocks tools without annotations (fails safe)", () => {
    expect(mcpx(["call", "readonly", "echo", '{"message":"x"}']).code).toBe(0);
    const r = mcpx(["call", "readonly", "fail"]);
    expect(r.code).toBe(4);
    expect(json(r.stderr).error.message).toMatch(/has no annotations/);
  });

  it("refuses a plaintext test credential store outside the temp directory", () => {
    const outside = resolve(__dirname, "should-not-exist-creds.json");
    const r = mcpx(["logout", "fx"], { MCPX_TEST_CREDENTIAL_FILE: outside });
    expect(r.code).toBe(3);
    expect(json(r.stderr).error.message).toMatch(/temp directory/);
    expect(existsSync(outside)).toBe(false);
  });

  it("rejects plain http to non-local hosts", () => {
    const r = mcpx(["tools", "insecure"]);
    expect(r.code).toBe(3);
    expect(json(r.stderr).error.message).toMatch(/https/);
  });

  it("lists servers with header keys only, and invalid entries alongside valid ones", () => {
    const r = mcpx(["servers"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(TOKEN);
    const servers = json(r.stdout).servers;
    expect(servers[0]).toMatchObject({ name: "fx", transport: "http", headerKeys: ["Authorization"] });
    expect(servers.find((s: { name: string }) => s.name === "insecure").error).toMatch(/https/);
  });
});
