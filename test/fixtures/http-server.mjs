// Minimal Streamable HTTP MCP server for tests. Requires `Authorization: Bearer <TOKEN>`.
// Prints {"port": N} on stdout once listening. GET /debug/sessions reports open sessions
// so tests can check that mcpx ends its session on exit.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const TOKEN = process.env.FIXTURE_TOKEN ?? "test-token";
const sessions = new Map();

function buildServer() {
  const server = new McpServer({ name: "fixture-http", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echoes back the input string",
      inputSchema: { message: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => ({ content: [{ type: "text", text: `Echo: ${message}` }] }),
  );
  server.registerTool(
    "fail",
    { description: "Always returns a tool error" },
    async () => ({ content: [{ type: "text", text: "boom" }], isError: true }),
  );
  return server;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const http = createServer(async (req, res) => {
  if (req.url === "/debug/sessions") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ open: sessions.size }));
  }
  if (req.url === "/redirect") {
    res.writeHead(307, { location: "https://example.com/mcp" });
    return res.end();
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { "www-authenticate": "Bearer" });
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }

  const body = req.method === "POST" ? await readBody(req) : undefined;
  const sid = req.headers["mcp-session-id"];
  let transport = sid ? sessions.get(sid) : undefined;

  if (!transport) {
    if (req.method !== "POST" || !isInitializeRequest(body)) {
      res.writeHead(400);
      return res.end("no session");
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport),
    });
    transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
    await buildServer().connect(transport);
  }
  await transport.handleRequest(req, res, body);
});

http.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: http.address().port }) + "\n");
});
