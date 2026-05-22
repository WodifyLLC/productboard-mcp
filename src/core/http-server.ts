/**
 * HTTP transport for productboard-mcp.
 *
 * Wraps the stdio-only MCP server with a standard HTTP front (matching the
 * shape of the g-suite-mcp container so the same ECS / ALB pattern applies):
 *
 *   GET  /healthz  → 200 { ok: true, version, uptime }
 *   POST /mcp      → MCP Streamable HTTP transport (stateful sessions)
 *   GET  /mcp      → 405 (server-initiated SSE not exposed)
 *   DEL  /mcp      → terminate a session by ID
 *
 * Stateful session model: the first POST (with no session header and an
 * `initialize` body) spins up a fresh SDK Server + StreamableHTTPServerTransport
 * and registers the session. Subsequent requests must include
 * `Mcp-Session-Id: <id>` to reuse it. Sessions are cleaned up when the
 * transport closes.
 */

import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Server as HTTPServer } from 'node:http';
import { Server as MCPSDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { ProductboardMCPServer } from './server.js';
import { Logger } from '@utils/logger.js';
import { makeAccessLog } from './access-log.js';

// Inline helper: the SDK exports `isInitializeRequest` from types.js at runtime
// but moduleResolution: node fails to see it through the wildcard subpath
// export. Re-implement locally — the protocol method name is stable.
function isInitializeRequest(body: unknown): boolean {
  return !!body
    && typeof body === 'object'
    && (body as { method?: unknown }).method === 'initialize';
}

interface Session {
  transport: StreamableHTTPServerTransport;
  mcp: MCPSDKServer;
}

export interface HttpServerHandle {
  close: () => Promise<void>;
  port: number;
}

export async function startHttpServer(
  server: ProductboardMCPServer,
  logger: Logger,
  version: string,
): Promise<HttpServerHandle> {
  const host = process.env.MCP_HTTP_HOST || '0.0.0.0';
  const port = Number.parseInt(process.env.MCP_HTTP_PORT || '8000', 10);

  const app = express();
  // Trust the ALB so X-Forwarded-For is honored by req.ip in access logs.
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
    });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
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
            error: { code: -32000, message: 'Missing Mcp-Session-Id; first call must be initialize' },
            id: null,
          });
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            const s = { transport, mcp };
            sessions.set(id, s);
            logger.debug(`MCP session opened: ${id} (active: ${sessions.size})`);
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

  // GET /mcp doubles as an ALB health-check endpoint for Wodify's managed MCP
  // platform, which probes the same path the protocol uses. Return 200 so the
  // target stays healthy. (Matches g-suite-mcp's behavior.)
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
