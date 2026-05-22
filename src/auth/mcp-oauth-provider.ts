/**
 * MCP OAuth provider for productboard-mcp.
 *
 * Mirrors g-suite-mcp's LocalOAuthProvider but simplified — we only need
 * Google as an identity provider, not for upstream Google API calls. The
 * single Productboard bearer token in Secrets Manager is used for all
 * Productboard API calls regardless of which user is connected.
 *
 * Auth flow:
 *   1. MCP client (Cowork / claude.ai / Cursor) calls POST /authorize.
 *   2. We redirect the user's browser to Google sign-in.
 *   3. Google → /google/callback. The callback handler in http-server.ts
 *      exchanges Google's code for tokens, fetches userinfo, validates the
 *      email domain (e.g. wodify.com), and calls finishGoogleLogin().
 *   4. finishGoogleLogin() issues an MCP authorization code and redirects
 *      the browser back to the MCP client.
 *   5. MCP client POSTs /token with the code → we return a Bearer token.
 *   6. MCP client uses that Bearer for every POST /mcp request.
 *
 * Bearer tokens are bound to a user_email — surfaced via AuthInfo.extra so
 * access logs can attribute requests to a specific Wodify user.
 *
 * Persistence: JSON file at TOKEN_STORE_PATH/oauth-state.json. On Fargate
 * this is ephemeral container disk, so all OAuth state is wiped on task
 * restart (matches g-suite-mcp's current behavior — clients re-auth on first
 * connect after a deploy).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidTokenError,
  InvalidGrantError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { Logger } from '@utils/logger.js';
import { GoogleOAuthConfig, loadAllowedEmailDomains } from './google-oauth-config.js';

function defaultPersistPath(): string {
  if (process.env.OAUTH_STATE_PATH) {
    return process.env.OAUTH_STATE_PATH;
  }
  if (process.env.TOKEN_STORE_PATH) {
    return path.join(process.env.TOKEN_STORE_PATH, 'oauth-state.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'productboard-mcp', 'oauth-state.json');
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'productboard-mcp', 'oauth-state.json');
}

interface PersistedState {
  clients: [string, OAuthClientInformationFull][];
  accessTokens: [string, IssuedAccessToken][];
  refreshTokens: [string, RefreshTokenInfo][];
}

/**
 * Persistent store of OAuth clients. Supports dynamic client registration —
 * any MCP client (Cowork, claude.ai, Cursor) can self-register.
 */
