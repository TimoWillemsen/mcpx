import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { authError, configError } from "../errors.js";

/** Everything mcpx keeps for one OAuth-authenticated server. */
export interface StoredCredentials {
  /** The server URL these credentials were issued for. Never sent anywhere else. */
  serverUrl: string;
  /** Result of dynamic client registration. */
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** When `tokens` were saved, in ms since epoch (for expiry display). */
  savedAt?: number;
}

export interface CredentialStore {
  get(server: string): Promise<StoredCredentials | undefined>;
  set(server: string, creds: StoredCredentials): Promise<void>;
  delete(server: string): Promise<boolean>;
}

const SERVICE = "mcpx";

/** OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). */
class KeychainStore implements CredentialStore {
  private entry(server: string) {
    return new AsyncEntry(SERVICE, server);
  }

  async get(server: string): Promise<StoredCredentials | undefined> {
    let raw: string | null;
    try {
      raw = await this.entry(server).getPassword();
    } catch (err) {
      throw keychainError(err);
    }
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredCredentials;
    } catch {
      return undefined; // corrupt entry: treat as logged out
    }
  }

  async set(server: string, creds: StoredCredentials): Promise<void> {
    try {
      await this.entry(server).setPassword(JSON.stringify(creds));
    } catch (err) {
      throw keychainError(err);
    }
  }

  async delete(server: string): Promise<boolean> {
    try {
      return await this.entry(server).deleteCredential();
    } catch (err) {
      throw keychainError(err);
    }
  }
}

/**
 * TEST ONLY: plaintext JSON file, enabled by MCPX_TEST_CREDENTIAL_FILE so the
 * test suite never touches the real keychain. Warns on every use.
 */
class TestFileStore implements CredentialStore {
  constructor(private readonly path: string) {
    process.stderr.write(`mcpx: WARNING: using plaintext test credential store ${path}\n`);
  }

  private read(): Record<string, StoredCredentials> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return {};
    }
  }

  async get(server: string) {
    return this.read()[server];
  }

  async set(server: string, creds: StoredCredentials) {
    writeFileSync(this.path, JSON.stringify({ ...this.read(), [server]: creds }), { mode: 0o600 });
  }

  async delete(server: string) {
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
function assertInTempDir(file: string): string {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const path = resolve(real(dirname(resolve(file))), basename(file));
  const rel = relative(real(tmpdir()), path);
  // isAbsolute catches a different drive on Windows.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw configError(
      `MCPX_TEST_CREDENTIAL_FILE must be under the system temp directory (it stores tokens in plaintext); got ${file}`,
    );
  }
  return path;
}

function keychainError(err: unknown) {
  // Never include stored values; the keyring error only describes the failure.
  return authError(`OS keychain unavailable: ${(err as Error)?.message ?? String(err)}`);
}

let store: CredentialStore | undefined;

export function credentialStore(): CredentialStore {
  if (!store) {
    const testFile = process.env.MCPX_TEST_CREDENTIAL_FILE;
    store = testFile ? new TestFileStore(assertInTempDir(testFile)) : new KeychainStore();
  }
  return store;
}
