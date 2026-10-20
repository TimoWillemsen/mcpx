import { isStdio, listEntries, loadConfig, type ParsedEntry } from "../config.js";
import { table, type CommandResult } from "../output.js";

/**
 * Lists configured servers without connecting. Env and header values are never
 * shown, only their keys. Invalid entries are listed with their error.
 */
export function serversCommand(): CommandResult {
  const servers = listEntries(loadConfig()).map(describeEntry);

  return {
    json: { servers },
    text: () =>
      servers.length === 0
        ? "no servers configured"
        : table(
            servers.map((s) => {
              if (s.error !== undefined) return [s.name, "invalid", s.error];
              return s.transport === "stdio"
                ? [s.name, "stdio", [s.command, ...s.args].join(" ")]
                : [s.name, "http", s.url];
            }),
          ),
  };
}

function describeEntry(entry: ParsedEntry) {
  const { name } = entry;
  if (entry.error !== undefined) return { name, error: entry.error };
  const server = entry.server;
  const common = {
    name,
    ...(server.readOnly !== undefined && { readOnly: server.readOnly }),
    ...(server.allowedTools && { allowedTools: server.allowedTools }),
  };
  return isStdio(server)
    ? {
        ...common,
        transport: "stdio" as const,
        command: server.command,
        args: server.args ?? [],
        envKeys: Object.keys(server.env ?? {}),
      }
    : {
        ...common,
        transport: "http" as const,
        url: server.url,
        headerKeys: Object.keys(server.headers ?? {}),
      };
}
