/**
 * Workspace management tools.
 *
 * A Savanto tenant can host multiple "workspaces" (one per storefront or
 * site). Every content/chat/crawl operation happens within a workspace,
 * so the first thing an agent typically does in a provisioning flow is
 * list existing ones, or create a new one.
 *
 * These five tools cover the workspace lifecycle end-to-end. We gate
 * them on `tenant:admin` because only secret keys with admin rights can
 * touch the workspace table — publishable keys are workspace-scoped
 * already and never need to call these endpoints.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maybeRegisterTool, type ToolContext } from '../context.js';
import { request, SavantoApiError } from '../utils/fetch.js';
import { okResult } from '../utils/result.js';

// Workspace IDs in the tenant table have historically accepted a broader
// range than a strict slug regex would allow (legacy tenants, capital
// letters, short names). We validate minimally here (non-empty, length
// cap) and let the cloud be the source of truth — enforcing a tighter
// client-side regex would make some existing workspaces unaddressable
// via MCP. `create_workspace` callers are still coached toward a slug
// shape by the argument description.
const WORKSPACE_ID_SCHEMA = z.string().min(1).max(100).describe('Workspace ID (typically a slug, e.g. "acme-store").');

export function registerWorkspaceTools(server: McpServer, ctx: ToolContext): number {
  let registered = 0;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'list_workspaces',
      description:
        'List every workspace belonging to the authenticated tenant. Returns workspace IDs, names, domains, platforms, and statuses. Call this first when you need to find or select a workspace.',
      scope: 'tenant:admin',
      inputSchema: {},
      handler: async ({ client }) => {
        const data = await request<{ items: unknown[]; pagination: unknown }>(client, {
          path: '/tenant/workspaces',
        });
        return okResult(data, `Found ${Array.isArray(data.items) ? data.items.length : 0} workspace(s).`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'create_workspace',
      description:
        'Create a new workspace. The workspaceId must be a slug (lowercase alphanumeric + hyphens) and unique within the tenant. Use this to onboard an additional storefront, site, or brand.',
      scope: 'tenant:admin',
      // The cloud route currently only consumes workspaceId, name, and
      // siteUrl, and hardcodes platform='wordpress' regardless of input
      // (see cloud/src/routes/tenant.ts → createWorkspaceRoute). We
      // intentionally do NOT advertise `platform` or `description` here
      // because the cloud silently ignores them, which is worse than
      // refusing to accept them — an agent that sets `platform: 'shopify'`
      // and sees no error reasonably assumes it took effect.
      inputSchema: {
        workspaceId: z
          .string()
          .min(3)
          .max(50)
          .regex(
            /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/,
            'Must be 3-50 characters, lowercase alphanumeric with hyphens (cannot start or end with hyphen).',
          )
          .describe('New workspace slug, e.g. "acme-store". Must be unique within the tenant.'),
        name: z.string().optional().describe('Human-readable display name for dashboards and emails.'),
        siteUrl: z.string().url().optional().describe('Primary site URL of the workspace.'),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'POST',
          path: '/tenant/workspaces',
          body: args,
        });
        return okResult(data, `Created workspace "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'update_workspace',
      // The cloud route only accepts `name` and `domain` (see
      // updateWorkspaceBodySchema in cloud/src/routes/tenant.ts) and 400s
      // when neither is supplied. We mirror that here so the failure
      // mode is "tool rejects the call upfront" rather than "cloud
      // returns a 400 the model has to interpret".
      description:
        "Update a workspace's display name or domain. Does not affect indexed content. At least one of `name` or `domain` must be supplied.",
      scope: 'tenant:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        name: z.string().min(1).max(200).optional(),
        domain: z.string().min(1).max(255).optional(),
      },
      handler: async ({ client }, args) => {
        const { workspaceId, ...body } = args;
        if (body.name === undefined && body.domain === undefined) {
          // Match the cloud's `.refine()` message so the error is
          // recognisable regardless of which layer caught it first.
          throw new SavantoApiError({
            status: 400,
            message: 'At least one field (name, domain) must be provided',
            code: 'INVALID_REQUEST',
          });
        }
        const data = await request(client, {
          method: 'PUT',
          path: `/tenant/workspaces/${encodeURIComponent(workspaceId)}`,
          body,
        });
        return okResult(data, `Updated workspace "${workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'delete_workspace',
      description:
        'Delete a workspace and all of its indexed content (products, posts, threads). This is irreversible — always ask the user to confirm before calling.',
      scope: 'tenant:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        confirm: z
          .literal(true)
          .describe('Must be `true` to proceed. Safety gate so a hallucinated tool call does not nuke data.'),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'DELETE',
          path: `/tenant/workspaces/${encodeURIComponent(args.workspaceId)}`,
        });
        return okResult(data ?? { deleted: true }, `Deleted workspace "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_workspace_settings',
      description:
        'Retrieve detailed settings for a workspace — chat widget config, search widget config, live-agent schedule, MCP config, custom domains. Use this to introspect how a workspace is configured before making changes.',
      scope: 'tenant:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          path: `/workspace/${encodeURIComponent(args.workspaceId)}/details`,
        });
        return okResult(data, `Settings for workspace "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  return registered;
}
