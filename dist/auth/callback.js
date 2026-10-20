import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { authError, usageError } from "../errors.js";
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto">` +
    `<h2>${title}</h2><p>${body}</p></body>`;
/**
 * Listen on 127.0.0.1:<port>/callback for the OAuth redirect. Only the first
 * callback counts; one with the wrong `state` aborts the login.
 */
export async function startCallbackServer(port, expectedState) {
    let settle;
    const code = new Promise((resolve, reject) => {
        let done = false;
        settle = (r) => {
            if (done)
                return;
            done = true;
            if (r.code)
                resolve(r.code);
            else
                reject(r.error);
        };
    });
    code.catch(() => { }); // handled by the caller; avoid unhandled-rejection noise
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (url.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
        }
        const params = url.searchParams;
        const send = (status, title, body) => res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page(title, body));
        // A callback without our state didn't come from our login: abort rather than trust it.
        if (params.get("state") !== expectedState) {
            send(400, "Login failed", "State mismatch. Start again with <code>mcpx login</code>.");
            settle({ error: authError("login callback had an unexpected state parameter (possible CSRF); aborted") });
            return;
        }
        const error = params.get("error");
        if (error) {
            const desc = params.get("error_description");
            send(400, "Login failed", "The authorization server returned an error. Check the terminal.");
            settle({ error: authError(`authorization denied: ${error}${desc ? ` (${desc})` : ""}`) });
            return;
        }
        const authCode = params.get("code");
        if (!authCode) {
            send(400, "Login failed", "No authorization code in the callback.");
            settle({ error: authError("login callback had no authorization code") });
            return;
        }
        send(200, "Logged in", "mcpx is authorized. You can close this tab.");
        settle({ code: authCode });
    });
    await new Promise((resolve, reject) => {
        server.once("error", (err) => reject(err.code === "EADDRINUSE"
            ? usageError(`callback port ${port} is in use; free it or set "oauth": {"callbackPort": N} in servers.json`)
            : err));
        server.listen(port, "127.0.0.1", resolve);
    });
    return {
        code,
        close: () => new Promise((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        }),
    };
}
/** Open a URL in the default browser. Only http(s) URLs; failures are ignored (the URL is also printed). */
export function openBrowser(url) {
    if (url.protocol !== "https:" && url.protocol !== "http:")
        return;
    const [cmd, args] = process.platform === "darwin"
        ? ["open", [url.href]]
        : process.platform === "win32"
            ? ["rundll32", ["url.dll,FileProtocolHandler", url.href]]
            : ["xdg-open", [url.href]];
    try {
        const child = spawn(cmd, args, { stdio: "ignore", detached: true });
        child.on("error", () => { });
        child.unref();
    }
    catch {
        // The URL was printed; the user can open it manually.
    }
}
