import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { configDir } from "./config.js";
import { VERSION } from "./version.js";
/**
 * Self-update for git-based global installs (`npm install -g github:...`).
 *
 * Once a day, any mcpx command spawns a detached background process
 * (`mcpx __auto-update`) and returns immediately: commands are never slowed
 * down or broken by update checks. The background process lists the release
 * tags with `git ls-remote` (using the user's git credentials, so private repos
 * work, with prompts disabled) and installs a newer release with npm.
 */
const run = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 15 * 60 * 1000;
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
/** The installed package's root directory (contains package.json). */
export function packageRoot() {
    return dirname(dirname(fileURLToPath(import.meta.url)));
}
/** Where releases come from: $MCPX_UPDATE_REPO, else package.json "repository". */
export function updateRepo() {
    if (process.env.MCPX_UPDATE_REPO)
        return process.env.MCPX_UPDATE_REPO;
    const pkg = createRequire(import.meta.url)("../package.json");
    return (pkg.repository?.url ?? "").replace(/^git\+/, "");
}
const statePath = () => join(configDir(), "update-state.json");
const lockPath = () => join(configDir(), "update.lock");
export function readState() {
    try {
        return JSON.parse(readFileSync(statePath(), "utf8"));
    }
    catch {
        return {};
    }
}
function writeState(patch) {
    try {
        mkdirSync(configDir(), { recursive: true });
        writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }, null, 2) + "\n");
    }
    catch {
        // Best effort: update bookkeeping must never break a command.
    }
}
export function compareVersions(a, b) {
    const pa = a.replace(/^v/, "").split(".").map(Number);
    const pb = b.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < 3; i++)
        if ((pa[i] ?? 0) !== (pb[i] ?? 0))
            return (pa[i] ?? 0) - (pb[i] ?? 0);
    return 0;
}
/** Highest vX.Y.Z tag in `git ls-remote --tags` output. */
export function latestTag(lsRemoteOutput) {
    const tags = lsRemoteOutput
        .split("\n")
        .map((line) => line.split("\t")[1]?.replace(/^refs\/tags\//, ""))
        .filter((t) => Boolean(t && TAG.test(t)));
    return tags.sort(compareVersions).pop();
}
/**
 * Why this installation must not update itself, or undefined if it may.
 * A git checkout (e.g. `npm link` for development) is never overwritten.
 */
export function autoUpdateBlocker() {
    if (process.env.MCPX_NO_AUTO_UPDATE)
        return "disabled by MCPX_NO_AUTO_UPDATE";
    if (process.env.CI)
        return "disabled in CI";
    if (existsSync(join(packageRoot(), ".git"))) {
        return "running from a git checkout; update it with git pull && npm run compile";
    }
    if (!updateRepo())
        return "no repository to update from";
    return undefined;
}
/** Called at startup: start a background check if one is due. Fast and silent. */
export function maybeScheduleAutoUpdate() {
    try {
        if (autoUpdateBlocker())
            return;
        const { lastCheck } = readState();
        if (lastCheck && Date.now() - lastCheck < DAY_MS)
            return;
        // Record the attempt first so a failing check doesn't respawn on every command.
        writeState({ lastCheck: Date.now() });
        const child = spawn(process.execPath, [join(packageRoot(), "dist", "cli.js"), "__auto-update"], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        child.on("error", () => { });
        child.unref();
    }
    catch {
        // Never let update scheduling affect the command the user ran.
    }
}
async function fetchLatest() {
    const { stdout } = await run("git", ["ls-remote", "--tags", "--refs", updateRepo()], {
        timeout: 15_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" },
    });
    return latestTag(stdout);
}
/** True if the package is installed in npm's global node_modules. */
async function isGlobalNpmInstall() {
    try {
        const { stdout } = await run(npmCommand(), ["root", "-g"], { timeout: 15_000, shell: process.platform === "win32" });
        const rel = relative(realpathSync(stdout.trim()), realpathSync(packageRoot()));
        return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    }
    catch {
        return false;
    }
}
const npmCommand = () => (process.platform === "win32" ? "npm.cmd" : "npm");
/** Check for a newer release and, unless checkOnly, install it. */
export async function update(opts = {}) {
    const latest = await fetchLatest();
    writeState({ lastCheck: Date.now(), latest, lastError: undefined });
    const updateAvailable = Boolean(latest && compareVersions(latest, VERSION) > 0);
    const result = { current: VERSION, latest: latest?.replace(/^v/, ""), updateAvailable, updated: false };
    if (!updateAvailable || opts.checkOnly)
        return result;
    const blocker = autoUpdateBlocker();
    if (blocker && !blocker.startsWith("disabled"))
        return { ...result, skipped: blocker };
    if (!(await isGlobalNpmInstall())) {
        return { ...result, skipped: "not a global npm install; reinstall with npm install -g" };
    }
    if (!TAG.test(latest))
        throw new Error(`refusing to install unexpected tag ${latest}`);
    await run(npmCommand(), ["install", "-g", "--install-links", `git+${updateRepo()}#${latest}`], {
        timeout: 5 * 60_000,
        shell: process.platform === "win32",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    writeState({ lastUpdate: { from: VERSION, to: result.latest, at: Date.now() }, lastError: undefined });
    return { ...result, updated: true };
}
/** Entry point of the detached `mcpx __auto-update` process. */
export async function backgroundUpdate() {
    if (autoUpdateBlocker())
        return;
    mkdirSync(configDir(), { recursive: true });
    // One updater at a time; a lock older than LOCK_STALE_MS is from a crashed run.
    try {
        if (existsSync(lockPath()) && Date.now() - statSync(lockPath()).mtimeMs > LOCK_STALE_MS)
            rmSync(lockPath());
        closeSync(openSync(lockPath(), "wx"));
    }
    catch {
        return;
    }
    try {
        await update();
    }
    catch (err) {
        writeState({ lastError: { message: String(err.message ?? err).split("\n")[0], at: Date.now() } });
    }
    finally {
        rmSync(lockPath(), { force: true });
    }
}
