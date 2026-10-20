import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve(__dirname, "../dist/cli.js");
const FIXTURE = resolve(__dirname, "fixtures/oauth-server.mjs");

let fixture: ChildProcess;
let base: string;
let dir: string;
let credFile: string;

const json = (s: string) => JSON.parse(s);
const env = () => ({
  ...process.env,
  MCPX_CONFIG_DIR: dir,
  MCPX_TEST_CREDENTIAL_FILE: credFile,
  FX_SECRET: "s3cret",
});

function mcpx(args: string[]) {
  const r = spawnSync("node", [CLI, ...args], { env: env(), encoding: "utf8", timeout: 20_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise((r) => srv.close(r));
  return port;
}

/**
 * Run `mcpx login`, and play the browser: when the authorization URL appears on
 * stderr, pass it to `browser` (which by default follows the redirect to the callback).
 */
async function login(
  server: string,
  browser: (authUrl: string) => Promise<void> = followRedirect,
  extraArgs: string[] = [],
) {
  const child = spawn("node", [CLI, "login", server, "--no-browser", ...extraArgs], { env: env() });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  let played = false;
  createInterface({ input: child.stderr }).on("line", (line) => {
    stderr += line + "\n";
    const m = line.match(/(https?:\/\/\S+\/authorize\S*)/);
    if (m && !played) {
      played = true;
      void browser(m[1]);
    }
  });
  const code = await new Promise<number | null>((r) => child.on("close", r));
  return { code, stdout, stderr };
}

async function followRedirect(authUrl: string) {
  const res = await fetch(authUrl, { redirect: "manual" });
  const location = res.headers.get("location");
  if (location) await fetch(location);
}

async function fixtureGet(path: string) {
  return (await fetch(`${base}${path}`)).json();
}

beforeAll(async () => {
  fixture = spawn("node", [FIXTURE], { stdio: ["ignore", "pipe", "inherit"] });
  const line = await new Promise<string>((r) => createInterface({ input: fixture.stdout! }).once("line", r));
  base = `http://127.0.0.1:${json(line).port}`;

  dir = mkdtempSync(join(tmpdir(), "mcpx-oauth-test-"));
  credFile = join(dir, "creds.json");
  const callbackPort = await freePort();
  writeFileSync(
    join(dir, "servers.json"),
    JSON.stringify({
      lin: { url: `${base}/mcp`, oauth: { callbackPort } },
      denied: { url: `${base}/mcp`, oauth: { callbackPort, scope: "deny" } },
      static: { url: `${base}/mcp`, headers: { Authorization: "Bearer x" } },
      local: { command: "node", args: ["-e", ""] },
      prereg: {
        url: `${base}/mcp`,
        oauth: { callbackPort, clientId: "preregistered", clientSecret: "${FX_SECRET}" },
      },
    }),
  );
});

afterAll(() => {
  fixture?.kill();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(credFile, { force: true });
});

describe("login", () => {
  it("requires login before any credentials exist (exit 2)", () => {
    const r = mcpx(["tools", "lin"]);
    expect(r.code).toBe(2);
    expect(json(r.stderr.split("\n").filter((l) => l.startsWith("{"))[0]).error.message).toMatch(
      /requires authentication \(run: mcpx login lin\)/,
    );
  });

  it("completes the OAuth flow, stores tokens and verifies them", async () => {
    const r = await login("lin");
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({
      server: "lin",
      loggedIn: true,
      refreshable: true,
      tools: 2,
      scope: "read write",
    });
    expect(r.stderr).toMatch(/code_challenge_method=S256/);

    const stored = json(readFileSync(credFile, "utf8")).lin;
    expect(stored.serverUrl).toBe(`${base}/mcp`);
    expect(stored.clientInformation.client_id).toBeTruthy();
    expect(stored.tokens.access_token).toBeTruthy();
    // Tokens are never printed.
    expect(r.stdout + r.stderr).not.toContain(stored.tokens.access_token);
    expect(r.stdout + r.stderr).not.toContain(stored.tokens.refresh_token);

    const call = mcpx(["--text", "call", "lin", "whoami"]);
    expect(call.code).toBe(0);
    expect(call.stdout.trim()).toBe("fixture-user");
  });

  it("reuses the client registration on a second login", async () => {
    await login("lin");
    const before = (await fixtureGet("/debug/stats")).registrations;
    await login("lin");
    expect((await fixtureGet("/debug/stats")).registrations).toBe(before);
  });

  it("refreshes an expired access token transparently and stores the new one", async () => {
    await login("lin");
    const oldToken = json(readFileSync(credFile, "utf8")).lin.tokens.access_token;
    const before = (await fixtureGet("/debug/stats")).refreshes;
    await fixtureGet("/debug/expire-access");

    const r = mcpx(["call", "lin", "echo", '{"message":"x"}']);
    expect(r.code).toBe(0);
    expect((await fixtureGet("/debug/stats")).refreshes).toBe(before + 1);
    expect(json(readFileSync(credFile, "utf8")).lin.tokens.access_token).not.toBe(oldToken);
  });

  it("exits 2 when the refresh token is no longer valid", async () => {
    await login("lin");
    await fixtureGet("/debug/revoke-all");
    const r = mcpx(["tools", "lin"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/mcpx login lin/);
  });

  it("exits 2 when the user denies access", async () => {
    const r = await login("denied");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/access_denied/);
  });

  it("exits 2 and aborts on a state mismatch", async () => {
    const r = await login("lin", async (authUrl) => {
      const res = await fetch(authUrl, { redirect: "manual" });
      const cb = new URL(res.headers.get("location")!);
      cb.searchParams.set("state", "forged");
      await fetch(cb);
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unexpected state/);
  });

  it("exits 2 when the user doesn't finish in time", async () => {
    const r = await login("lin", async () => {}, ["--wait", "1"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/not completed within/);
  });

  it("keeps existing tokens when a new login fails", async () => {
    await login("lin");
    await login("lin", async () => {}, ["--wait", "1"]);
    expect(mcpx(["tools", "lin"]).code).toBe(0);
  });

  it("exits 3 for stdio servers and servers with a static Authorization header", () => {
    expect(mcpx(["login", "local"]).code).toBe(3);
    expect(mcpx(["login", "static"]).code).toBe(3);
  });
});

describe("pre-registered clients", () => {
  it("logs in with a configured clientId/clientSecret without dynamic registration", async () => {
    const before = (await fixtureGet("/debug/stats")).registrations;
    const r = await login("prereg");
    expect(r.code).toBe(0);
    expect(json(r.stdout).loggedIn).toBe(true);
    expect(r.stderr).toMatch(/client_id=preregistered/);
    expect(r.stdout + r.stderr).not.toContain("s3cret");
    expect((await fixtureGet("/debug/stats")).registrations).toBe(before);
    expect(mcpx(["tools", "prereg"]).code).toBe(0);
  });
});

describe("doctor and OAuth", () => {
  it("reports a server that needs login, and the token state after login", async () => {
    const before = json(mcpx(["doctor", "lin"]).stdout).checks.find((c: { server?: string }) => c.server === "lin");
    expect(before.status).toBe("fail");
    expect(before.message).toMatch(/mcpx login lin/);
    await login("lin");
    const after = json(mcpx(["doctor", "lin"]).stdout).checks.find((c: { server?: string }) => c.server === "lin");
    expect(after.status).toBe("ok");
    expect(after.message).toMatch(/2 tools; auth: OAuth, token valid until/);
  });
});

describe("logout", () => {
  it("removes credentials and revokes the token", async () => {
    await login("lin");
    const before = (await fixtureGet("/debug/stats")).revocations;
    const r = mcpx(["logout", "lin"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toEqual({ server: "lin", loggedOut: true, revoked: true });
    expect((await fixtureGet("/debug/stats")).revocations).toBe(before + 1);
    expect(mcpx(["tools", "lin"]).code).toBe(2);
  });

  it("only revokes at the authorization server that issued the token", async () => {
    await login("lin");
    const creds = json(readFileSync(credFile, "utf8"));
    expect(typeof creds.lin.tokens.issuer).toBe("string");
    creds.lin.tokens.issuer = "https://other-issuer.example.com/";
    writeFileSync(credFile, JSON.stringify(creds));
    const before = (await fixtureGet("/debug/stats")).revocations;
    const r = mcpx(["logout", "lin"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toEqual({ server: "lin", loggedOut: true, revoked: false });
    expect((await fixtureGet("/debug/stats")).revocations).toBe(before);
  });

  it("reports when there was nothing to log out of", () => {
    const r = mcpx(["logout", "lin"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({ loggedOut: false, revoked: false });
  });
});

describe("credential binding", () => {
  it("does not send stored tokens to a server whose URL changed", async () => {
    await login("lin");
    const creds = json(readFileSync(credFile, "utf8"));
    creds.lin.serverUrl = "https://elsewhere.example.com/mcp";
    writeFileSync(credFile, JSON.stringify(creds));
    const r = mcpx(["tools", "lin"]);
    expect(r.code).toBe(2);
  });
});
