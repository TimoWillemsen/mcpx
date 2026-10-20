import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { HttpServerConfig } from "../config.js";
import { authError } from "../errors.js";
import { credentialStore, type CredentialStore, type StoredCredentials } from "./store.js";

export const DEFAULT_CALLBACK_PORT = 33418;

/** Provider options from a server's `oauth` config (which must have ${VAR}s resolved). */
export function oauthOptions(server: HttpServerConfig) {
  const o = server.oauth;
  return {
    scope: o?.scope,
    callbackPort: o?.callbackPort,
    clientId: o?.clientId,
    clientSecret: o?.clientSecret,
  };
}

export interface ProviderOptions {
  serverName: string;
  serverUrl: string;
  scope?: string;
  callbackPort?: number;
  /** Pre-registered client; skips dynamic client registration. */
  clientId?: string;
  clientSecret?: string;
  /**
   * Called with the authorization URL during `mcpx login`. When absent, the
   * provider is non-interactive: needing a new authorization is an auth error
   * (exit 2) instead of a browser prompt.
   */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  /**
   * Hide stored tokens until new ones are saved, forcing a fresh authorization.
   * The old tokens stay in the store, so a failed login doesn't log you out.
   */
  ignoreStoredTokens?: boolean;
  store?: CredentialStore;
}

/**
 * OAuth client provider for the SDK, persisting client registration and tokens
 * in the credential store. Discovery, dynamic client registration, PKCE and
 * refresh are all done by the SDK.
 */
export class McpxOAuthProvider implements OAuthClientProvider {
  readonly #opts: ProviderOptions;
  readonly #store: CredentialStore;
  readonly #state = randomBytes(16).toString("base64url");
  #verifier: string | undefined;
  #cache: StoredCredentials | undefined;
  #loaded = false;
  #hideTokens: boolean;

  constructor(opts: ProviderOptions) {
    this.#opts = opts;
    this.#store = opts.store ?? credentialStore();
    this.#hideTokens = opts.ignoreStoredTokens ?? false;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.#opts.callbackPort ?? DEFAULT_CALLBACK_PORT}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "mcpx",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.#opts.clientSecret ? "client_secret_post" : "none",
      ...(this.#opts.scope && { scope: this.#opts.scope }),
    };
  }

  state(): string {
    return this.#state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.#opts.clientId) {
      return {
        client_id: this.#opts.clientId,
        ...(this.#opts.clientSecret && { client_secret: this.#opts.clientSecret }),
      };
    }
    const info = (await this.#load())?.clientInformation;
    // Re-register if the stored client was registered for a different callback.
    const uris = (info as { redirect_uris?: string[] } | undefined)?.redirect_uris;
    if (uris && !uris.includes(this.redirectUrl)) return undefined;
    return info;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.#update({ clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.#hideTokens) return undefined;
    return (await this.#load())?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.#update({ tokens, savedAt: Date.now() });
    this.#hideTokens = false;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.#opts.onAuthorizationUrl) {
      throw authError(
        `"${this.#opts.serverName}" needs you to log in (run: mcpx login ${this.#opts.serverName})`,
      );
    }
    await this.#opts.onAuthorizationUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.#verifier) throw authError("no PKCE code verifier for this login attempt");
    return this.#verifier;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "verifier") {
      this.#verifier = undefined;
    } else if (scope === "all") {
      await this.#store.delete(this.#opts.serverName);
      this.#cache = undefined;
    } else if (scope === "client") {
      await this.#update({ clientInformation: undefined, tokens: undefined });
    } else if (scope === "tokens") {
      await this.#update({ tokens: undefined });
    }
  }

  async #load(): Promise<StoredCredentials | undefined> {
    if (!this.#loaded) {
      const stored = await this.#store.get(this.#opts.serverName);
      // Credentials are bound to the URL they were issued for: if servers.json now
      // points somewhere else, don't send them there.
      this.#cache = stored?.serverUrl === this.#opts.serverUrl ? stored : undefined;
      this.#loaded = true;
    }
    return this.#cache;
  }

  async #update(patch: Partial<StoredCredentials>): Promise<void> {
    const current = (await this.#load()) ?? { serverUrl: this.#opts.serverUrl };
    this.#cache = { ...current, ...patch, serverUrl: this.#opts.serverUrl };
    await this.#store.set(this.#opts.serverName, this.#cache);
  }
}

/** True if the store holds tokens for this server at this URL. */
export async function hasStoredTokens(
  serverName: string,
  serverUrl: string,
  store: CredentialStore = credentialStore(),
): Promise<boolean> {
  const creds = await store.get(serverName);
  return Boolean(creds?.tokens && creds.serverUrl === serverUrl);
}
