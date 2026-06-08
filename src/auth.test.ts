import { describe, expect, it } from 'vitest';
import { describeApiKeyError, loadApiKey, resolveBaseUrl } from './auth.js';

describe('loadApiKey', () => {
  it('accepts a well-formed secret key', () => {
    const result = loadApiKey({ SAVANTO_API_KEY: 'if_sk_abc123' } as NodeJS.ProcessEnv);
    expect(result).toEqual({ ok: true, apiKey: 'if_sk_abc123' });
  });

  it('trims surrounding whitespace before validating', () => {
    const result = loadApiKey({ SAVANTO_API_KEY: '  if_sk_spaced  \n' } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.apiKey).toBe('if_sk_spaced');
  });

  it('rejects publishable keys with a dedicated error kind', () => {
    // Publishable keys are workspace-scoped and don't have the tenant:admin
    // scope MCP assumes. Failing early with a SPECIFIC reason lets the CLI
    // print "use a secret key" instead of a generic "wrong scope" later on.
    const result = loadApiKey({ SAVANTO_API_KEY: 'if_pk_widget123' } as NodeJS.ProcessEnv);
    expect(result).toEqual({ ok: false, error: { kind: 'publishable_rejected' } });
  });

  it('rejects missing / empty values', () => {
    expect(loadApiKey({} as NodeJS.ProcessEnv)).toEqual({ ok: false, error: { kind: 'missing' } });
    expect(loadApiKey({ SAVANTO_API_KEY: '' } as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      error: { kind: 'missing' },
    });
    expect(loadApiKey({ SAVANTO_API_KEY: '   ' } as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      error: { kind: 'missing' },
    });
  });

  it('reports malformed keys with the observed prefix for debugging', () => {
    const result = loadApiKey({ SAVANTO_API_KEY: 'sk-legacy1234' } as NodeJS.ProcessEnv);
    expect(result).toEqual({ ok: false, error: { kind: 'malformed', prefix: 'sk-lega' } });
  });
});

describe('resolveBaseUrl', () => {
  it('defaults to the prod host when SAVANTO_API_URL is unset', () => {
    expect(resolveBaseUrl({} as NodeJS.ProcessEnv)).toBe('https://api.savanto.ai');
  });

  it('uses the override when provided and strips the trailing slash', () => {
    expect(resolveBaseUrl({ SAVANTO_API_URL: 'http://localhost:3001/' } as NodeJS.ProcessEnv)).toBe(
      'http://localhost:3001',
    );
  });

  it('treats whitespace-only as unset (falls back to default)', () => {
    expect(resolveBaseUrl({ SAVANTO_API_URL: '   ' } as NodeJS.ProcessEnv)).toBe('https://api.savanto.ai');
  });
});

describe('describeApiKeyError', () => {
  it('names each error kind with actionable next-steps', () => {
    // Message content is part of the UX contract for the stdio banner;
    // it's what a brand-new user sees when bootstrapping goes wrong.
    expect(describeApiKeyError({ kind: 'missing' })).toMatch(/SAVANTO_API_KEY is not set/);
    expect(describeApiKeyError({ kind: 'publishable_rejected' })).toMatch(/publishable/i);
    expect(describeApiKeyError({ kind: 'malformed', prefix: 'xx' })).toMatch(/xx/);
  });
});
