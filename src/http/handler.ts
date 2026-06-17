/**
 * Remote (Streamable HTTP) transport for the Savanto MCP server — Phase 1.
 *
 * This is the same `createServer(...)` tool layer the stdio entry point uses,
 * served over HTTP so an MCP client can connect to a hosted URL instead of
 * spawning a local `npx` process. Built on the SDK's *web-standard*
 * (`Request` → `Response`) transport so the handler runs unchanged on a plain
 * Node server (via `@hono/node-server`, see `../http.ts`), on the cloud's Hono
 * app, or on an edge runtime — and so it can be unit-tested by passing in
 * `Request` objects with no socket in the loop.
 *
 * Auth: the customer's existing **secret key** is the Bearer token
 * (`Authorization: Bearer if_sk_…`). Each new MCP session authenticates once
 * on `initialize` — we probe whoami via `createServer`, which both validates
 * the key and scope-gates the tool surface to that tenant. A deployment may
 * instead front this with an OAuth-issued, tenant-scoped token; the transport
 * and session machinery here are unchanged by that swap — only the token source
 * differs, exactly as stdio→HTTP only changed the transport.
 *
 * Sessions are stateful (per the MCP Streamable HTTP spec): `initialize`
 * mints a session id returned in `mcp-session-id`, and subsequent requests
 * route to the same in-memory server/transport by that id.
 */

import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { describeApiKeyError, loadApiKeyFromHeader } from '../auth.js';
import { type CreatedServer, createServer } from '../server.js';
import { SavantoApiError } from '../utils/fetch.js';

/** Default path the MCP endpoint is mounted at. */
export const DEFAULT_MCP_PATH = '/mcp';

/** Default ceiling on concurrent sessions (each is a full McpServer). */
export const DEFAULT_MAX_SESSIONS = 256;

/** Default idle window after which a session is evicted (30 minutes). */
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;

export interface HttpHandlerOptions {
  /** Savanto API base URL the per-session servers talk to. */
  baseUrl: string;
  /** Path the MCP endpoint listens on. Defaults to {@link DEFAULT_MCP_PATH}. */
  mcpPath?: string;
  /**
   * Server factory — injectable so tests can supply a pre-resolved whoami and
   * skip the network probe. Defaults to the real {@link createServer}, and is
   * typed to match it (accepts the full {@link CreateServerOptions}).
   */
  createServerFn?: typeof createServer;
  /**
   * Max concurrent sessions before new `initialize`s are refused with 503.
   * A DoS guard — each session pins a full McpServer. Defaults to
   * {@link DEFAULT_MAX_SESSIONS}.
   */
  maxSessions?: number;
  /**
   * Evict sessions with no traffic for longer than this (ms). Eviction is lazy
   * (swept on incoming requests), so an idle session is reclaimed on the next
   * request rather than by a timer. Defaults to {@link DEFAULT_SESSION_IDLE_MS}.
   */
  sessionIdleMs?: number;
  /**
   * If non-empty, the request `Host` header must be in this allowlist (else
   * 403) — DNS-rebinding protection for a public endpoint. Unset = no check.
   */
  allowedHosts?: string[];
  /**
   * If non-empty, a present `Origin` header must be in this allowlist (else
   * 403). Header-less clients (CLIs like Claude Desktop) send no Origin and are
   * allowed; this guards browser-originating cross-site requests. Unset = no check.
   */
  allowedOrigins?: string[];
  /** Clock injection for tests (idle eviction). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * OAuth authorization server issuer URL (e.g. `https://savanto.ai`). When set,
   * the gateway acts as an OAuth 2.1 **resource server** per the MCP auth spec:
   * it serves `/.well-known/oauth-protected-resource` (RFC 9728) advertising this
   * AS, and its 401s carry a `resource_metadata` pointer so clients can discover
   * where to authenticate. Unset = Phase-1 key-as-Bearer only (no OAuth discovery).
   */
  authorizationServer?: string;
  /**
   * Canonical resource identifier advertised in the protected-resource metadata
   * (the audience tokens are bound to). Defaults to the request's `origin + mcpPath`
   * (e.g. `https://mcp.savanto.ai/mcp`).
   */
  resourceIdentifier?: string;
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  /** Epoch ms of the last request routed to this session — drives idle eviction. */
  lastActivityAt: number;
}

/** A web-standard request handler: `(Request) => Promise<Response>`. */
export type FetchHandler = (request: Request) => Promise<Response>;

/**
 * Build the remote MCP request handler. Holds an in-memory session map for the
 * lifetime of the process; each session is one authenticated MCP connection.
 */
