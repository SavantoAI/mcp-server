/**
 * Library entry point for programmatic use (e.g. embedding the Savanto
 * MCP server in a larger agent). Most users should install the package
 * and use the `savanto-mcp` bin instead — that's what Claude Desktop /
 * Cursor configs point at.
 */

export type { ApiKeyLoadError, ApiKeyLoadResult } from './auth.js';
export { describeApiKeyError, loadApiKey, loadApiKeyFromHeader, resolveBaseUrl } from './auth.js';
export type { FetchHandler, HttpHandlerOptions } from './http/handler.js';
export {
  createHttpHandler,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MCP_PATH,
  DEFAULT_SESSION_IDLE_MS,
} from './http/handler.js';
export { createServer } from './server.js';
export type { RequestOptions, SavantoClient } from './utils/fetch.js';
export { request, SavantoApiError } from './utils/fetch.js';
export type { Whoami } from './whoami.js';
export { fetchWhoami, hasScope } from './whoami.js';
