/**
 * HTTP transport for productboard-mcp.
 *
 * Routes:
 *   GET  /healthz           → 200 { ok, version, uptime, sessions }
 *   GET  /mcp               → 200 (ALB health-check; matches g-suite-mcp)
 *   POST /mcp               → MCP Streamable HTTP transport (bearer-protected
 *                              when OAuth is enabled)
 *   DELETE /mcp             → terminate a session by ID
 *
 * When OAuth is enabled (MCP_PUBLIC_URL + GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
 * set), the following are also mounted:
 *   /.well-known/oauth-authorization-server
 *   /.well-known/openid-configuration
 *   /.well-known/oauth-protected-resource
 *   /authorize, /token, /register, /revoke (via mcpAuthRouter)
 *   /google/callback
 *
 * And POST /mcp is gated by Bearer token issued by our McpOAuthProvider.
 * Unauthenticated requests get 401 with WWW-Authenticate pointing at the
 * resource-metadata URL, prompting the client to start an OAuth flow.
 *
 * When OAuth is NOT enabled, POST /mcp is open — matches the original
 * stdio-only design and is fine for local dev / `npm run dev`.
 */

import express, { type Request, type Response, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { Server as HTTPServer } from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { Server as MCPSDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { ProductboardMCPServer } from './server.js';
import { Logger } from '@utils/logger.js';
import { makeAccessLog } from './access-log.js';
import { McpOAuthProvider } from '@auth/mcp-oauth-provider.js';
import { appendPath } from '@auth/google-oauth-config.js';

// Inline helper: the SDK exports `isInitializeRequest` from types.js at runtime
// but moduleResolution: node fails to see it through the wildcard subpath
// export. Re-implement locally — the protocol method name is stable.
function isInitializeRequest(body: unknown): boolean {
  return (
    !!body &&
    typeof body === 'object' &&
    (body as { method?: unknown }).method === 'initialize'
  );
}

interface Session {
  transport: StreamableHTTPServerTransport;
  mcp: MCPSDKServer;
}

export interface HttpServerHandle {
  close: () => Promise<void>;
  port: number;
}

export interface StartHttpServerOptions {
  /** When provided, /mcp is gated by Bearer token from this provider. */
  oauth?: McpOAuthProvider;
  /** Public URL used in OAuth metadata. Required when oauth is set. */
  publicUrl?: string;
}

export async function startHttpServer(
  server: ProductboardMCPServer,
  logger: Logger,
  version: string,
  options: StartHttpServerOptions = {},
): Promise<HttpServerHandle> {
  const host = process.env.MCP_HTTP_HOST || '0.0.0.0';
  const port = Number.parseInt(process.env.MCP_HTTP_PORT || '8000', 10);
  const { oauth, publicUrl } = options;

  if (oauth && !publicUrl) {
    throw new Error('OAuth is enabled but MCP_PUBLIC_URL is not set.');
  }

  const app = express();
  // Trust the ALB so X-Forwarded-For is honored by req.ip in access logs
  // and by express-rate-limit inside the SDK's auth router.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '4mb' }));
  // Access log fires on every request after express.json has parsed the body
  // so debug-level body peek has something to capture.
  app.use(makeAccessLog(logger));

  const sessions = new Map<string, Session>();
  const startedAt = Date.now();

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      version,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      sessions: sessions.size,
      oauth: !!oauth,
    });
  });

  // -------------------- OAuth metadata + routes --------------------
  // Only mounted when an OAuth provider is provided. When unset, the server
  // runs in the original open-access mode (suitable for local dev / stdio).
  if (oauth && publicUrl) {
    const issuerUrl = new URL(publicUrl);
    const basePath = issuerUrl.pathname.replace(/\/$/, '');

    // Mirror g-suite-mcp: serve the AS metadata BEFORE mcpAuthRouter so our
    // path-prefix-aware version wins over the SDK's auto-built one (which
    // drops the path component).
    const asMetadataBody = {
      issuer: publicUrl,
      authorization_endpoint: appendPath(publicUrl, '/authorize'),
      token_endpoint: appendPath(publicUrl, '/token'),
      registration_endpoint: appendPath(publicUrl, '/register'),
      revocation_endpoint: appendPath(publicUrl, '/revoke'),
      response_types_supported: ['code'] as const,
      code_challenge_methods_supported: ['S256'] as const,
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'] as const,
      grant_types_supported: ['authorization_code', 'refresh_token'] as const,
      revocation_endpoint_auth_methods_supported: ['client_secret_post'] as const,
      scopes_supported: ['mcp'] as const,
      service_name: 'productboard-mcp',
    };
    app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
      res.json(asMetadataBody);
    });

    // Cowork's client does OpenID Connect Discovery (openid-configuration)
    // before RFC 8414 OAuth AS Discovery — 404 here makes it give up.
    const oidcMetadataBody = {
      ...asMetadataBody,
      subject_types_supported: ['public'] as const,
      id_token_signing_alg_values_supported: ['none'] as const,
    };
    app.get('/.well-known/openid-configuration', (_req: Request, res: Response) => {
      res.json(oidcMetadataBody);
    });

    const prmBody = {
      resource: publicUrl,
      authorization_servers: [publicUrl],
      scopes_supported: ['mcp'] as const,
      resource_name: 'productboard-mcp',
    };
    app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
      res.json(prmBody);
    });

    // Mount the SDK's OAuth router (/authorize, /token, /register, /revoke).
    app.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl,
        scopesSupported: ['mcp'],
        resourceName: 'productboard-mcp',
      }),
    );

    // Google callback. Google sends users back here with ?code & ?state after
    // sign-in. We exchange the code, fetch userinfo, validate the email
    // domain, and hand off to provider.finishGoogleLogin() which redirects
    // the user's browser back to the MCP client.
    app.get('/google/callback', async (req: Request, res: Response) => {
      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const error = typeof req.query.error === 'string' ? req.query.error : undefined;

      if (error) {
        logger.warn('google callback: user denied or error', { error, state });
        if (state) oauth.discardPendingGoogle(state);
        res.status(400).send(`Google sign-in failed: ${error}`);
        return;
      }
      if (!code || !state) {
        res.status(400).send('Missing code or state parameter from Google.');
        return;
      }

      const pending = oauth.peekPendingGoogle(state);
      if (!pending) {
        res.status(400).send('Unknown or expired authorization request.');
        return;
      }

      try {
        if (!oauth.config.browserRedirectUri) {
          throw new Error('OAuth config missing browserRedirectUri');
        }
        const oauth2 = new OAuth2Client({
          clientId: oauth.config.clientId,
          clientSecret: oauth.config.clientSecret,
          redirectUri: oauth.config.browserRedirectUri,
        });
        const { tokens } = await oauth2.getToken(code);
        oauth2.setCredentials(tokens);

        const userinfoRes = await oauth2.request<{
          email?: string;
          email_verified?: boolean;
        }>({ url: 'https://openidconnect.googleapis.com/v1/userinfo' });
        const userEmail = userinfoRes.data.email?.toLowerCase();

        if (!userEmail) {
          oauth.discardPendingGoogle(state);
          logger.warn('google callback: userinfo had no email', { state });
          res
            .status(400)
            .send('Could not determine your Google email. The OAuth scopes may be misconfigured.');
          return;
        }

        const domain = userEmail.split('@')[1];
        const allowed = oauth.allowedEmailDomains;
        if (!domain || !allowed.includes(domain)) {
          oauth.discardPendingGoogle(state);
          logger.info('google callback: rejected — email domain not allowed', {
            user_email: userEmail,
            domain,
            allowed,
          });
          res
            .status(403)
            .send(
              `Access denied. This server only accepts users from: ${allowed
                .map((d) => `@${d}`)
                .join(', ')}. You signed in as ${userEmail}.`,
            );
          return;
        }

        await oauth.finishGoogleLogin(state, userEmail, res);
      } catch (err) {
        const e = err as Error;
        logger.error('google callback: token exchange or userinfo fetch failed', {
          err: e.message,
          stack: e.stack,
          state,
        });
        oauth.discardPendingGoogle(state);
        if (!res.headersSent) {
          res.status(500).send('Something went wrong completing Google sign-in. Please try again.');
        }
      }
    });

    logger.info('oauth: enabled', {
      issuer: publicUrl,
      basePath: basePath || '(none)',
      allowed_domains: oauth.allowedEmailDomains,
    });
  } else {
    logger.warn(
      'oauth: DISABLED — POST /mcp is open. Set MCP_PUBLIC_URL + GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to enable bearer-token gating.',
    );
  }

  // Bearer-auth middleware on POST /mcp. No-op when OAuth is disabled.
  const mcpAuthMiddleware: RequestHandler =
    oauth && publicUrl
      ? requireBearerAuth({
          verifier: oauth,
          resourceMetadataUrl: appendPath(publicUrl, '/.well-known/oauth-protected-resource'),
        })
      : (_req, _res, next) => next();

  app.post('/mcp', mcpAuthMiddleware, async (req: Request & { auth?: { extra?: { user_email?: string } } }, res: Response) => {
    try {
      const userEmail =
        typeof req.auth?.extra?.user_email === 'string' ? req.auth.extra.user_email : undefined;
      const sessionId = req.header('mcp-session-id') || req.header('Mcp-Session-Id');
      let session: Session | undefined = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        // No existing session — only accept a new one on an initialize request.
        if (sessionId) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
          });
          return;
        }
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Missing Mcp-Session-Id; first call must be initialize',
            },
            id: null,
          });
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            const s = { transport, mcp };
            sessions.set(id, s);
            logger.debug(`MCP session opened: ${id} (active: ${sessions.size})`, { userEmail });
          },
        });

        const mcp = server.createMcpServer();
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            logger.debug(`MCP session closed: ${transport.sessionId} (active: ${sessions.size})`);
          }
          mcp.close().catch((err) => logger.warn('Error closing MCP server', err));
        };

        await mcp.connect(transport);
        session = { transport, mcp };
      }

      await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error('POST /mcp failed', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET /mcp = ALB health check path. Return 200 so the target stays healthy.
  app.get('/mcp', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, transport: 'streamable-http', method: 'POST' });
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id') || req.header('Mcp-Session-Id');
    if (!sessionId) {
      res.status(400).json({ error: 'Missing Mcp-Session-Id header' });
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    try {
      await session.transport.close();
      res.status(204).end();
    } catch (err) {
      logger.error(`Error closing session ${sessionId}`, err);
      res.status(500).json({ error: 'Failed to close session' });
    }
  });

  const httpServer: HTTPServer = await new Promise<HTTPServer>((resolve, reject) => {
    const s = app.listen(port, host, () => {
      logger.info(`HTTP server listening on ${host}:${port}`);
      resolve(s);
    });
    s.on('error', reject);
  });

  return {
    port,
    close: async () => {
      logger.info('Closing HTTP server...');
      await Promise.all(
        Array.from(sessions.values()).map((s) =>
          s.transport.close().catch((err) => logger.warn('Error closing session', err)),
        ),
      );
      sessions.clear();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
