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
 * Reads `SAVANTO_API_KEY` from the provided env (defaults to `process.env`)
 * and validates the prefix. Centralised so the stdio entry point and any
 * future transports share one source of truth.
 */
export function loadApiKey(env: NodeJS.ProcessEnv = process.env): ApiKeyLoadResult {
  const raw = env.SAVANTO_API_KEY;
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
 * Human-readable hint for each `ApiKeyLoadError`. The stdio entry point
 * prints this to stderr (MCP treats stdout as its transport, so any
 * user-facing text must go to stderr).
 */
export function describeApiKeyError(error: ApiKeyLoadError): string {
  switch (error.kind) {
    case 'missing':
      return (
        'SAVANTO_API_KEY is not set. Create a secret API key at ' +
        'https://savanto.ai/dashboard/api-keys and export it, e.g.\n' +
        '  export SAVANTO_API_KEY=if_sk_…'
      );
    case 'publishable_rejected':
      return (
        'SAVANTO_API_KEY looks like a publishable key (`if_pk_…`). Publishable keys are ' +
        'client-side and cannot provision workspaces. Use a secret key (`if_sk_…`).'
      );
    case 'malformed':
      return `SAVANTO_API_KEY has an unexpected prefix: "${error.prefix}". Expected a secret key starting with "${SECRET_KEY_PREFIX}".`;
  }
}
