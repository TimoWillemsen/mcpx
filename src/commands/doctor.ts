import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { auditLogPath } from "../audit.js";
import { credentialStore } from "../auth/store.js";
import { classifyError, hasAuthorizationHeader, listAllTools, withSession, type SessionOptions } from "../client.js";
import {
  configPath,
  isStdio,
  listEntries,
  loadConfig,
  resolveServer,
  type ServerConfig,
} from "../config.js";
import { ExitCode } from "../errors.js";
import { table, type CommandResult } from "../output.js";
import { checkTool } from "../policy.js";
import { autoUpdateBlocker, readState } from "../update.js";
import { VERSION } from "../version.js";

type Status = "ok" | "warn" | "fail";

interface Check {
  check: string;
  status: Status;
  message: string;
  server?: string;
}

export interface DoctorOptions extends SessionOptions {
  /** Skip connecting to servers. */
  offline?: boolean;
  /** Only check this server. */
  server?: string;
}

/**
 * Check everything mcpx depends on and report what's wrong, with a fix where
 * there is one. Never prompts; each server check is bounded by --timeout.
 */
export async function doctorCommand(opts: DoctorOptions): Promise<CommandResult> {
  const checks: Check[] = [];
  const add = (check: string, status: Status, message: string, server?: string) =>
    checks.push({ check, status, message, ...(server && { server }) });

  add("mcpx", "ok", VERSION);
  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 20 ? "ok" : "fail", major >= 20 ? process.version : `${process.version}; mcpx needs Node.js 20 or newer`);

  // Config file
  const path = configPath();
  let entries: ReturnType<typeof listEntries> = [];
  try {
    entries = listEntries(loadConfig(path));
    add("config", "ok", `${path} (${entries.length} servers)`);
  } catch (err) {
    add("config", "fail", (err as Error).message);
  }
  if (existsSync(path) && process.platform !== "win32") {
    const mode = statSync(path).mode;
    if (mode & 0o022) {
      add(
        "config permissions",
        "warn",
        `${path} is writable by other users, who could add commands that mcpx runs as you; run: chmod go-w "${path}"`,
      );
    }
  }

  // Each entry: valid, and every ${VAR} it references is set.
  const usable: { name: string; server: ServerConfig }[] = [];
  for (const e of entries) {
    if (opts.server && e.name !== opts.server) continue;
    if (e.error !== undefined) {
      add("server config", "fail", e.error, e.name);
      continue;
    }
    try {
      resolveServer(e.name, e.server);
      usable.push({ name: e.name, server: e.server });
    } catch (err) {
      add("server config", "fail", (err as Error).message, e.name);
    }
  }
  if (opts.server && !entries.some((e) => e.name === opts.server)) {
    add("server config", "fail", `no server named "${opts.server}" in ${path}`, opts.server);
  }

  // Keychain, only needed for HTTP servers.
  if (usable.some((u) => !isStdio(u.server))) {
    try {
      await credentialStore().get("__mcpx_doctor_probe__");
      add("keychain", "ok", "OS keychain is available");
    } catch (err) {
      add("keychain", "fail", `${(err as Error).message}; mcpx login can't store tokens`);
    }
  }

  // Audit log location is writable.
  const log = auditLogPath();
  const logTarget = existsSync(log) ? log : nearestExisting(dirname(log));
  try {
    accessSync(logTarget, constants.W_OK);
    add("audit log", "ok", log);
  } catch {
    add("audit log", "warn", `${log} is not writable; calls won't be audited`);
  }

  // Automatic updates.
  const blocker = autoUpdateBlocker();
  const state = readState();
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  if (blocker) {
    add("updates", "ok", `automatic updates off: ${blocker}`);
  } else if (state.lastError && state.lastError.at >= (state.lastCheck ?? 0) - 1000) {
    add("updates", "warn", `last automatic update failed (${day(state.lastError.at)}): ${state.lastError.message}; run: mcpx update`);
  } else {
    const latest = state.latest ? `, latest release ${state.latest.replace(/^v/, "")}` : "";
    const checked = state.lastCheck ? `last checked ${day(state.lastCheck)}` : "not checked yet";
    add("updates", "ok", `automatic, daily (${checked}${latest})`);
  }

  // Servers: connect, list tools, report auth state.
  if (!opts.offline) {
    const results = await Promise.all(usable.map((u) => checkServer(u.name, u.server, opts)));
    checks.push(...results);
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  return {
    json: { ok: failed === 0, failed, warnings: warned, checks },
    text: () => {
      const icon = { ok: "✓", warn: "!", fail: "✗" };
      const rows = checks.map((c) => [icon[c.status], c.server ? `${c.check} ${c.server}` : c.check, c.message]);
      const summary =
        failed === 0
          ? warned === 0
            ? "All checks passed."
            : `${warned} warning(s).`
          : `${failed} problem(s), ${warned} warning(s).`;
      return `${table(rows)}\n\n${summary}`;
    },
    exitCode: failed === 0 ? ExitCode.OK : ExitCode.TOOL_ERROR,
  };
}

async function checkServer(name: string, server: ServerConfig, opts: SessionOptions): Promise<Check> {
  const auth = await describeAuth(name, server);
  try {
    const tools = await withSession(name, server, opts, listAllTools);
    const allowed = tools.filter((t) => checkTool(server, t).allowed).length;
    const policy = allowed < tools.length ? ` (${tools.length - allowed} hidden by policy)` : "";
    // Read the auth state again: connecting may have refreshed the token.
    // A public server works without logging in, so "not logged in" isn't news there.
    const after = await describeAuth(name, server);
    const authNote = after && after !== "auth: not logged in" ? `; ${after}` : "";
    return { check: "server", server: name, status: "ok", message: `${allowed} tools${policy}${authNote}` };
  } catch (err) {
    const e = classifyError(name, err);
    const message = e.message.split("\n")[0];
    return { check: "server", server: name, status: "fail", message: auth ? `${message} [${auth}]` : message };
  }
}

/** A one-line summary of how mcpx authenticates to the server (never the secret). */
async function describeAuth(name: string, server: ServerConfig): Promise<string | undefined> {
  if (isStdio(server)) return undefined;
  if (hasAuthorizationHeader(server)) return "auth: static header";
  const creds = await credentialStore()
    .get(name)
    .catch(() => undefined);
  if (!creds?.tokens || creds.serverUrl !== server.url) return "auth: not logged in";
  const { expires_in, refresh_token } = creds.tokens;
  if (expires_in === undefined || creds.savedAt === undefined) return "auth: OAuth";
  const expiresAt = new Date(creds.savedAt + expires_in * 1000);
  const when = expiresAt.toISOString().replace(/\.\d+Z$/, "Z");
  if (expiresAt.getTime() > Date.now()) return `auth: OAuth, token valid until ${when}`;
  return refresh_token ? "auth: OAuth, token expired (refreshes automatically)" : "auth: OAuth, token expired";
}

function nearestExisting(dir: string): string {
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}
