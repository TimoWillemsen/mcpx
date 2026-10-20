import { getDefaultEnvironment, StdioClientTransport, } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isStdio, } from "./config.js";
const STDERR_TAIL_BYTES = 4096;
/** `server` must already have ${VAR} references resolved. */
export function createTransport(server, opts = {}) {
    return isStdio(server)
        ? createStdioTransport(server, opts)
        : createHttpTransport(server, opts.authProvider);
}
function createStdioTransport(server, opts) {
    const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...getDefaultEnvironment(), ...server.env },
        cwd: server.cwd,
        // Keep stdout clean: server logs go to our stderr only with --verbose.
        stderr: opts.verbose ? "inherit" : "pipe",
    });
    let tail = "";
    transport.stderr?.on("data", (chunk) => {
        tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    return {
        transport,
        stderrTail: () => tail.trim(),
        terminate: async () => { },
    };
}
function createHttpTransport(server, authProvider) {
    if (server.type === "sse") {
        return {
            transport: new SSEClientTransport(new URL(server.url), {
                // Applied to both the stream GET and the message POSTs.
                requestInit: { headers: server.headers ?? {} },
                authProvider,
                redirectPolicy: "same-origin",
            }),
            stderrTail: () => "",
            terminate: async () => { },
        };
    }
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers ?? {} },
        authProvider,
        // Never follow a redirect to another origin with our Authorization header.
        redirectPolicy: "same-origin",
    });
    return {
        transport,
        stderrTail: () => "",
        terminate: async () => {
            if (transport.sessionId)
                await transport.terminateSession();
        },
    };
}
