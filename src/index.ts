/**
 * Library entry point for programmatic use (e.g. embedding the Savanto
 * MCP server in a larger agent). Most users should install the package
 * and use the `savanto-mcp` bin instead — that's what Claude Desktop /
 * Cursor configs point at.
 */

export type { ApiKeyLoadError, ApiKeyLoadResult } from './auth.js';
export { describeApiKeyError, loadApiKey, resolveBaseUrl } from './auth.js';
export { createServer } from './server.js';
export type { RequestOptions, SavantoClient } from './utils/fetch.js';
export { request, SavantoApiError } from './utils/fetch.js';
export type { Whoami } from './whoami.js';
export { fetchWhoami, hasScope } from './whoami.js';
