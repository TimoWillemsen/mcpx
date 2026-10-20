// Fake OAuth 2.1 authorization server + protected MCP resource for tests.
// Implements what MCP clients see from typical remote servers: RFC 9728 resource
// metadata, RFC 8414 AS metadata, dynamic client registration, PKCE (S256),
// refresh tokens and revocation. A pre-registered confidential client
// ("preregistered" / "s3cret") is also accepted, for servers without DCR.
// /authorize auto-approves (simulating the user clicking "Allow"), unless the
// requested scope contains "deny".
// Prints {"port": N} on stdout once listening.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

let base = "";
const clients = new Map(); // client_id -> metadata
const PREREGISTERED = { client_id: "preregistered", client_secret: "s3cret" };
const codes = new Map(); // code -> { clientId, redirectUri, challenge, scope }
const accessTokens = new Map(); // token -> { expiresAt, scope }
const refreshTokens = new Map(); // token -> { clientId, scope }
const stats = { registrations: 0, refreshes: 0, revocations: 0 };

const id = () => randomBytes(16).toString("base64url");

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function basicClientId(req) {
  const basic = (req.headers.authorization ?? "").match(/^Basic (.+)$/);
  return basic ? decodeURIComponent(Buffer.from(basic[1], "base64").toString().split(":")[0]) : null;
}

/** client_secret from client_secret_post or client_secret_basic. */
function clientSecret(req, params) {
  const basic = (req.headers.authorization ?? "").match(/^Basic (.+)$/);
  if (basic) return decodeURIComponent(Buffer.from(basic[1], "base64").toString().split(":")[1] ?? "");
  return params.get("client_secret");
}

function issueTokens(clientId, scope) {
  const access = id();
  const refresh = id();
  accessTokens.set(access, { expiresAt: Date.now() + 3600_000, scope });
  refreshTokens.set(refresh, { clientId, scope });
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refresh,
    scope,
  };
}

function buildMcpServer() {
  const server = new McpServer({ name: "fixture-oauth", version: "1.0.0" });
  server.registerTool(
    "whoami",
    { description: "Returns a fixed identity" },
    async () => ({ content: [{ type: "text", text: "fixture-user" }] }),
  );
  server.registerTool(
    "echo",
    { description: "Echoes back the input", inputSchema: { message: z.string() } },
    async ({ message }) => ({ content: [{ type: "text", text: `Echo: ${message}` }] }),
  );
  return server;
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const path = url.pathname;

  // --- discovery
  if (path.startsWith("/.well-known/oauth-protected-resource")) {
    return json(res, 200, { resource: base, authorization_servers: [base], scopes_supported: ["read", "write"] });
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["read", "write"],
    });
  }

  // --- dynamic client registration
  if (path === "/register" && req.method === "POST") {
    const meta = JSON.parse(await readBody(req));
    const clientId = id();
    clients.set(clientId, meta);
    stats.registrations++;
    return json(res, 201, { ...meta, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
  }

  // --- authorization (auto-approve)
  if (path === "/authorize") {
    const p = url.searchParams;
    const redirectUri = p.get("redirect_uri");
    const client =
      p.get("client_id") === PREREGISTERED.client_id
        ? { redirect_uris: [redirectUri] } // any loopback redirect, like a native-app client
        : clients.get(p.get("client_id"));
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      return json(res, 400, { error: "invalid_request", error_description: "unknown client or redirect_uri" });
    }
    if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) {
      return json(res, 400, { error: "invalid_request", error_description: "PKCE S256 required" });
    }
    const target = new URL(redirectUri);
    target.searchParams.set("state", p.get("state") ?? "");
    const scope = p.get("scope") ?? "read write";
    if (scope.includes("deny")) {
      target.searchParams.set("error", "access_denied");
    } else {
      const code = id();
      codes.set(code, { clientId: p.get("client_id"), redirectUri, challenge: p.get("code_challenge"), scope });
      target.searchParams.set("code", code);
    }
    res.writeHead(302, { location: target.href });
    return res.end();
  }

  // --- token endpoint
  if (path === "/token" && req.method === "POST") {
    const p = new URLSearchParams(await readBody(req));
    if (p.get("grant_type") === "authorization_code") {
      const entry = codes.get(p.get("code"));
      codes.delete(p.get("code"));
      const verifier = p.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const clientId = p.get("client_id") ?? basicClientId(req);
      if (!entry || entry.clientId !== clientId || entry.redirectUri !== p.get("redirect_uri") || entry.challenge !== challenge) {
        return json(res, 400, { error: "invalid_grant" });
      }
      if (entry.clientId === PREREGISTERED.client_id && clientSecret(req, p) !== PREREGISTERED.client_secret) {
        return json(res, 401, { error: "invalid_client" });
      }
      return json(res, 200, issueTokens(entry.clientId, entry.scope));
    }
    if (p.get("grant_type") === "refresh_token") {
      const entry = refreshTokens.get(p.get("refresh_token"));
      if (!entry || entry.clientId !== p.get("client_id")) return json(res, 400, { error: "invalid_grant" });
      refreshTokens.delete(p.get("refresh_token")); // rotate
      stats.refreshes++;
      return json(res, 200, issueTokens(entry.clientId, entry.scope));
    }
    return json(res, 400, { error: "unsupported_grant_type" });
  }

  if (path === "/revoke" && req.method === "POST") {
    const p = new URLSearchParams(await readBody(req));
    const t = p.get("token");
    if (accessTokens.delete(t) || refreshTokens.delete(t)) stats.revocations++;
    res.writeHead(200);
    return res.end();
  }

  // --- test controls
  if (path === "/debug/stats") return json(res, 200, stats);
  if (path === "/debug/expire-access") {
    for (const t of accessTokens.values()) t.expiresAt = 0;
    return json(res, 200, { ok: true });
  }
  if (path === "/debug/revoke-all") {
    accessTokens.clear();
    refreshTokens.clear();
    return json(res, 200, { ok: true });
  }

  // --- protected MCP resource
  if (path === "/mcp") {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const entry = accessTokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
      return json(res, 401, { error: "invalid_token" }, {
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "null") : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await buildMcpServer().connect(transport);
    return transport.handleRequest(req, res, body);
  }

  res.writeHead(404);
  res.end();
});

http.listen(0, "127.0.0.1", () => {
  base = `http://127.0.0.1:${http.address().port}`;
  process.stdout.write(JSON.stringify({ port: http.address().port }) + "\n");
});
