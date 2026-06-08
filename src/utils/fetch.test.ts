import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request, SavantoApiError, type SavantoClient } from './fetch.js';

const CLIENT: SavantoClient = { baseUrl: 'http://localhost:3001', apiKey: 'if_sk_test' };

/**
 * Helpers for stubbing the global `fetch` used inside `request()`.
 */
function mockResponse(body: unknown, init: { status?: number; text?: string } = {}): Response {
  const text = init.text ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(text, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('request', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('unwraps the `data` field on successful enveloped responses', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockResponse({ object: 'tenant', requestId: 'r-1', data: { tenantId: 't-1' } }),
    );
    const out = await request<{ tenantId: string }>(CLIENT, { path: '/tenant/whoami' });
    expect(out).toEqual({ tenantId: 't-1' });
  });

  it('returns the raw body when the response is NOT enveloped', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse({ tenantId: 't-1' }));
    const out = await request<{ tenantId: string }>(CLIENT, { path: '/tenant/custom' });
    expect(out).toEqual({ tenantId: 't-1' });
  });

  it('handles 204 No Content by returning undefined', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const out = await request(CLIENT, { path: '/some/resource', method: 'DELETE' });
    expect(out).toBeUndefined();
  });

  it('sends the bearer header, content-type, and user-agent on every call', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse({ data: {} }));
    await request(CLIENT, { path: '/ping' });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer if_sk_test');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['User-Agent']).toMatch(/savanto-mcp/);
  });

  it('serialises POST bodies as JSON and merges custom headers', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse({ data: {} }));
    await request(CLIENT, {
      method: 'POST',
      path: '/crawl',
      body: { url: 'https://example.com' },
      headers: { 'X-Workspace-ID': 'ws-1' },
    });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.body).toBe(JSON.stringify({ url: 'https://example.com' }));
    expect(init.headers['X-Workspace-ID']).toBe('ws-1');
  });

  it('appends query parameters correctly (skipping undefined)', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse({ data: [] }));
    await request(CLIENT, {
      path: '/products',
      query: { limit: 10, offset: undefined, stockStatus: 'in_stock' },
    });
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('limit')).toBe('10');
    expect(parsed.searchParams.get('stockStatus')).toBe('in_stock');
    expect(parsed.searchParams.has('offset')).toBe(false);
  });

  it('throws SavantoApiError with the code and message from the envelope on 4xx', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockResponse(
        {
          error: { type: 'invalid_request_error', message: 'Crawl already finished', code: 'CRAWL_ALREADY_TERMINAL' },
        },
        { status: 409 },
      ),
    );
    // We specifically verify `code` survives the round-trip: downstream
    // UIs branch on CRAWL_ALREADY_TERMINAL to show a soft-success banner
    // instead of a red error, and losing the code here would regress UX.
    await expect(request(CLIENT, { path: '/crawl/x/notifications', method: 'POST' })).rejects.toMatchObject({
      status: 409,
      code: 'CRAWL_ALREADY_TERMINAL',
      message: 'Crawl already finished',
    });
  });

  it('handles legacy flat `{ message }` error bodies (no envelope wrapper)', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockResponse({ message: 'boom' }, { status: 500 }),
    );
    await expect(request(CLIENT, { path: '/x' })).rejects.toMatchObject({ status: 500, message: 'boom' });
  });

  it('handles non-JSON error bodies (HTML error page, text/plain)', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockResponse('<html>...</html>', { status: 502, text: '<html>...</html>' }),
    );
    const err = await request(CLIENT, { path: '/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SavantoApiError);
    if (err instanceof SavantoApiError) expect(err.status).toBe(502);
  });

  it('surfaces a TIMEOUT error when the request exceeds the timeout', async () => {
    // Use a fake fetch that never resolves — the AbortController inside
    // `request` should fire after the short timeout we pass in.
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const err = await request(CLIENT, { path: '/slow', timeoutMs: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SavantoApiError);
    if (err instanceof SavantoApiError) {
      expect(err.code).toBe('TIMEOUT');
      expect(err.status).toBe(504);
    }
  });

  it('wraps arbitrary network errors as SavantoApiError with code NETWORK', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const err = await request(CLIENT, { path: '/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SavantoApiError);
    if (err instanceof SavantoApiError) {
      expect(err.code).toBe('NETWORK');
      expect(err.status).toBe(0);
    }
  });

  it('wraps body-read failures (connection reset mid-body) as SavantoApiError with code BODY_READ', async () => {
    // Headers arrive fine (status 200), but draining the body rejects — e.g.
    // the connection is reset after headers. This must NOT escape as a raw
    // TypeError/DOMException past the SavantoApiError contract.
    const stub = {
      status: 200,
      ok: true,
      text: () => Promise.reject(new Error('socket hang up')),
    } as unknown as Response;
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(stub);

    const err = await request(CLIENT, { path: '/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SavantoApiError);
    if (err instanceof SavantoApiError) {
      expect(err.code).toBe('BODY_READ');
      expect(err.status).toBe(200);
      expect(err.message).toContain('socket hang up');
    }
  });

  it('times out when the response body stalls after headers arrive', async () => {
    // Headers resolve immediately, but the body never drains. The timeout
    // timer must still fire (it is no longer cleared the moment fetch
    // resolves), aborting the stalled body read and surfacing TIMEOUT.
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce((_url, init: RequestInit) => {
      const stub = {
        status: 200,
        ok: true,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      } as unknown as Response;
      return Promise.resolve(stub);
    });

    const err = await request(CLIENT, { path: '/slow-body', timeoutMs: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SavantoApiError);
    if (err instanceof SavantoApiError) {
      expect(err.code).toBe('TIMEOUT');
      expect(err.status).toBe(504);
    }
  });
});