export function createHttpHandler(opts: HttpHandlerOptions): FetchHandler {
  const mcpPath = opts.mcpPath ?? DEFAULT_MCP_PATH;
  const makeServer = opts.createServerFn ?? createServer;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const allowedHosts = opts.allowedHosts;
  const allowedOrigins = opts.allowedOrigins;
  const authorizationServer = opts.authorizationServer;
  const resourceIdentifier = opts.resourceIdentifier;
  const now = opts.now ?? Date.now;

  /** RFC 9728 path advertising which AS protects this resource. */
  const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

  /** `WWW-Authenticate` value — adds the RFC 9728 resource_metadata pointer when OAuth is on. */
  function wwwAuthenticate(origin: string): string {
    const base = 'Bearer realm="savanto-mcp"';
    if (!authorizationServer) return base;
    return `${base}, resource_metadata="${origin}${PROTECTED_RESOURCE_PATH}"`;
  }
  // Process-local session store. A session lives until the client sends DELETE,
  // the transport closes, it goes idle past `sessionIdleMs` (lazy eviction), or
  // the `maxSessions` cap refuses new ones. State is in-memory, so the service
  // must run single-instance (or with sticky routing) — `mcp-session-id` would
  // otherwise land on the wrong instance. Pin to one task/instance; move to a
  // shared session store before scaling out.
  const sessions = new Map<string, Session>();

  async function closeSession(sessionId: string): Promise<void> {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    try {
      await entry.server.close();
    } catch {
      // Best-effort cleanup — a failed close must not wedge the handler.
    }
  }

  /** Evict sessions idle longer than the window. Lazy: called per request. */
  function sweepIdle(at: number): void {
    if (sessions.size === 0) return;
    // Deleting from a Map during its own for..of is safe in JS — removed keys
    // simply aren't visited; closeSession() deletes synchronously before its await.
    for (const [sid, entry] of sessions) {
      if (at - entry.lastActivityAt > sessionIdleMs) void closeSession(sid);
    }
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Liveness probe for the host (load balancer health check). Cheap, unauthed,
    // and deliberately not on the MCP path so it never collides with a session.
    if (url.pathname === '/healthz' || url.pathname === '/health') {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }

    // Public-facing URLs must come from config: behind CloudFront
    // (AllViewerExceptHostHeader) the request host is the internal origin, not
    // mcp.savanto.ai. Fall back to the request origin only for local/dev.
    const publicOrigin = resourceIdentifier ? new URL(resourceIdentifier).origin : url.origin;
    const resource = resourceIdentifier ?? `${url.origin}${mcpPath}`;

    // RFC 9728 protected-resource metadata — tells MCP clients which AS to use.
    if (authorizationServer && url.pathname === PROTECTED_RESOURCE_PATH) {
      return new Response(JSON.stringify({ resource, authorization_servers: [authorizationServer] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname !== mcpPath) {
      return jsonRpcError(404, -32601, `Not found. The MCP endpoint is ${mcpPath}.`);
    }

    // DNS-rebinding protection for a public endpoint (the SDK's built-in flags
    // are deprecated in favour of external checks like this one).
    const blocked = originHostError(request, allowedHosts, allowedOrigins);
    if (blocked) return blocked;

    const at = now();
    sweepIdle(at);

    // Existing session: route straight to its transport (GET stream, POST
    // message, DELETE teardown). Auth was established at initialize time.
    const sessionId = request.headers.get('mcp-session-id') ?? undefined;
    if (sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) {
        return jsonRpcError(404, -32001, 'Unknown or expired session. Re-initialize.');
      }
      entry.lastActivityAt = at;
      return entry.transport.handleRequest(request);
    }

    // No session id. The only valid request here is a POST carrying an
    // `initialize`; GET/DELETE need a session, anything else is unsupported.
    if (request.method === 'GET' || request.method === 'DELETE') {
      return jsonRpcError(400, -32000, 'Missing mcp-session-id header.');
    }
    if (request.method !== 'POST') {
      return jsonRpcError(405, -32601, 'Method not allowed.');
    }

    // Authenticate before doing any work. Phase 1: Bearer = secret key.
    const keyResult = loadApiKeyFromHeader(request.headers.get('authorization'));
    if (!keyResult.ok) {
      return unauthorized(describeApiKeyError(keyResult.error, 'bearer'), wwwAuthenticate(publicOrigin));
    }

    // Read the body once so we can (a) confirm it's an initialize and (b) hand
    // it to the transport pre-parsed (the request stream is single-use).
    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch {
      return jsonRpcError(400, -32700, 'Parse error: request body is not valid JSON.');
    }

    if (!isInitializeRequest(parsedBody)) {
      return jsonRpcError(
        400,
        -32000,
        'Server not initialized. Send an initialize request first, or include mcp-session-id.',
      );
    }

    // Cap concurrent sessions (the idle sweep above already reclaimed stale
    // ones). Refuse a *new* session rather than risk unbounded McpServer growth,
    // before spending an upstream whoami on it. Soft cap: concurrent initializes
    // can momentarily overshoot (the check precedes registration), which is fine
    // for a DoS guard — it bounds growth, it isn't a hard quota.
    if (sessions.size >= maxSessions) {
      return jsonRpcError(503, -32000, 'Server at session capacity. Try again shortly.');
    }

    // Build a per-tenant server. createServer runs the whoami probe, which both
    // authenticates the key and scope-gates the registered tools to this tenant.
    let created: CreatedServer;
    try {
      created = await makeServer({ client: { apiKey: keyResult.apiKey, baseUrl: opts.baseUrl } });
    } catch (err) {
      if (err instanceof SavantoApiError && (err.status === 401 || err.status === 403)) {
        // The token is well-formed but rejected by the API (revoked/expired).
        return unauthorized('The API key was rejected by the Savanto API.', wwwAuthenticate(publicOrigin));
      }
      // Upstream unreachable or unexpected — surface as a bad gateway, not a 401.
      const message = err instanceof Error ? err.message : 'Upstream error';
      return jsonRpcError(502, -32001, `Could not reach the Savanto API: ${message}`);
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Our tools are synchronous REST proxies with no server-initiated
      // streaming, so plain JSON responses are simpler and fully spec-compliant.
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, server: created.server, lastActivityAt: now() });
      },
      onsessionclosed: (sid) => {
        void closeSession(sid);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) void closeSession(transport.sessionId);
    };

    try {
      await created.server.connect(transport);
      const response = await transport.handleRequest(request, { parsedBody });
      // If the handshake didn't actually register a session, the server is an
      // orphan — close it. This covers the case where a body passes our (loose)
      // isInitializeRequest gate but fails the transport's strict JSON-RPC schema:
      // the transport RETURNS a 4xx (doesn't throw), so the catch below never
      // runs, and an unregistered server is also not counted toward maxSessions.
      if (!transport.sessionId || !sessions.has(transport.sessionId)) {
        await created.server.close().catch(() => {});
      }
      return response;
    } catch (err) {
      // Initialize threw after the server was built. Close it so a failed
      // handshake can't slowly leak McpServer instances on a long-lived host.
      // If the session already registered, closeSession also drops it from the
      // map; otherwise close the orphan server directly.
      if (transport.sessionId && sessions.has(transport.sessionId)) {
        await closeSession(transport.sessionId);
      } else {
        await created.server.close().catch(() => {});
      }
      const message = err instanceof Error ? err.message : 'unknown error';
      return jsonRpcError(500, -32603, `Failed to initialize MCP session: ${message}`);
    }
  };
}

