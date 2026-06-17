/**
 * Schema fragments shared across tool modules.
 */

import { z } from 'zod';

// Workspace IDs in the tenant table accept a broader range than a strict slug
// regex would allow (legacy tenants, capital letters, short names). We validate
// minimally (non-empty, length cap) and let the cloud be the source of truth —
// a tighter client-side regex would make some existing workspaces unaddressable
// via MCP. (`create_workspace` still coaches callers toward a slug via its own
// stricter inputSchema.)
export const WORKSPACE_ID_SCHEMA = z
  .string()
  .min(1)
  .max(100)
  .describe('Workspace ID (typically a slug, e.g. "acme-store").');

/**
 * Confirmation gate for irreversible/destructive tools (deletes). Requiring a
 * literal `true` means a hallucinated tool call with no `confirm` is rejected by
 * the input schema before any request is made.
 */
export const CONFIRM_ARG = z
  .literal(true)
  .describe('Must be `true` to proceed. Safety gate so a hallucinated tool call cannot delete data.');

/**
 * Pagination query params for the cloud list endpoints. The cloud paginates with
 * `page` / `perPage` (NOT limit/offset), perPage capped at 50.
 */
export const LIST_PAGINATION = {
  page: z.number().int().min(1).optional().describe('1-based page number.'),
  perPage: z.number().int().min(1).max(50).optional().describe('Items per page (max 50).'),
} as const;
