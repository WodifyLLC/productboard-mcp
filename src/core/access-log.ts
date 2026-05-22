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
 * At debug level, additionally captures the JSON-RPC method name from POST
 * /mcp bodies (but not the full params, which can be large or contain
 * customer data from Productboard).
 *
 * Built to mirror the g-suite-mcp access-log so the two services produce
 * comparable CloudWatch output when debugging connection issues.
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
