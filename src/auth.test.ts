import { describe, expect, it } from 'vitest';
import { describeApiKeyError, loadApiKey, loadApiKeyFromHeader, resolveBaseUrl } from './auth.js';

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

describe('loadApiKeyFromHeader', () => {
  it('extracts a secret key from a Bearer header', () => {
    expect(loadApiKeyFromHeader('Bearer if_sk_abc123')).toEqual({ ok: true, apiKey: 'if_sk_abc123' });
  });

  it('is case-insensitive on the Bearer scheme and trims the token', () => {
    expect(loadApiKeyFromHeader('bearer   if_sk_xyz  ')).toEqual({ ok: true, apiKey: 'if_sk_xyz' });
  });

  it('treats a missing / empty header as "missing"', () => {
    expect(loadApiKeyFromHeader(undefined)).toEqual({ ok: false, error: { kind: 'missing' } });
    expect(loadApiKeyFromHeader(null)).toEqual({ ok: false, error: { kind: 'missing' } });
    expect(loadApiKeyFromHeader('')).toEqual({ ok: false, error: { kind: 'missing' } });
  });

  it('treats a non-Bearer scheme as "missing" (one consistent 401)', () => {
    expect(loadApiKeyFromHeader('Basic if_sk_abc')).toEqual({ ok: false, error: { kind: 'missing' } });
    expect(loadApiKeyFromHeader('if_sk_no_scheme')).toEqual({ ok: false, error: { kind: 'missing' } });
  });

  it('rejects a publishable key carried as a Bearer token', () => {
    expect(loadApiKeyFromHeader('Bearer if_pk_widget')).toEqual({
      ok: false,
      error: { kind: 'publishable_rejected' },
    });
  });

  it('reports a malformed token with its observed prefix', () => {
    expect(loadApiKeyFromHeader('Bearer sk-legacy1')).toEqual({
      ok: false,
      error: { kind: 'malformed', prefix: 'sk-lega' },
    });
  });
});

describe('describeApiKeyError', () => {
  it('names each error kind with actionable next-steps (env channel default)', () => {
    // Message content is part of the UX contract for the stdio banner;
    // it's what a brand-new user sees when bootstrapping goes wrong.
    expect(describeApiKeyError({ kind: 'missing' })).toMatch(/SAVANTO_API_KEY is not set/);
    expect(describeApiKeyError({ kind: 'publishable_rejected' })).toMatch(/publishable/i);
    expect(describeApiKeyError({ kind: 'malformed', prefix: 'xx' })).toMatch(/xx/);
  });

  it('uses header-appropriate copy for the bearer channel', () => {
    // Over HTTP there is no env var — the message must point at the header.
    expect(describeApiKeyError({ kind: 'missing' }, 'bearer')).toMatch(/Authorization header/i);
    expect(describeApiKeyError({ kind: 'missing' }, 'bearer')).not.toMatch(/SAVANTO_API_KEY/);
    expect(describeApiKeyError({ kind: 'publishable_rejected' }, 'bearer')).toMatch(/publishable/i);
    expect(describeApiKeyError({ kind: 'malformed', prefix: 'zz' }, 'bearer')).toMatch(/zz/);
  });
});
