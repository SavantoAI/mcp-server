/**
 * Loads the Savanto API key from the environment and validates it is a
 * secret key. The MCP server is designed to run in trusted, server-side
 * contexts (developer machines, CI, agents running inside a company
 * network), so we reject publishable keys up front — their scope set
 * cannot provision workspaces or manage content and the resulting error
 * messages further down would be confusing ("you have the wrong scope"
 * instead of "wrong key type entirely").
 *
 * The loader returns plain data rather than throwing when the key is
 * missing, so callers can print a friendly setup message before exiting.
 */

const SECRET_KEY_PREFIX = 'if_sk_';
const PUBLISHABLE_KEY_PREFIX = 'if_pk_';

export type ApiKeyLoadError =
  | { kind: 'missing' }
  | { kind: 'publishable_rejected' }
  | { kind: 'malformed'; prefix: string };

export type ApiKeyLoadResult = { ok: true; apiKey: string } | { ok: false; error: ApiKeyLoadError };

/**
 * Validate a raw key string's prefix. The single source of truth for "is this
 * a usable secret key" — shared by the env loader (stdio) and the header loader
 * (remote HTTP transport), so both channels accept/reject identically.
 */
function classifyApiKey(raw: string | undefined | null): ApiKeyLoadResult {
  if (!raw || raw.trim() === '') {
    return { ok: false, error: { kind: 'missing' } };
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith(PUBLISHABLE_KEY_PREFIX)) {
    return { ok: false, error: { kind: 'publishable_rejected' } };
  }
  if (!trimmed.startsWith(SECRET_KEY_PREFIX)) {
    return { ok: false, error: { kind: 'malformed', prefix: trimmed.slice(0, 7) } };
  }
  return { ok: true, apiKey: trimmed };
}

/**
 * Reads `SAVANTO_API_KEY` from the provided env (defaults to `process.env`)
 * and validates the prefix. Centralised so the stdio entry point and any
 * future transports share one source of truth.
 */
export function loadApiKey(env: NodeJS.ProcessEnv = process.env): ApiKeyLoadResult {
  return classifyApiKey(env.SAVANTO_API_KEY);
}

/**
 * Extracts and validates the secret key from an HTTP `Authorization` header.
 * Used by the remote (Streamable HTTP) transport, where each request carries
 * `Authorization: Bearer if_sk_…` instead of reading the key from the env.
 * Anything that isn't a `Bearer` token reads as `missing` (same as no header),
 * so the caller emits one consistent 401 + `WWW-Authenticate: Bearer`.
 */
export function loadApiKeyFromHeader(authorization: string | undefined | null): ApiKeyLoadResult {
  if (!authorization) return { ok: false, error: { kind: 'missing' } };
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return { ok: false, error: { kind: 'missing' } };
  return classifyApiKey(match[1]);
}

/**
 * Resolves the base URL of the Savanto API. Defaults to production so the
 * common case (a developer running `npx savanto-mcp` without extra env) is
 * zero-config. Local dev sets `SAVANTO_API_URL=http://localhost:3001`.
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SAVANTO_API_URL?.trim();
  if (raw && raw.length > 0) return raw.replace(/\/$/, '');
  return 'https://api.savanto.ai';
}

/**
 * Where the credential came from, so the message names the right thing to fix:
 * the `SAVANTO_API_KEY` env var (stdio) or the `Authorization` header (HTTP).
 */
export type CredentialSource = 'env' | 'bearer';

/**
 * Human-readable hint for each `ApiKeyLoadError`, tailored to the channel that
 * supplied the key. One exhaustive switch so a new error kind is handled in a
 * single place. The stdio entry point prints the `env` variant to stderr (MCP
 * treats stdout as its transport); the HTTP transport returns the `bearer`
 * variant in its 401 body.
 */
export function describeApiKeyError(error: ApiKeyLoadError, source: CredentialSource = 'env'): string {
  const bearer = source === 'bearer';
  switch (error.kind) {
    case 'missing':
      return bearer
        ? 'Missing or malformed Authorization header. Provide `Authorization: Bearer if_sk_…` with a Savanto secret key.'
        : 'SAVANTO_API_KEY is not set. Create a secret API key at ' +
            'https://savanto.ai/dashboard/api-keys and export it, e.g.\n' +
            '  export SAVANTO_API_KEY=if_sk_…';
    case 'publishable_rejected':
      return bearer
        ? 'Publishable keys (`if_pk_…`) are client-side and cannot configure a workspace. Use a secret key (`if_sk_…`).'
        : 'SAVANTO_API_KEY looks like a publishable key (`if_pk_…`). Publishable keys are ' +
            'client-side and cannot provision workspaces. Use a secret key (`if_sk_…`).';
    case 'malformed':
      return bearer
        ? `Unexpected key prefix "${error.prefix}". Expected a secret key starting with "${SECRET_KEY_PREFIX}".`
        : `SAVANTO_API_KEY has an unexpected prefix: "${error.prefix}". Expected a secret key starting with "${SECRET_KEY_PREFIX}".`;
  }
}
