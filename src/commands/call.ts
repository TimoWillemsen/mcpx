import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { coercePairs, parseCallArgs } from "../args.js";
import { audit, type AuditOutcome } from "../audit.js";
import { listAllTools, withSession, type SessionOptions } from "../client.js";
import { getServer, loadConfig } from "../config.js";
import { ExitCode, McpxError, policyError, toolError, usageError } from "../errors.js";
import { checkName, checkTool } from "../policy.js";
import type { CommandResult } from "../output.js";

export interface CallOptions extends SessionOptions {
  /** Print the payload (structuredContent, or the text, parsed as JSON when it is JSON). */
  unwrap?: boolean;
}

export async function callCommand(
  serverName: string,
  toolName: string,
  argTokens: string[],
  opts: CallOptions,
): Promise<CommandResult> {
  const started = Date.now();
  const record = (outcome: AuditOutcome, exitCode: number) =>
    audit({ server: serverName, tool: toolName, outcome, exitCode, durationMs: Date.now() - started });

  try {
    const result = await runCall(serverName, toolName, argTokens, opts);
    const exitCode = result.isError ? ExitCode.TOOL_ERROR : ExitCode.OK;
    record(result.isError ? "tool_error" : "ok", exitCode);
    if (opts.unwrap) {
      const payload = unwrap(result);
      return {
        json: payload,
        // A string payload is printed as-is (it's the tool's own output), JSON pretty-printed.
        text: () => (typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)),
        raw: typeof payload === "string",
        exitCode,
      };
    }
    return { json: result, text: () => formatContent(result), exitCode };
  } catch (err) {
    const e = err instanceof McpxError ? err : undefined;
    const outcome: AuditOutcome =
      e?.kind === "policy" ? "blocked" : e?.kind === "auth" ? "auth" : e?.kind === "tool" ? "tool_error" : "error";
    record(outcome, e?.exitCode ?? ExitCode.TOOL_ERROR);
    throw err;
  }
}

async function runCall(
  serverName: string,
  toolName: string,
  argTokens: string[],
  opts: SessionOptions,
): Promise<CallToolResult> {
  // Syntax errors in the arguments are reported before connecting.
  const parsed = parseCallArgs(argTokens);
  const server = getServer(loadConfig(), serverName);

  // allowedTools is checked before connecting: a blocked call never reaches the server.
  const byName = checkName(server, toolName);
  if (!byName.allowed) throw policyError(`${serverName}/${toolName} blocked: ${byName.reason}`);

  return withSession(serverName, server, opts, async (s) => {
    // The tool definition is only fetched when needed: for readOnly, and to
    // convert key=value arguments with the tool's schema.
    let tool: Tool | undefined;
    if (server.readOnly || parsed.kind === "pairs") {
      tool = (await listAllTools(s)).find((t) => t.name === toolName);
      if (!tool) {
        throw usageError(`server "${serverName}" has no tool "${toolName}" (run: mcpx tools ${serverName})`);
      }
    }
    if (server.readOnly) {
      const decision = checkTool(server, tool!);
      if (!decision.allowed) throw policyError(`${serverName}/${toolName} blocked: ${decision.reason}`);
    }
    const args = parsed.kind === "json" ? parsed.value : coercePairs(parsed.pairs, tool!);

    try {
      return (await s.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        s.requestOptions,
      )) as CallToolResult;
    } catch (err) {
      // Protocol-level errors (unknown tool, invalid params, ...) are tool errors;
      // transport and auth failures are classified by withSession.
      if (err instanceof McpError) {
        throw toolError(`${serverName}/${toolName}: ${err.message}`);
      }
      throw err;
    }
  });
}

/**
 * The part of a CallToolResult a caller actually wants: structuredContent if the
 * tool returned it; otherwise the text, parsed as JSON when it is JSON (many
 * servers return JSON inside a text item). Non-text content is returned as-is.
 */
export function unwrap(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content ?? [];
  if (content.length === 0) return "";
  if (content.every((c) => c.type === "text")) {
    const text = content.map((c) => (c as { text: string }).text).join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return content;
}

function formatContent(result: CallToolResult): string {
  const parts = (result.content ?? []).map((c) => {
    switch (c.type) {
      case "text":
        return c.text;
      case "image":
      case "audio":
        return `[${c.type}: ${c.mimeType}, ${c.data.length} base64 chars]`;
      case "resource_link":
        return `[resource: ${c.uri}]`;
      case "resource":
        return "text" in c.resource
          ? c.resource.text
          : `[resource: ${c.resource.uri}]`;
      default:
        return JSON.stringify(c);
    }
  });
  if (parts.length === 0 && result.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return parts.join("\n");
}
