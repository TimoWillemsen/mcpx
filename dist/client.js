import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { hasStoredTokens, McpxOAuthProvider, oauthOptions } from "./auth/provider.js";
import { isStdio, resolveServer, } from "./config.js";
import { authError, configError, connectionError, McpxError, timeoutError, } from "./errors.js";
import { createTransport } from "./transports.js";
import { VERSION } from "./version.js";
/**
 * Connect to a server, run `fn`, and always tear the connection down.
 * The whole thing is bounded by `timeoutMs` so a misbehaving server can never
 * make the CLI hang.
 */
export async function withSession(serverName, server, opts, fn) {
    const resolved = resolveServer(serverName, server);
    const authProvider = await storedAuthProvider(serverName, resolved);
    const handle = createTransport(resolved, { ...opts, authProvider });
    const sentCredentials = isStdio(resolved) || Boolean(authProvider) || hasAuthorizationHeader(resolved);
    const classify = (err) => classifyError(serverName, err, handle.stderrTail(), sentCredentials);
    const client = new Client({ name: "mcpx", version: VERSION });
    const abort = new AbortController();
    const requestOptions = { signal: abort.signal, timeout: opts.timeoutMs };
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            abort.abort();
            reject(timeoutError(`timed out after ${opts.timeoutMs}ms talking to "${serverName}"`));
        }, opts.timeoutMs);
    });
    const run = async () => {
        try {
            await client.connect(handle.transport, requestOptions);
        }
        catch (err) {
            throw classify(err);
        }
        try {
            return await fn({ client, requestOptions });
        }
        catch (err) {
            throw classify(err);
        }
    };
    try {
        return await Promise.race([run(), deadline]);
    }
    finally {
        clearTimeout(timer);
        await closeQuietly(client, handle);
    }
}
/**
 * Use OAuth credentials from `mcpx login` for HTTP servers that have them, unless
 * the config sets a static Authorization header (which then takes precedence).
 * The provider is non-interactive: if the tokens can't be refreshed, that's exit 2.
 */
async function storedAuthProvider(serverName, server) {
    if (isStdio(server) || hasAuthorizationHeader(server))
        return undefined;
    if (!(await hasStoredTokens(serverName, server.url)))
        return undefined;
    return new McpxOAuthProvider({ serverName, serverUrl: server.url, ...oauthOptions(server) });
}
export function hasAuthorizationHeader(server) {
    return Object.keys(server.headers ?? {}).some((k) => k.toLowerCase() === "authorization");
}
/**
 * Map transport/SDK errors onto mcpx errors with the right exit code.
 * Anything unrecognised becomes a connection error (exit 1).
 */
export function classifyError(serverName, err, stderr = "", 
/** Whether any credentials (header or stored OAuth tokens) were sent. */
sentCredentials = true) {
    if (err instanceof McpxError)
        return err;
    if (err instanceof UnauthorizedError) {
        return authError(`"${serverName}" requires authentication (run: mcpx login ${serverName})`);
    }
    if (err instanceof OAuthError) {
        return authError(`OAuth error from "${serverName}": ${err.errorCode}${err.message ? ` (${err.message})` : ""}; try: mcpx login ${serverName}`);
    }
    // Both HTTP transports report the HTTP status as `code`.
    const status = err instanceof StreamableHTTPError || err instanceof SseError ? err.code : undefined;
    if (status === 401 && !sentCredentials) {
        return authError(`"${serverName}" requires authentication (run: mcpx login ${serverName})`);
    }
    if (status === 401 || status === 403) {
        const what = status === 401 ? "rejected the credentials" : "denied access";
        return authError(`"${serverName}" ${what} (HTTP ${status}); check the Authorization header or run: mcpx login ${serverName}`);
    }
    const e = err;
    if (e?.code === "ENOENT" || e?.code === "EACCES") {
        return configError(`cannot start server "${serverName}": ${e.message} (check "command" in servers.json)`);
    }
    // fetch() wraps network failures as TypeError("fetch failed") with the real error in .cause.
    const causeText = e?.cause?.code ?? e?.cause?.message;
    const cause = causeText ? ` (${causeText})` : "";
    let message = `failed to talk to "${serverName}": ${e?.message ?? String(err)}${cause}`;
    if (stderr)
        message += `\nserver stderr:\n${stderr}`;
    return connectionError(message);
}
async function closeQuietly(client, handle) {
    const timeout = new Promise((resolve) => setTimeout(resolve, 2000).unref());
    const close = async () => {
        await handle.terminate().catch(() => { });
        await client.close().catch(() => { });
    };
    await Promise.race([close(), timeout]);
}
/** List every tool, following pagination cursors. */
export async function listAllTools(session) {
    const tools = [];
    let cursor;
    do {
        const page = await session.client.listTools(cursor ? { cursor } : undefined, session.requestOptions);
        tools.push(...page.tools);
        cursor = page.nextCursor;
    } while (cursor);
    return tools;
}