/**
 * DNS-rebinding guard. Returns a 403 response when the request fails the
 * configured Host/Origin allowlists, or `undefined` when it passes (or no
 * allowlist is configured). Origin is only enforced when present, so header-less
 * CLI clients aren't blocked; Host is enforced whenever an allowlist is set.
 */
function originHostError(
  request: Request,
  allowedHosts: string[] | undefined,
  allowedOrigins: string[] | undefined,
): Response | undefined {
  if (allowedHosts && allowedHosts.length > 0) {
    // Compare host without its port and case-insensitively — hostnames are
    // case-insensitive (RFC 3986/7230) and clients/ALBs may send `host:443`
    // while the allowlist is a bare hostname (or vice versa).
    const host = request.headers.get('host');
    const normalized = host ? stripPort(host).toLowerCase() : undefined;
    const allowed = allowedHosts.map((h) => stripPort(h).toLowerCase());
    if (!normalized || !allowed.includes(normalized)) {
      return jsonRpcError(403, -32000, 'Host not allowed.');
    }
  }
  if (allowedOrigins && allowedOrigins.length > 0) {
    const origin = request.headers.get('origin')?.toLowerCase();
    const allowed = allowedOrigins.map((o) => o.toLowerCase());
    if (origin && !allowed.includes(origin)) {
      return jsonRpcError(403, -32000, 'Origin not allowed.');
    }
  }
  return undefined;
}

/** Strip a trailing `:port`. IPv6 literals are bracketed (`[::1]:443`), so a
 *  trailing `:digits` is unambiguously the port. */
function stripPort(host: string): string {
  return host.replace(/:\d+$/, '');
}

/** JSON-RPC-shaped error response (id null — these are pre-dispatch failures). */
function jsonRpcError(httpStatus: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status: httpStatus,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 401 with a caller-supplied `WWW-Authenticate` (which carries the RFC 9728
 * `resource_metadata` pointer when OAuth discovery is enabled). Takes a ready
 * message (from `describeApiKeyError(…, 'bearer')` for credential-shape failures,
 * or a custom string when the API rejected a well-formed key) so the body never
 * leaks which it was beyond the wording.
 */
function unauthorized(message: string, wwwAuthenticate: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': wwwAuthenticate,
    },
  });
}
