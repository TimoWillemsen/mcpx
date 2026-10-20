export const ExitCode = {
  OK: 0,
  TOOL_ERROR: 1,
  AUTH: 2,
  USAGE: 3,
  /** Blocked by the server's allowedTools / readOnly policy in servers.json. */
  POLICY: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** An error that maps to a specific process exit code. */
export class McpxError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCodeValue,
    readonly kind: string,
  ) {
    super(message);
    this.name = "McpxError";
  }
}

export const usageError = (message: string) =>
  new McpxError(message, ExitCode.USAGE, "usage");

export const configError = (message: string) =>
  new McpxError(message, ExitCode.USAGE, "config");

export const toolError = (message: string) =>
  new McpxError(message, ExitCode.TOOL_ERROR, "tool");

export const connectionError = (message: string) =>
  new McpxError(message, ExitCode.TOOL_ERROR, "connection");

export const timeoutError = (message: string) =>
  new McpxError(message, ExitCode.TOOL_ERROR, "timeout");

export const authError = (message: string) =>
  new McpxError(message, ExitCode.AUTH, "auth");

export const policyError = (message: string) =>
  new McpxError(message, ExitCode.POLICY, "policy");
