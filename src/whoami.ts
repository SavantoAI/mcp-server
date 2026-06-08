/**
 * Startup identity probe.
 *
 * The MCP server needs to know, before it advertises any tools, (1) which
 * tenant it is talking to, (2) the key type (secret vs. publishable), and
 * (3) the scope list — so we can hide tools the caller is not authorised
 * to use, surface a meaningful banner on stderr, and refuse to start at
 * all if the key is revoked or wrong-typed.
 *
 * We call `GET /tenant/whoami` which the cloud purpose-built for this job.
 * If that endpoint is unavailable (older cloud, staging), we fall back to
 * the broader `GET /tenant/status` and infer a minimal scope set. The
 * fallback is intentionally conservative: missing scopes means the tool
 * is not registered, which is a safer failure mode than registering a
 * tool the key can't actually call.
 */

import { z } from 'zod';
import { request, SavantoApiError, type SavantoClient } from './utils/fetch.js';

const whoamiSchema = z.object({
  tenantId: z.string(),
  tier: z.string(),
  apiKeyId: z.string(),
  keyType: z.enum(['secret', 'publishable']),
  // Tolerate a missing `scopes` field: older cloud deploys / staging
  // shims may return whoami without it. Default to [] rather than
  // bombing the startup probe.
  scopes: z.array(z.string()).default([]),
  label: z.string().optional(),
});

/** Tenant identity and API key scopes returned by `GET /tenant/whoami`. */
export type Whoami = z.infer<typeof whoamiSchema>;

function scopesFromStatus(raw: Record<string, unknown>): string[] {
  // Fallback inference — if the cloud predates /tenant/whoami, we only know
  // the key authenticated (so scopes at minimum include `tenant:admin`,
  // which is what /tenant/status itself requires). This is conservative
  // and will hide content-management tools; re-deploy the cloud with the
  // whoami endpoint to unlock the full surface.
  const inferred: string[] = ['tenant:admin'];
  if (raw.publishableKey) inferred.push('chat', 'search:posts', 'search:products');
  return inferred;
}

/** Resolve tenant metadata and scopes for the configured API key. */
export async function fetchWhoami(client: SavantoClient): Promise<Whoami> {
  try {
    // First-party endpoint, but we still Zod-parse the response so a
    // malformed payload (unexpected deploy, proxy mis-match, etc.) turns
    // into a loud validation error at startup rather than a bogus
    // keyType / scope list flowing silently into tool-gating logic.
    const data = await request<unknown>(client, { path: '/tenant/whoami' });
    return whoamiSchema.parse(data);
  } catch (err) {
    if (err instanceof SavantoApiError && err.status === 404) {
      // Older cloud — fall back to /tenant/status.
      //
      // NOTE: /tenant/status aliases the API key id as `jwtSecret` in
      // its response body (see cloud/src/routes/tenant.ts handler for
      // `getStatusRoute`). That's a pre-whoami quirk we tolerate here
      // rather than reshape on the server: once every deployed cloud
      // has /tenant/whoami this fallback goes away entirely, and
      // tightening the alias in the meantime would only break this
      // path. If you rename the cloud field, update this mapping too.
      const fallback = await request<Record<string, unknown>>(client, { path: '/tenant/status' });
      const apiKeyId = typeof fallback.jwtSecret === 'string' ? fallback.jwtSecret : undefined;
      return {
        tenantId: typeof fallback.tenantId === 'string' ? fallback.tenantId : 'unknown',
        tier: typeof fallback.tier === 'string' ? fallback.tier : 'unknown',
        // Deliberately surface 'unknown' so callers / stderr banners can
        // tell the difference between "key id is literally 'unknown'"
        // (would never happen) and "we couldn't read the alias". Don't
        // silently invent a plausible value.
        apiKeyId: apiKeyId ?? 'unknown',
        keyType: 'secret',
        scopes: scopesFromStatus(fallback),
      };
    }
    throw err;
  }
}

/**
 * Handy predicate used by tool registration to decide whether a tool is
 * available in the current key's scope. Mirrors `hasScope` in the cloud
 * but we only need the read side here. A wildcard `*` grants everything;
 * an empty scope list on a secret key also acts as wildcard (legacy
 * behaviour in the cloud's `hasScope`).
 */
export function hasScope(who: Whoami, scope: string): boolean {
  if (who.keyType === 'secret' && who.scopes.length === 0) return true;
  return who.scopes.includes(scope) || who.scopes.includes('*');
}
