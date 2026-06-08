/**
 * Diagnostic tools — always safe, always available.
 *
 * `whoami` is the first tool an agent should call when it's unsure what
 * it can do. It returns the tenant ID, scopes, and label, which are also
 * what the MCP server reports to the caller at startup over stderr.
 *
 * `get_usage` is a quick sanity check on tier limits — lets an agent say
 * "you've used 12k of your 50k monthly chat messages" when asked.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { maybeRegisterTool, type ToolContext } from '../context.js';
import { request } from '../utils/fetch.js';
import { okResult } from '../utils/result.js';

export function registerDiagnosticTools(server: McpServer, ctx: ToolContext): number {
  let registered = 0;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'whoami',
      description:
        'Return the current tenant ID, API key label, key type, and scope list. No side effects — safe to call at any time.',
      // No scope requirement — this tool always works once the key authenticates.
      inputSchema: {},
      handler: async ({ who }) => {
        return okResult(
          {
            tenantId: who.tenantId,
            tier: who.tier,
            apiKeyId: who.apiKeyId,
            keyType: who.keyType,
            scopes: who.scopes,
            label: who.label,
          },
          `Authenticated as tenant ${who.tenantId} (${who.keyType} key, ${who.scopes.length || 'all'} scopes).`,
        );
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_tenant_usage',
      description:
        'Return a summary of the tenant\'s current-period usage (chat messages, indexed documents, crawled pages) and tier limits. Useful for answering "how much of my quota have I used?".',
      scope: 'tenant:admin',
      inputSchema: {},
      handler: async ({ client }) => {
        const data = await request(client, { path: '/tenant/usage' });
        return okResult(data);
      },
    })
  )
    registered++;

  return registered;
}
