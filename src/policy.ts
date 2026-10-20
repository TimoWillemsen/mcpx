import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.js";

/**
 * Per-server guardrails from servers.json:
 * - allowedTools: tool names (or `prefix*` patterns) that may be called.
 * - readOnly: only tools the server annotates with `readOnlyHint: true`.
 *   Tools without annotations are blocked, so this fails safe. It trusts the
 *   server's annotations; for a hard guarantee also use a read-only scope or
 *   endpoint if the server offers one.
 */

export type Decision = { allowed: true } | { allowed: false; reason: string };

export function hasPolicy(server: ServerConfig): boolean {
  return Boolean(server.readOnly || server.allowedTools);
}

export function matchesPattern(name: string, pattern: string): boolean {
  if (!pattern.includes("*")) return name === pattern;
  const re = new RegExp(
    "^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
  );
  return re.test(name);
}

/** Whether the name alone is allowed (no tool metadata needed). */
export function checkName(server: ServerConfig, toolName: string): Decision {
  if (server.allowedTools && !server.allowedTools.some((p) => matchesPattern(toolName, p))) {
    return { allowed: false, reason: `"${toolName}" is not in allowedTools` };
  }
  return { allowed: true };
}

/** Full check, using the tool's annotations for readOnly. */
export function checkTool(server: ServerConfig, tool: Tool): Decision {
  const byName = checkName(server, tool.name);
  if (!byName.allowed) return byName;
  if (server.readOnly && tool.annotations?.readOnlyHint !== true) {
    const why = tool.annotations ? "is not annotated readOnlyHint: true" : "has no annotations";
    return { allowed: false, reason: `server is readOnly and "${tool.name}" ${why}` };
  }
  return { allowed: true };
}
