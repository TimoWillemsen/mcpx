import { ExitCode, McpxError, usageError } from "./errors.js";
/**
 * Pick the output format for a stream: --json or --text wins, then $MCPX_OUTPUT,
 * then text on a terminal and JSON when piped or captured (scripts, agents).
 */
export function outputFormat(opts, isTTY, env = process.env) {
    if (opts.json)
        return "json";
    if (opts.text)
        return "text";
    const v = env.MCPX_OUTPUT?.trim().toLowerCase();
    if (v === "json" || v === "text")
        return v;
    if (v)
        throw usageError(`MCPX_OUTPUT must be "json" or "text", got "${env.MCPX_OUTPUT}"`);
    return isTTY ? "text" : "json";
}
/**
 * Make server-provided text safe to print to a terminal: drop ANSI escape
 * sequences and other control characters (which a malicious server could use to
 * rewrite the screen or hide text), keeping newlines and tabs. JSON output needs
 * none of this, because JSON.stringify escapes control characters.
 */
export function sanitizeForTerminal(s) {
    return s
        .replace(/\r\n/g, "\n")
        .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g, "")
        .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
export function printResult(result, opts) {
    // Escape sequences only do harm on a terminal; piped output (to jq, a file or an
    // agent) is passed through unchanged so data isn't altered.
    const text = () => (process.stdout.isTTY ? sanitizeForTerminal(result.text()) : result.text());
    const asText = result.raw || outputFormat(opts, Boolean(process.stdout.isTTY)) === "text";
    const out = asText ? text() : JSON.stringify(result.json, null, 2);
    if (out)
        process.stdout.write(out.endsWith("\n") ? out : out + "\n");
}
/** Errors go to stderr so stdout stays parseable. Returns the exit code to use. */
export function printError(err, opts) {
    const e = err instanceof McpxError
        ? err
        : new McpxError(err?.message ?? String(err), ExitCode.TOOL_ERROR, "internal");
    let format;
    try {
        // Errors follow stderr: an error shown in a terminal is for a person to read.
        format = outputFormat(opts, Boolean(process.stderr.isTTY));
    }
    catch {
        format = "json"; // an invalid MCPX_OUTPUT is itself the error being reported
    }
    if (format === "text") {
        const msg = process.stderr.isTTY ? sanitizeForTerminal(e.message) : e.message;
        process.stderr.write(`mcpx: ${msg}\n`);
    }
    else {
        process.stderr.write(JSON.stringify({ error: { kind: e.kind, message: e.message, exitCode: e.exitCode } }) + "\n");
    }
    return e.exitCode;
}
/**
 * Render rows as columns: padded for a terminal, tab-separated when piped
 * (so `cut -f1` and friends keep working). The last column is never padded.
 */
export function table(rows, tty = Boolean(process.stdout.isTTY)) {
    if (!tty)
        return rows.map((r) => r.join("\t")).join("\n");
    const widths = [];
    for (const row of rows) {
        row.slice(0, -1).forEach((cell, i) => {
            widths[i] = Math.max(widths[i] ?? 0, cell.length);
        });
    }
    return rows
        .map((row) => row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]) : cell)).join("  "))
        .join("\n");
}
