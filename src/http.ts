#!/usr/bin/env node
/**
 * Remote HTTP entry point for the hosted MCP server. Serves the same tool layer
 * as the stdio entry point over Streamable HTTP, so an MCP client can point at a
 * URL instead of spawning `npx`. Intended to run on a persistent container host
 * (a small container service, or any self-hoster).
 *
 * Auth is per-request via `Authorization: Bearer if_sk_…` — there is NO
 * server-wide key here (unlike stdio's `SAVANTO_API_KEY`). Each connecting
 * client supplies its own secret key, and the tool surface is scope-gated to
 * that key's tenant. A deployment may instead front this with an OAuth token.
 *
 * Human-facing logs go to stderr; stdout is left clean.
 */

import { serve } from '@hono/node-server';
import { resolveBaseUrl } from './auth.js';
import { createHttpHandler, DEFAULT_MCP_PATH } from './http/handler.js';

function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT ?? env.SAVANTO_MCP_PORT;
  const port = raw ? Number.parseInt(raw, 10) : 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`[savanto-mcp] Invalid port "${raw}"; falling back to 8080.\n`);
    return 8080;
  }
  return port;
}

/**
 * Fail loud: a *malformed* security/limit knob must halt startup, never silently
 * fall back to a default — a typo'd `SAVANTO_MCP_MAX_SESSIONS=abc` shouldn't be
 * ignored. But an empty/blank value is NOT malformed: it means "no restriction"
 * (same as unset), and is the normal case when a CloudFormation/env default is
 * `""` — so it must not be fatal, or the container crash-loops on first deploy.
 */
function fatal(message: string): never {
  process.stderr.write(`[savanto-mcp] FATAL: ${message}\n`);
  process.exit(1);
}

/** Comma-separated env var → trimmed non-empty list, or undefined when unset/blank. */
function csvEnv(name: string, env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Positive-integer env var. Unset/blank → undefined (default); present-but-not-a
 *  positive-integer → fatal. */
function positiveIntEnv(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    fatal(`${name} must be a positive integer (got "${raw}").`);
  }
  return n;
}

const baseUrl = resolveBaseUrl();
const port = resolvePort();
// Public-endpoint hardening, configured per deployment. Unset = no restriction
// (fine for local dev); the gateway sets ALLOWED_HOSTS=mcp.savanto.ai in prod.
const allowedHosts = csvEnv('SAVANTO_MCP_ALLOWED_HOSTS');
const allowedOrigins = csvEnv('SAVANTO_MCP_ALLOWED_ORIGINS');
const maxSessions = positiveIntEnv('SAVANTO_MCP_MAX_SESSIONS');
const sessionIdleMs = positiveIntEnv('SAVANTO_MCP_SESSION_IDLE_MS');
// OAuth discovery (Phase 2). Set AUTHORIZATION_SERVER to the AS issuer
// (https://savanto.ai) to advertise it; RESOURCE is the public canonical URL
// (https://mcp.savanto.ai/mcp) — required behind CloudFront, which hides the
// public host. Unset = Phase-1 key-as-Bearer only, no discovery.
const authorizationServer = process.env.SAVANTO_MCP_AUTHORIZATION_SERVER?.trim() || undefined;
const resourceIdentifier = process.env.SAVANTO_MCP_RESOURCE?.trim() || undefined;
// Behind CloudFront the request host is the internal origin, so the public
// resource URL can't be derived from the request — it MUST be configured. Fail
// loud rather than publish discovery metadata pointing at the internal origin.
if (authorizationServer && !resourceIdentifier) {
  fatal(
    'SAVANTO_MCP_AUTHORIZATION_SERVER is set but SAVANTO_MCP_RESOURCE is not. ' +
      'Set the public resource URL (e.g. https://mcp.savanto.ai/mcp) so discovery advertises the right audience.',
  );
}

const handler = createHttpHandler({
  baseUrl,
  allowedHosts,
  allowedOrigins,
  maxSessions,
  sessionIdleMs,
  authorizationServer,
  resourceIdentifier,
});

serve({ fetch: handler, port }, (info) => {
  process.stderr.write(
    `[savanto-mcp] Remote MCP server listening on http://0.0.0.0:${info.port}${DEFAULT_MCP_PATH}\n` +
      `[savanto-mcp] Proxying to Savanto API at ${baseUrl}. Clients authenticate per-request with a Bearer secret key.\n` +
      `[savanto-mcp] allowedHosts=${allowedHosts?.join(',') ?? '(any)'} allowedOrigins=${allowedOrigins?.join(',') ?? '(any)'}\n` +
      `[savanto-mcp] oauth=${authorizationServer ? `on (AS ${authorizationServer}, resource ${resourceIdentifier ?? '(request-derived)'})` : 'off (key-as-Bearer)'}\n`,
  );
});
