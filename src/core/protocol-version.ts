import type { IncomingMessage } from "node:http";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

const HEADER = "mcp-protocol-version";

/**
 * Drop an MCP-Protocol-Version header that the installed SDK doesn't know.
 *
 * The SDK's Streamable HTTP transport answers any request carrying an
 * unknown version with HTTP 400 "Unsupported protocol version". Newer
 * clients (Claude, from 2026-11-13) send a newer version on their first
 * `server/discover` probe and give up on that 400 instead of falling back
 * to `initialize`, so the connector shows "Couldn't reach".
 *
 * Without the header the SDK uses its own default version: `server/discover`
 * then gets a normal JSON-RPC "method not found", and the client continues
 * with `initialize`, where the version is properly negotiated.
 *
 * Nothing here names a version: the list comes from the SDK, so once a
 * Dependabot bump teaches the SDK the client's version, the header passes
 * through untouched and this does nothing.
 *
 * Returns the dropped value (for logging), or undefined if nothing changed.
 */
export function dropUnsupportedProtocolVersion(req: IncomingMessage): string | undefined {
  const value = req.headers[HEADER];
  if (typeof value !== "string" || SUPPORTED_PROTOCOL_VERSIONS.includes(value)) {
    return undefined;
  }
  delete req.headers[HEADER];
  // Some request adapters rebuild headers from rawHeaders, so remove it there too.
  const raw = req.rawHeaders;
  for (let i = raw.length - 2; i >= 0; i -= 2) {
    if (raw[i].toLowerCase() === HEADER) raw.splice(i, 2);
  }
  return value;
}
