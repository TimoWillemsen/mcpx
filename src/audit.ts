import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config.js";

export type AuditOutcome = "ok" | "tool_error" | "blocked" | "auth" | "error";

export interface AuditEntry {
  server: string;
  tool: string;
  outcome: AuditOutcome;
  exitCode: number;
  durationMs: number;
}

/** $MCPX_AUDIT_LOG, else audit.log next to servers.json. */
export function auditLogPath(): string {
  return process.env.MCPX_AUDIT_LOG || join(configDir(), "audit.log");
}

/**
 * Append one JSON line per `call`. Deliberately records no arguments and no
 * results, which can contain personal data or secrets. A failure to write the
 * log never fails the call; it is reported on stderr.
 */
export function audit(entry: AuditEntry): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  const path = auditLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, { mode: 0o600 });
  } catch (err) {
    process.stderr.write(`mcpx: could not write audit log ${path}: ${(err as Error).message}\n`);
  }
}
