import { auth, discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { openBrowser, startCallbackServer } from "../auth/callback.js";
import { DEFAULT_CALLBACK_PORT, McpxOAuthProvider, oauthOptions } from "../auth/provider.js";
import { credentialStore } from "../auth/store.js";
import {
  classifyError,
  hasAuthorizationHeader,
  listAllTools,
  withSession,
  type SessionOptions,
} from "../client.js";
import {
  getServer,
  isSecureUrl,
  isStdio,
  loadConfig,
  resolveServer,
  type HttpServerConfig,
} from "../config.js";
import { authError, usageError } from "../errors.js";
import type { CommandResult } from "../output.js";

export interface LoginOptions {
  /** Open the authorization URL in a browser (default true). */
  browser: boolean;
  /** How long to wait for the user to finish in the browser. */
  waitMs: number;
  session: SessionOptions;
}

function oauthServer(serverName: string): HttpServerConfig {
  const server = getServer(loadConfig(), serverName);
  if (isStdio(server)) {
    throw usageError(`"${serverName}" is a stdio server; login only applies to HTTP servers`);
  }
  return server;
}

/**
 * Interactive OAuth login: discovery, dynamic client registration and PKCE via the
 * SDK, with a browser + 127.0.0.1 callback. Tokens go to the OS keychain.
 * This is the only command that waits on the user.
 */
export async function loginCommand(serverName: string, opts: LoginOptions): Promise<CommandResult> {
  const server = oauthServer(serverName);
  if (hasAuthorizationHeader(server)) {
    throw usageError(
      `"${serverName}" has a static Authorization header in servers.json, which would override OAuth; remove it to use login`,
    );
  }

  const resolved = resolveServer(serverName, server) as HttpServerConfig;
  const oauth = oauthOptions(resolved);
  const scope = oauth.scope;
  const provider = new McpxOAuthProvider({
    serverName,
    serverUrl: server.url,
    ...oauth,
    ignoreStoredTokens: true,
    onAuthorizationUrl: (url) => {
      process.stderr.write(`Authorize mcpx for "${serverName}" in your browser:\n  ${url.href}\n`);
      if (opts.browser) openBrowser(url);
      process.stderr.write("Waiting for you to approve...\n");
    },
  });

  const callback = await startCallbackServer(
    oauth.callbackPort ?? DEFAULT_CALLBACK_PORT,
    provider.state(),
  );

  let timer: NodeJS.Timeout | undefined;
  try {
    const first = await auth(provider, { serverUrl: server.url, scope });
    if (first !== "AUTHORIZED") {
      const code = await Promise.race([
        callback.code,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(authError(`login not completed within ${Math.round(opts.waitMs / 1000)}s`)),
            opts.waitMs,
          );
        }),
      ]);
      await auth(provider, { serverUrl: server.url, scope, authorizationCode: code });
    }
  } catch (err) {
    throw classifyError(serverName, err);
  } finally {
    clearTimeout(timer);
    await callback.close();
  }

  // Prove the new token works before reporting success.
  const tools = await withSession(serverName, server, opts.session, listAllTools);
  const tokens = await provider.tokens();

  const result = {
    server: serverName,
    loggedIn: true,
    ...(tokens?.scope && { scope: tokens.scope }),
    ...(tokens?.expires_in !== undefined && {
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    }),
    refreshable: Boolean(tokens?.refresh_token),
    tools: tools.length,
  };
  return {
    json: result,
    text: () =>
      `Logged in to "${serverName}"${result.scope ? ` (scope: ${result.scope})` : ""}; ${tools.length} tools available.`,
  };
}

/** Remove stored credentials and, best effort, revoke the token with the server. */
export async function logoutCommand(serverName: string): Promise<CommandResult> {
  const server = oauthServer(serverName);
  const store = credentialStore();
  const creds = await store.get(serverName);
  const existed = await store.delete(serverName);

  let revoked = false;
  const token = creds?.tokens?.refresh_token ?? creds?.tokens?.access_token;
  // Only revoke at the server the token was issued for.
  if (token && creds?.serverUrl === server.url) {
    const hint = creds.tokens?.refresh_token ? "refresh_token" : "access_token";
    const issuer = (creds.tokens as { issuer?: unknown } | undefined)?.issuer;
    revoked = await revokeToken(server.url, token, hint, creds.clientInformation?.client_id, issuer);
  }

  const result = { server: serverName, loggedOut: existed, revoked };
  return {
    json: result,
    text: () =>
      existed
        ? `Logged out of "${serverName}"${revoked ? " and revoked the token" : ""}.`
        : `Not logged in to "${serverName}".`,
  };
}

async function revokeToken(
  serverUrl: string,
  token: string,
  hint: string,
  clientId: string | undefined,
  issuer: unknown,
): Promise<boolean> {
  // The token may only go back to the authorization server that issued it: the
  // resource server's metadata could now point somewhere else.
  if (typeof issuer !== "string") return false;
  try {
    const signal = AbortSignal.timeout(5000);
    const fetchFn = (url: string | URL, init?: RequestInit) => fetch(url, { ...init, signal });
    const info = await discoverOAuthServerInfo(serverUrl, { fetchFn });
    if (!sameUrl(String(info.authorizationServerUrl), issuer)) return false;
    // RFC 7009 field; the SDK's OIDC metadata type doesn't declare it.
    const metadata = info.authorizationServerMetadata as { revocation_endpoint?: string } | undefined;
    const endpoint = metadata?.revocation_endpoint;
    if (!endpoint || !isSecureUrl(endpoint)) return false;
    const body = new URLSearchParams({ token, token_type_hint: hint });
    if (clientId) body.set("client_id", clientId);
    // Never follow a redirect with the token in the body.
    const res = await fetch(endpoint, { method: "POST", body, signal, redirect: "error" });
    return res.ok;
  } catch {
    return false;
  }
}

/** URLs compared as parsed, ignoring a trailing slash (as the SDK compares issuers). */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      return new URL(u).href.replace(/\/$/, "");
    } catch {
      return u.replace(/\/$/, "");
    }
  };
  return norm(a) === norm(b);
}