export class PersistentClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private onChange?: () => void;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  hydrate(entries: [string, OAuthClientInformationFull][]): void {
    for (const [k, v] of entries) this.clients.set(k, v);
  }

  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  serialize(): [string, OAuthClientInformationFull][] {
    return Array.from(this.clients.entries());
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(
    info: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>
  ): Promise<OAuthClientInformationFull> {
    const client_id = randomUUID();
    const full: OAuthClientInformationFull = {
      ...info,
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(client_id, full);
    this.logger.info('oauth client registered', { client_id, client_name: full.client_name });
    this.onChange?.();
    return full;
  }
}

interface PendingGoogleAuth {
  client_id: string;
  code_challenge: string;
  mcp_redirect_uri: string;
  mcp_state?: string;
  scopes?: string[];
  resource?: string;
  expires_at: number;
}

interface PendingCode {
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  scopes?: string[];
  resource?: string;
  user_email: string;
  expires_at: number;
}

interface IssuedAccessToken {
  client_id: string;
  user_email: string;
  scopes: string[];
  expires_at: number;
}

interface RefreshTokenInfo {
  client_id: string;
  user_email: string;
}

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PENDING_GOOGLE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class McpOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PersistentClientsStore;
  private readonly pendingGoogle = new Map<string, PendingGoogleAuth>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly accessTokens = new Map<string, IssuedAccessToken>();
  private readonly refreshTokens = new Map<string, RefreshTokenInfo>();
  private readonly persistPath: string;
  private readonly googleConfig: GoogleOAuthConfig;
  private readonly allowedDomains: string[];
  private readonly logger: Logger;
  private writePending = false;

  constructor(
    googleConfig: GoogleOAuthConfig,
    logger: Logger,
    persistPath: string = defaultPersistPath()
  ) {
    this.googleConfig = googleConfig;
    this.logger = logger;
    this.persistPath = persistPath;
    this.allowedDomains = loadAllowedEmailDomains();
    this.clientsStore = new PersistentClientsStore(logger);
    this.clientsStore.setOnChange(() => this.scheduleWrite());
  }

  get config(): GoogleOAuthConfig {
    return this.googleConfig;
  }

  get allowedEmailDomains(): string[] {
    return [...this.allowedDomains];
  }

  async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as PersistedState;
      this.clientsStore.hydrate(data.clients ?? []);
      const now = Date.now();
      for (const [k, v] of data.accessTokens ?? []) {
        if (v.expires_at > now && v.user_email) this.accessTokens.set(k, v);
      }
      for (const [k, v] of data.refreshTokens ?? []) {
        if (v && typeof v === 'object' && v.user_email) {
          this.refreshTokens.set(k, v);
        }
      }
      this.logger.info('oauth: hydrated state from disk', {
        clients: this.clientsStore.serialize().length,
        accessTokens: this.accessTokens.size,
        refreshTokens: this.refreshTokens.size,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        this.logger.warn('oauth: failed to load state, starting fresh', { err: e.message });
      }
    }
  }

  private scheduleWrite(): void {
    if (this.writePending) return;
    this.writePending = true;
    setImmediate(() => {
      this.writePending = false;
      this.writeToDisk().catch((err) =>
        this.logger.error('oauth: failed to persist state', { err: err.message })
      );
    });
  }

  private async writeToDisk(): Promise<void> {
    const dir = path.dirname(this.persistPath);
    await fs.mkdir(dir, { recursive: true });
    const data: PersistedState = {
      clients: this.clientsStore.serialize(),
      accessTokens: Array.from(this.accessTokens.entries()),
      refreshTokens: Array.from(this.refreshTokens.entries()),
    };
    await fs.writeFile(this.persistPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    if (!this.googleConfig.browserRedirectUri) {
      res
        .status(500)
        .send(
          'Server misconfigured: MCP_PUBLIC_URL is not set, so the per-user ' +
            'Google OAuth flow cannot run.'
        );
      return;
    }

    const googleState = randomBytes(32).toString('base64url');
    this.pendingGoogle.set(googleState, {
      client_id: client.client_id,
      code_challenge: params.codeChallenge,
      mcp_redirect_uri: params.redirectUri,
      mcp_state: params.state,
      scopes: params.scopes,
      resource: params.resource?.toString(),
      expires_at: Date.now() + PENDING_GOOGLE_TTL_MS,
    });
    this.gcPendingGoogle();

    const oauth2 = new OAuth2Client({
      clientId: this.googleConfig.clientId,
      clientSecret: this.googleConfig.clientSecret,
      redirectUri: this.googleConfig.browserRedirectUri,
    });
    const googleAuthUrl = oauth2.generateAuthUrl({
      access_type: 'online',
      // We don't need a Google refresh token (no upstream Google API use),
      // so 'online' is fine and avoids triggering an unnecessary consent
      // screen for users who've already consented to identity-only access.
      scope: this.googleConfig.scopes,
      state: googleState,
    });

    this.logger.info('oauth: redirecting user to Google for sign-in', {
      client_id: client.client_id,
      allowed_domains: this.allowedDomains,
    });
    res.redirect(googleAuthUrl);
  }

  async finishGoogleLogin(
    googleState: string,
    userEmail: string,
    res: Response
  ): Promise<void> {
    const pending = this.pendingGoogle.get(googleState);
    if (!pending) {
      res.status(400).send('Unknown or expired authorization request.');
      return;
    }
    this.pendingGoogle.delete(googleState);
    if (pending.expires_at < Date.now()) {
      res.status(400).send('Authorization request expired. Please try connecting again.');
      return;
    }

    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      client_id: pending.client_id,
      code_challenge: pending.code_challenge,
      redirect_uri: pending.mcp_redirect_uri,
      scopes: pending.scopes,
      resource: pending.resource,
      user_email: userEmail,
      expires_at: Date.now() + CODE_TTL_MS,
    });

    const url = new URL(pending.mcp_redirect_uri);
    url.searchParams.set('code', code);
    if (pending.mcp_state) url.searchParams.set('state', pending.mcp_state);
    this.logger.info('oauth: completed Google login, redirecting back to MCP client', {
      client_id: pending.client_id,
      user_email: userEmail,
    });
    res.redirect(url.toString());
  }

  peekPendingGoogle(googleState: string): PendingGoogleAuth | undefined {
    return this.pendingGoogle.get(googleState);
  }

  discardPendingGoogle(googleState: string): void {
    this.pendingGoogle.delete(googleState);
  }

  private gcPendingGoogle(): void {
    const now = Date.now();
    for (const [k, v] of this.pendingGoogle) {
      if (v.expires_at < now) this.pendingGoogle.delete(k);
    }
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const pending = this.codes.get(authorizationCode);
    if (!pending) throw new InvalidGrantError('Invalid authorization code');
    if (pending.client_id !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    if (pending.expires_at < Date.now()) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError('Authorization code expired');
    }
    return pending.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const pending = this.codes.get(authorizationCode);
    if (!pending) throw new InvalidGrantError('Invalid authorization code');
    if (pending.client_id !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, pending.user_email, pending.scopes ?? []);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[]
  ): Promise<OAuthTokens> {
    const owner = this.refreshTokens.get(refreshToken);
    if (!owner) {
      throw new InvalidGrantError('Refresh token not recognized');
    }
    if (owner.client_id !== client.client_id) {
      throw new InvalidGrantError('Refresh token was issued to a different client');
    }
    this.refreshTokens.delete(refreshToken);
    const tokens = this.issueTokens(client.client_id, owner.user_email, scopes ?? []);
    this.scheduleWrite();
    return tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = this.accessTokens.get(token);
    if (!info) throw new InvalidTokenError('Access token not recognized');
    if (info.expires_at < Date.now()) {
      this.accessTokens.delete(token);
      this.scheduleWrite();
      throw new InvalidTokenError('Access token expired');
    }
    return {
      token,
      clientId: info.client_id,
      scopes: info.scopes,
      expiresAt: Math.floor(info.expires_at / 1000),
      extra: { user_email: info.user_email },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    if (request.token_type_hint === 'refresh_token') {
      this.refreshTokens.delete(request.token);
    } else {
      this.accessTokens.delete(request.token);
      this.refreshTokens.delete(request.token);
    }
    this.scheduleWrite();
  }

  private issueTokens(
    clientId: string,
    userEmail: string,
    scopes: string[]
  ): OAuthTokens {
    const access_token = randomBytes(32).toString('base64url');
    const refresh_token = randomBytes(32).toString('base64url');
    this.accessTokens.set(access_token, {
      client_id: clientId,
      user_email: userEmail,
      scopes,
      expires_at: Date.now() + ACCESS_TTL_MS,
    });
    this.refreshTokens.set(refresh_token, { client_id: clientId, user_email: userEmail });
    this.scheduleWrite();
    return {
      access_token,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token,
      scope: scopes.join(' ') || undefined,
    };
  }
}
