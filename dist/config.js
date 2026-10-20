import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { configError } from "./errors.js";
const guardrails = {
    allowedTools: z.array(z.string()).optional(),
    readOnly: z.boolean().optional(),
};
const StdioServerSchema = z.strictObject({
    /** Accepted for compatibility with Claude Code / Cursor / Claude Desktop configs. */
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    ...guardrails,
});
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Bearer tokens must not cross the network in plaintext; plain http is only allowed locally. */
export function isSecureUrl(u) {
    try {
        const { protocol, hostname } = new URL(u);
        return protocol === "https:" || (protocol === "http:" && LOCAL_HOSTS.has(hostname));
    }
    catch {
        return false;
    }
}
const HttpUrlSchema = z.url().refine(isSecureUrl, { message: "url must use https (http is only allowed for localhost)" });
const OAuthOptionsSchema = z.strictObject({
    /** Space-separated scopes to request, e.g. "read" for read-only access. */
    scope: z.string().optional(),
    /** Local port for the login callback (default 33418). */
    callbackPort: z.number().int().min(1024).max(65535).optional(),
    /**
     * Pre-registered client, for servers without dynamic client registration.
     * clientSecret may use ${VAR} so it stays out of the file.
     */
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
});
const HttpServerSchema = z.strictObject({
    /** "sse" selects the legacy HTTP+SSE transport; everything else is Streamable HTTP. */
    type: z.enum(["http", "streamable-http", "streamableHttp", "sse"]).optional(),
    url: HttpUrlSchema,
    headers: z.record(z.string(), z.string()).optional(),
    oauth: OAuthOptionsSchema.optional(),
    ...guardrails,
});
export const isStdio = (s) => "command" in s;
/**
 * Directory holding servers.json and audit.log: $MCPX_CONFIG_DIR, else
 * $XDG_CONFIG_HOME/mcpx, else ~/.config/mcpx (on every platform).
 */
export function configDir() {
    if (process.env.MCPX_CONFIG_DIR)
        return process.env.MCPX_CONFIG_DIR;
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(base, "mcpx");
}
export function configPath() {
    return join(configDir(), "servers.json");
}
export function loadConfig(path = configPath()) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT") {
            throw configError(`config file not found: ${path}`);
        }
        throw configError(`cannot read config ${path}: ${err.message}`);
    }
    let json;
    try {
        json = JSON.parse(raw);
    }
    catch (err) {
        throw configError(`invalid JSON in ${path}: ${err.message}`);
    }
    // Accept both a bare map and the common {"mcpServers": {...}} wrapper.
    if (isObject(json) && "mcpServers" in json)
        json = json.mcpServers;
    if (!isObject(json)) {
        throw configError(`invalid config ${path}: expected an object of server name -> server`);
    }
    return { path, entries: json };
}
export function parseEntry(name, entry) {
    if (!isObject(entry) || !("command" in entry || "url" in entry)) {
        return { name, error: `must have either "command" (stdio) or "url" (http)` };
    }
    const schema = "command" in entry ? StdioServerSchema : HttpServerSchema;
    const parsed = schema.safeParse(entry);
    if (parsed.success)
        return { name, server: parsed.data };
    const issues = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ");
    return { name, error: issues };
}
export function listEntries(config) {
    return Object.entries(config.entries).map(([name, e]) => parseEntry(name, e));
}
export function getServer(config, name) {
    if (!Object.hasOwn(config.entries, name)) {
        const known = Object.keys(config.entries).join(", ") || "<none>";
        throw configError(`unknown server "${name}" (configured: ${known})`);
    }
    const entry = parseEntry(name, config.entries[name]);
    if (entry.error !== undefined) {
        throw configError(`invalid config for "${name}" in ${config.path}: ${entry.error}`);
    }
    return entry.server;
}
function isObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/**
 * Expand ${VAR} references from the process environment, so secrets can live in
 * the environment instead of servers.json. Errors name the variable, never a value.
 */
export function expandEnv(value, where) {
    return value.replace(ENV_REF, (_, name) => {
        const v = process.env[name];
        if (v === undefined || v === "") {
            throw configError(`${where} references \${${name}}, which is not set`);
        }
        return v;
    });
}
function expandRecord(rec, where) {
    if (!rec)
        return undefined;
    return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, expandEnv(v, `${where}.${k}`)]));
}
/** Returns a copy of the server config with ${VAR} references in env/headers expanded. */
export function resolveServer(name, server) {
    return isStdio(server)
        ? { ...server, env: expandRecord(server.env, `${name}.env`) }
        : {
            ...server,
            headers: expandRecord(server.headers, `${name}.headers`),
            ...(server.oauth && {
                oauth: {
                    ...server.oauth,
                    ...(server.oauth.clientSecret && {
                        clientSecret: expandEnv(server.oauth.clientSecret, `${name}.oauth.clientSecret`),
                    }),
                },
            }),
        };
}
