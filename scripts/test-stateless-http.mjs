#!/usr/bin/env node
/**
 * POST /mcp must work for clients that open with `server/discover` and an
 * MCP-Protocol-Version the SDK doesn't know (Claude, from 2026-11-13): they
 * need a normal JSON-RPC reply, not an HTTP 400, so they fall back to
 * `initialize`. Also checks the server is stateless (no session ID needed).
 *
 * Runs dist/core/http-server.js without OAuth and with a stub MCP server.
 * Run: npm run build && node scripts/test-stateless-http.mjs
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHttpServer } from '../dist/core/http-server.js';

let fail = 0;
const ok = (name, cond) => {
  if (!cond) fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
};

console.log('stateless http test');
console.log('===================');

const logged = [];
const logger = {
  isLevelEnabled() {
    return false;
  },
  debug() {},
  warn() {},
  error() {},
  info(msg, meta) {
    logged.push({ msg, meta });
  },
};
const stub = {
  createMcpServer() {
    const s = new Server({ name: 'test', version: '0' }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'pb_note_list', inputSchema: { type: 'object', properties: {} } }],
    }));
    return s;
  },
};

// Find a free port, then start the server on it.
const net = await import('node:net');
const actualPort = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
process.env.MCP_HTTP_HOST = '127.0.0.1';
process.env.MCP_HTTP_PORT = String(actualPort);
const handle = await startHttpServer(stub, logger, 'test');

async function call(method, version, params = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (version) headers['mcp-protocol-version'] = version;
  const r = await fetch(`http://127.0.0.1:${actualPort}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: r.status, text: await r.text(), session: r.headers.get('mcp-session-id') };
}

const FUTURE = '2999-01-01'; // never a real version
let r = await call('server/discover', FUTURE, { _meta: {} });
ok(`unknown version: server/discover -> HTTP 200 (got ${r.status})`, r.status === 200);
ok('unknown version: reply is JSON-RPC method-not-found', r.text.includes('-32601'));
ok(
  'unknown version: dropped value is logged',
  logged.some((l) => l.meta?.mcp_protocol_version === FUTURE),
);

r = await call('initialize', undefined, {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 't', version: '0' },
});
ok(`initialize -> HTTP 200 (got ${r.status})`, r.status === 200 && r.text.includes('protocolVersion'));
ok('stateless: no Mcp-Session-Id issued', !r.session);

r = await call('tools/list', '2025-06-18');
ok(`tools/list without a session -> HTTP 200 (got ${r.status})`, r.status === 200 && r.text.includes('pb_note_list'));

const del = await fetch(`http://127.0.0.1:${actualPort}/mcp`, { method: 'DELETE' });
ok(`DELETE /mcp -> 405 (got ${del.status})`, del.status === 405);

await handle.close();
console.log(fail ? `\n${fail} failure(s)` : '\nall passed');
process.exit(fail ? 1 : 0);
