import { describe, expect, it } from 'vitest';
import { SavantoApiError } from './fetch.js';
import { errorResult, okResult } from './result.js';

describe('okResult', () => {
  it('returns a single text block plus structuredContent for JSON objects', () => {
    const out = okResult({ workspaceId: 'ws-1' }, 'Created workspace.');
    expect(out.content).toHaveLength(1);
    expect(out.content[0]).toMatchObject({ type: 'text' });
    expect(out.content[0].text).toContain('Created workspace.');
    expect(out.content[0].text).toContain('"workspaceId"');
    // MCP clients (Claude Desktop, Inspector) prefer structuredContent
    // for machine-readable downstream use — so we always populate it.
    expect(out.structuredContent).toEqual({ workspaceId: 'ws-1' });
  });

  it('wraps non-object primitives under { value } for structuredContent', () => {
    const out = okResult(42, 'Answer computed.');
    expect(out.structuredContent).toEqual({ value: 42 });
  });

  it('wraps arrays under { value } (arrays are not plain objects)', () => {
    const out = okResult([1, 2, 3]);
    expect(out.structuredContent).toEqual({ value: [1, 2, 3] });
  });
});

describe('errorResult', () => {
  it('flags the result as an error and includes the envelope code / status', () => {
    const err = new SavantoApiError({
      status: 409,
      message: 'Crawl already finished',
      code: 'CRAWL_ALREADY_TERMINAL',
      errorType: 'invalid_request_error',
    });
    const out = errorResult(err);
    expect(out.isError).toBe(true);
    // First block: human-readable one-liner. Second block: structured
    // JSON payload tool-picker LLMs can parse without heuristics.
    expect(out.content[0].text).toContain('409');
    expect(out.content[0].text).toContain('CRAWL_ALREADY_TERMINAL');
    expect(out.structuredContent).toMatchObject({
      error: { status: 409, code: 'CRAWL_ALREADY_TERMINAL', message: 'Crawl already finished' },
    });
  });

  it('handles errors without a code (legacy flat body)', () => {
    const err = new SavantoApiError({ status: 500, message: 'boom' });
    const out = errorResult(err);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('500');
    expect(out.content[0].text).toContain('boom');
  });
});
