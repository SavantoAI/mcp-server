/**
 * Thin wrapper around `fetch` that:
 *   1. Attaches the `Authorization: Bearer …` header for every request.
 *   2. Translates Savanto's JSON error envelope
 *      (`{ error: { type, message, code, param } }`) into a shaped
 *      `SavantoApiError`, so MCP tool handlers can throw an object whose
 *      `.message` is the human text AND whose machine-readable `.code` is
 *      preserved (e.g. `CRAWL_ALREADY_TERMINAL`, `NOT_FOUND`, …).
 *   3. Respects `SAVANTO_API_URL` so the same server runs against local
 *      dev, staging, and production.
 *
 * MCP tool handlers throw `SavantoApiError`; the server entry point
 * converts it to an MCP-protocol error response in one place.
 */

export interface SavantoErrorShape {
  type?: string;
  message?: string;
  code?: string;
  param?: string;
}

/** HTTP error from the Savanto API with status, optional error code, and raw response body. */
export class SavantoApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly errorType: string | undefined;
  readonly param: string | undefined;
  readonly body: unknown;

  constructor(args: {
    status: number;
    message: string;
    code?: string;
    errorType?: string;
    param?: string;
    body?: unknown;
  }) {
    super(args.message);
    this.name = 'SavantoApiError';
    this.status = args.status;
    this.code = args.code;
    this.errorType = args.errorType;
    this.param = args.param;
    this.body = args.body;
  }
}

/** Minimal client config: API base URL and bearer API key. */
export interface SavantoClient {
  baseUrl: string;
  apiKey: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Options for a single REST call against the Savanto API. */
export interface RequestOptions {
  method?: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Additional request headers (e.g. `X-Workspace-ID`). */
  headers?: Record<string, string>;
  /** Abort the request if it takes longer than this. Default 30s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function buildUrl(baseUrl: string, path: string, query?: RequestOptions['query']): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${baseUrl}${withSlash}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Parses the Savanto error envelope. The cloud returns
 * `{ error: { type, message, code?, param? } }` for all 4xx/5xx responses,
 * but we defensively handle the rare legacy `{ message: "…" }` shape as
 * well as upstream proxies that rewrite the body to plain text.
 */
function shapeErrorBody(body: unknown): SavantoErrorShape {
  if (typeof body === 'string') return { message: body };
  if (typeof body !== 'object' || body === null) return {};
  const envelope = (body as { error?: unknown }).error;
  if (envelope && typeof envelope === 'object') return envelope as SavantoErrorShape;
  // Some legacy 5xx paths flatten `{ message }` without the wrapper.
  const flat = body as { message?: unknown; code?: unknown };
  return {
    message: typeof flat.message === 'string' ? flat.message : undefined,
    code: typeof flat.code === 'string' ? flat.code : undefined,
  };
}

/**
 * Executes a Savanto API request and returns the parsed `data` field
 * (matching the cloud's `{ object, requestId, data }` response envelope).
 * Non-enveloped responses are returned as-is so callers talking to
 * binary/streaming endpoints can still use this for their plumbing.
 */
export async function request<T = unknown>(client: SavantoClient, opts: RequestOptions): Promise<T> {
  const url = buildUrl(client.baseUrl, opts.path, opts.query);
  const method = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  // Keep one timer for the whole call — including the body read below — and
  // only clear it in `finally`. Clearing it as soon as `fetch` resolves the
  // headers would let a stalled body read hang past `timeoutMs`.
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const timeoutError = () =>
    new SavantoApiError({
      status: 504,
      message: `Request to ${method} ${opts.path} timed out after ${timeoutMs}ms`,
      code: 'TIMEOUT',
    });

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${client.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'savanto-mcp/0.1',
          ...(opts.headers ?? {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw timeoutError();
      throw new SavantoApiError({
        status: 0,
        message: `Network error calling ${method} ${opts.path}: ${(err as Error).message}`,
        code: 'NETWORK',
      });
    }

    // 204 No Content
    if (response.status === 204) return undefined as unknown as T;

    // The body read runs after headers arrive, so it has its own failure
    // modes (connection reset mid-body, chunked-transfer errors, or our own
    // timeout firing during a stalled stream). Wrap it so every one surfaces
    // as a `SavantoApiError` like the rest of `request()`, not a raw
    // `TypeError`/`DOMException` that would bypass the tool error envelope.
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw timeoutError();
      throw new SavantoApiError({
        status: response.status,
        message: `Could not read response body from ${method} ${opts.path}: ${(err as Error).message}`,
        code: 'BODY_READ',
      });
    }

    let parsed: unknown;
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      const shape = shapeErrorBody(parsed);
      throw new SavantoApiError({
        status: response.status,
        message: shape.message ?? `Request failed with status ${response.status}`,
        code: shape.code,
        errorType: shape.type,
        param: shape.param,
        body: parsed,
      });
    }

    // Unwrap the `{ object, requestId, data }` envelope when present; fall
    // back to the raw body for endpoints that stream or don't envelope.
    if (parsed && typeof parsed === 'object' && 'data' in (parsed as Record<string, unknown>)) {
      return (parsed as { data: T }).data;
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}
