import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";
import { authError, configError } from "../errors.js";
const SERVICE = "mcpx";
/** OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). */
class KeychainStore {
    entry(server) {
        return new AsyncEntry(SERVICE, server);
    }
    async get(server) {
        let raw;
        try {
            raw = await this.entry(server).getPassword();
        }
        catch (err) {
            throw keychainError(err);
        }
        if (!raw)
            return undefined;
        try {
            return JSON.parse(raw);
        }
        catch {
            return undefined; // corrupt entry: treat as logged out
        }
    }
    async set(server, creds) {
        try {
            await this.entry(server).setPassword(JSON.stringify(creds));
        }
        catch (err) {
            throw keychainError(err);
        }
    }
    async delete(server) {
        try {
            return await this.entry(server).deleteCredential();
        }
        catch (err) {
            throw keychainError(err);
        }
    }
}
/**
 * TEST ONLY: plaintext JSON file, enabled by MCPX_TEST_CREDENTIAL_FILE so the
 * test suite never touches the real keychain. Warns on every use.
 */
class TestFileStore {
    path;
    constructor(path) {
        this.path = path;
        process.stderr.write(`mcpx: WARNING: using plaintext test credential store ${path}\n`);
    }
    read() {
        try {
            return JSON.parse(readFileSync(this.path, "utf8"));
        }
        catch {
            return {};
        }
    }
    async get(server) {
        return this.read()[server];
    }
    async set(server, creds) {
        writeFileSync(this.path, JSON.stringify({ ...this.read(), [server]: creds }), { mode: 0o600 });
    }
    async delete(server) {
        const all = this.read();
        const existed = server in all;
        delete all[server];
        writeFileSync(this.path, JSON.stringify(all), { mode: 0o600 });
        return existed;
    }
}
/**
 * The plaintext test store is only allowed under the OS temp directory, so an
 * environment variable (from a repo's .envrc, or a confused agent) can't make
 * `mcpx login` write real tokens in plaintext into a project or home directory.
 */
function assertInTempDir(file) {
    const real = (p) => {
        try {
            return realpathSync(p);
        }
        catch {
            return resolve(p);
        }
    };
    const path = resolve(real(dirname(resolve(file))), basename(file));
    const rel = relative(real(tmpdir()), path);
    // isAbsolute catches a different drive on Windows.
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw configError(`MCPX_TEST_CREDENTIAL_FILE must be under the system temp directory (it stores tokens in plaintext); got ${file}`);
    }
    return path;
}
function keychainError(err) {
    // Never include stored values; the keyring error only describes the failure.
    return authError(`OS keychain unavailable: ${err?.message ?? String(err)}`);
}
let store;
export function credentialStore() {
    if (!store) {
        const testFile = process.env.MCPX_TEST_CREDENTIAL_FILE;
        store = testFile ? new TestFileStore(assertInTempDir(testFile)) : new KeychainStore();
    }
    return store;
}
