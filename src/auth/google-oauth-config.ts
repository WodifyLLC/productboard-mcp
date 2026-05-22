/**
 * Google OAuth config used for *user identification only* — productboard-mcp
 * doesn't need any Google APIs at runtime. Sign-in proves the user is a
 * Wodify employee; after that, all Productboard calls use the single
 * server-side bearer token from Secrets Manager.
 *
 * Mirrors g-suite-mcp/src/config/google-oauth.ts (intentionally — keeping the
 * two services' OAuth wiring symmetric makes future ports easier) but with
 * the upstream Google scopes stripped out.
 */

// Identity-only scopes. We need email + profile to discover who just signed
// in; we do NOT request Sheets/Docs/Drive/etc. so the OAuth consent screen
// stays minimal.
export const SCOPES = ['openid', 'email', 'profile'];

// Domain restriction. Only Google accounts whose email ends with one of these
// suffixes can complete the OAuth flow. Configurable via ALLOWED_EMAIL_DOMAINS
// env var (comma-separated). Defaults to wodify.com only.
export function loadAllowedEmailDomains(): string[] {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS;
  if (raw && raw.trim()) {
    return raw
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }
  return ['wodify.com'];
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  // Server-flow redirect URI — Google sends users back here after sign-in.
  // Computed from MCP_PUBLIC_URL. Undefined when MCP_PUBLIC_URL is unset
  // (e.g. stdio mode), in which case the OAuth flow is disabled.
  browserRedirectUri?: string;
  scopes: string[];
}

export function loadGoogleOAuthConfig(): GoogleOAuthConfig | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
  const publicUrl = process.env.MCP_PUBLIC_URL;

  // OAuth is opt-in. Without GOOGLE_CLIENT_ID + MCP_PUBLIC_URL the server
  // skips the entire auth layer, matching the original stdio-only behavior.
  if (!clientId || !publicUrl) {
    return undefined;
  }

  return {
    clientId,
    clientSecret,
    browserRedirectUri: appendPath(publicUrl, '/google/callback'),
    scopes: SCOPES,
  };
}

/**
 * Append a sub-path to a base URL while preserving the base's path component.
 * `new URL('/foo', base)` would drop base's path (because '/foo' is absolute).
 * This helper appends instead. Essential when the server runs under a path
 * prefix like https://internal-mcp.wodify.com/productboard.
 */
export function appendPath(base: string, subPath: string): string {
  const u = new URL(base);
  const basePath = u.pathname.replace(/\/$/, '');
  const sub = subPath.startsWith('/') ? subPath : `/${subPath}`;
  return `${u.protocol}//${u.host}${basePath}${sub}`;
}
