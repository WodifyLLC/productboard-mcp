import { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { Logger } from '@utils/logger.js';

/**
 * Express middleware that logs every HTTP request after it completes.
 *
 * Always-on at info level — produces one log line per request with:
 *   - method + path + query
 *   - response status + duration_ms
 *   - client IP (honors X-Forwarded-For via `trust proxy`)
 *   - first 12 chars of sha256(Bearer token) when present — gives a stable
 *     per-session correlation ID without logging the actual token
 *   - response content-length when set
 *
 * Usage / adoption fields (always logged, not debug-gated) for POST /mcp:
 *   - user_email  — the authenticated user (from the verified Bearer token's
 *     auth.extra.user_email). Absent on unauthenticated requests (401s,
 *     health checks, well-known) — that's correct, those are anonymous.
 *   - mcp_method  — the JSON-RPC method (initialize / tools/list / tools/call …),
 *     so reporting can separate "connected" from "actually ran a tool".
 *   - tool_name   — for tools/call, the tool invoked (from params.name).
 *
 * These three power the CloudWatch usage dashboard
 * (infra/cloudwatch-usage-dashboard.json) via Logs Insights — count_distinct
 * (user_email), calls by user/tool, etc. NOTE: user_email is PII; the
 * /ecs/PRODUCTBOARD-MCP log group should have a deliberate retention set.
 *
 * At debug level, additionally captures the JSON-RPC envelope from POST
 * /mcp bodies (but not the full params, which can be large or contain
 * customer data from Productboard).
 *
 * Built to mirror the g-suite-mcp access-log so the two services produce
 * comparable CloudWatch output for both debugging and adoption reporting.
 */

const REDACT_KEYS = new Set([
  'authorization',
  'bearer',
  'token',
  'api_token',
  'productboard_api_token',
  'access_token',
  'refresh_token',
  'client_secret',
]);

function tokenFingerprint(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!m) return undefined;
  return createHash('sha256').update(m[1]).digest('hex').slice(0, 12);
}

/**
 * Extract the JSON-RPC method and (for tools/call) the tool name from a parsed
 * MCP request body. Handles a single message or a batch array. Returns
 * undefined fields when not determinable — never throws.
 */
function mcpRequestInfo(body: unknown): { mcp_method?: string; tool_name?: string } {
  if (!body || typeof body !== 'object') return {};
  // Batch (array of JSON-RPC messages): report the set of methods, no single tool.
  if (Array.isArray(body)) {
    const methods = body
      .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>).method : undefined))
      .filter((m): m is string => typeof m === 'string');
    return methods.length ? { mcp_method: `batch[${methods.join(',')}]` } : {};
  }
  const b = body as Record<string, unknown>;
  const mcp_method = typeof b.method === 'string' ? b.method : undefined;
  let tool_name: string | undefined;
  if (mcp_method === 'tools/call' && b.params && typeof b.params === 'object') {
    const name = (b.params as Record<string, unknown>).name;
    if (typeof name === 'string') tool_name = name;
  }
  return { mcp_method, tool_name };
}

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = typeof v === 'string' && v.length > 8 ? `<redacted len=${v.length}>` : '<redacted>';
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

export function makeAccessLog(logger: Logger) {
  return function accessLog(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const tokenFp = tokenFingerprint(req.header('authorization'));

    // Snapshot what we want to log before the handler mutates anything.
    const method = req.method;
    const path = req.path;
    const query = Object.keys(req.query).length > 0 ? req.query : undefined;
    const ip = req.ip ?? req.socket.remoteAddress ?? undefined;
    const userAgent = req.header('user-agent');
    const sessionHeader = req.header('mcp-session-id') || req.header('Mcp-Session-Id');

    // Capture body at debug level. For /mcp, peek at the JSON-RPC envelope
    // (method + id + keys of params), but NOT the params themselves — those
    // can contain Productboard customer data.
    let bodyForLog: unknown = undefined;
    if (logger.isLevelEnabled('debug') && path === '/mcp' && req.body && typeof req.body === 'object') {
      const b = req.body as Record<string, unknown>;
      bodyForLog = {
        jsonrpc: b.jsonrpc,
        method: b.method,
        id: b.id,
        params_keys:
          b.params && typeof b.params === 'object'
            ? Object.keys(b.params as Record<string, unknown>)
            : undefined,
      };
    } else if (logger.isLevelEnabled('debug') && req.body && typeof req.body === 'object') {
      // Generic body capture with redaction for non-/mcp paths (e.g. /.well-known/*).
      bodyForLog = redact(req.body);
    }

    res.on('finish', () => {
      const duration_ms = Date.now() - start;
      const fields: Record<string, unknown> = {
        method,
        path,
        status: res.statusCode,
        duration_ms,
      };
      if (ip) fields.ip = ip;
      if (query) fields.query = query;
      if (tokenFp) fields.token_fp = tokenFp;
      if (sessionHeader) fields.mcp_session_id = sessionHeader;
      if (userAgent) fields.user_agent = userAgent;
      const contentLength = res.getHeader('content-length');
      if (contentLength !== undefined) fields.bytes_out = contentLength;

      // Usage/adoption enrichment for MCP traffic. Read at finish-time so the
      // verified identity (set by requireBearerAuth during the handler) is
      // available. Always emitted (not debug-gated) so they reach CloudWatch
      // for the usage dashboard.
      if (path === '/mcp') {
        // user_email is populated by the OAuth provider's verifyAccessToken,
        // surfaced on the request as auth.extra.user_email by requireBearerAuth.
        const userEmail = (req as Request & { auth?: { extra?: { user_email?: unknown } } }).auth
          ?.extra?.user_email;
        if (typeof userEmail === 'string' && userEmail) {
          fields.user_email = userEmail;
        }
        const { mcp_method, tool_name } = mcpRequestInfo(req.body);
        if (mcp_method) fields.mcp_method = mcp_method;
        if (tool_name) fields.tool_name = tool_name;
      }

      // Surface WWW-Authenticate on 401s so we can see what we told the
      // client to do next (useful if we later add bearer-auth challenges).
      if (res.statusCode === 401) {
        const wwwAuth = res.getHeader('www-authenticate');
        if (wwwAuth) fields.www_authenticate = wwwAuth;
      }

      if (bodyForLog !== undefined) {
        logger.debug('http request', { ...fields, body: bodyForLog });
      } else {
        logger.info('http request', fields);
      }
    });

    next();
  };
}
