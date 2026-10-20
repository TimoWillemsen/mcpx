export const ExitCode = {
    OK: 0,
    TOOL_ERROR: 1,
    AUTH: 2,
    USAGE: 3,
    /** Blocked by the server's allowedTools / readOnly policy in servers.json. */
    POLICY: 4,
};
/** An error that maps to a specific process exit code. */
export class McpxError extends Error {
    exitCode;
    kind;
    constructor(message, exitCode, kind) {
        super(message);
        this.exitCode = exitCode;
        this.kind = kind;
        this.name = "McpxError";
    }
}
export const usageError = (message) => new McpxError(message, ExitCode.USAGE, "usage");
export const configError = (message) => new McpxError(message, ExitCode.USAGE, "config");
export const toolError = (message) => new McpxError(message, ExitCode.TOOL_ERROR, "tool");
export const connectionError = (message) => new McpxError(message, ExitCode.TOOL_ERROR, "connection");
export const timeoutError = (message) => new McpxError(message, ExitCode.TOOL_ERROR, "timeout");
export const authError = (message) => new McpxError(message, ExitCode.AUTH, "auth");
export const policyError = (message) => new McpxError(message, ExitCode.POLICY, "policy");
