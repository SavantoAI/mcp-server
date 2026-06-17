/**
 * Workspace configuration tools.
 *
 * Tier 1 of the "configure your workspace via AI agents" surface. These tools
 * let an agent configure a workspace end-to-end: AI behaviour (handoff settings,
 * special instructions, progress messages), custom domains (CRUD + the
 * discover/generate/validate/test flow), and widget branding/presentation. They
 * proxy the cloud's ADMIN_CONFIG-scoped `/workspace` and `/config` endpoints, so
 * they require a tenant-admin secret key; publishable widget keys can't reach
 * them and the tools simply don't register for such keys.
 *
 * Writes are PATCH-style partial merges (the cloud's `updateSettings` merges
 * rather than replaces), so an agent makes surgical edits without clobbering
 * fields it didn't touch. Pair with `get_workspace_settings` to read-before-write.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maybeRegisterTool, type ToolContext } from '../context.js';
import { WORKSPACE_ID_SCHEMA } from '../schemas/common.js';
import { request, SavantoApiError } from '../utils/fetch.js';
import { okResult } from '../utils/result.js';

// Mirrors cloud/src/routes/workspace.ts → liveAgentSettingsSchema. Every field
// is optional (partial update); the cloud is the source of truth on bounds.
const liveAgentSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.enum(['none', 'slack', 'whatsapp', 'teams']).optional(),
    autoHandoff: z
      .boolean()
      .optional()
      .describe('Let the assistant proactively offer a human when it detects frustration.'),
    manualHandoff: z.boolean().optional().describe('Show a "Talk to a human" button.'),
    escalationPrompt: z.string().max(1500).optional().describe('Custom criteria for when to escalate to a human.'),
    inactivityTimeout: z.number().int().min(60).max(3600).optional().describe('Session timeout in seconds.'),
    contactFormEnabled: z
      .boolean()
      .optional()
      .describe('Offer a contact form as a fallback when no human is available.'),
    businessHours: z.string().max(500).optional().describe('Display text for business hours shown to visitors.'),
  })
  .describe('Live-agent handoff settings. Partial — only the sub-fields you set are changed.');

const DOMAIN_ID_SCHEMA = z.string().min(1).max(100).describe('Custom domain id (from list_custom_domains).');

// Enums mirror cloud/src/types/workspaceSettings.ts → CUSTOM_DOMAIN_LIMITS.
const TOOL_STRATEGY = z.enum(['required', 'auto']);
const RENDER_HINT = z.enum(['card', 'inline', 'prose-only', 'gallery']);
const VERBOSITY = z.enum(['terse', 'standard', 'detailed']);
const PRIVACY = z.enum(['public', 'sensitive']);

// Composer-shaping fields shared by the create/validate shapes. Bounds mirror
// CUSTOM_DOMAIN_LIMITS (composerStreamingFields max 5; toolProgressMessages
// keys/values <= 64/100 chars, max 25 entries — count enforced cloud-side).
const STREAMING_FIELDS = z.array(z.string().min(1).max(64)).max(5);
const TOOL_PROGRESS_MESSAGES = z.record(z.string().min(1).max(64), z.string().min(1).max(100)).optional();

// mcpServers / apiEndpoints carry nested auth + per-endpoint detail. We model the
// identifying fields and `.passthrough()` the rest: the cloud validates the full
// nested shape and returns structured errors, so duplicating that contract here
// would only invite drift. Same "let the cloud be the source of truth" stance as
// WORKSPACE_ID_SCHEMA in schemas/common.ts.
const mcpServerSchema = z
  .object({
    name: z.string().min(1).max(100),
    url: z.string().url(),
    requiresAuth: z.boolean(),
    staticAuth: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const apiEndpointGroupSchema = z
  .object({
    name: z.string().min(1).max(100),
    baseUrl: z.string(),
    responseFormat: z.enum(['json', 'xml']),
    endpoints: z.array(z.record(z.string(), z.unknown())).min(1),
  })
  .passthrough();

// Single source of truth for the custom-domain fields (the `create` contract:
// core prompts required, everything else optional). Lengths mirror
// CUSTOM_DOMAIN_LIMITS in cloud/src/types/workspaceSettings.ts.
const customDomainFields = {
  name: z.string().min(3).max(50).describe('Display name for the domain (e.g. "Order Tracking").'),
  classifierPrompt: z
    .string()
    .min(10)
    .max(500)
    .describe('When this domain should handle a query (drives triage routing).'),
  agentPrompt: z.string().min(20).max(20000).describe('System prompt for the domain agent.'),
  progressMessage: z.string().min(5).max(100).describe('Message shown to the visitor while this domain works.'),
  mcpServers: z.array(mcpServerSchema).max(5).describe('MCP servers backing this domain (use discover_tools first).'),
  apiEndpoints: z.array(apiEndpointGroupSchema).max(3).optional().describe('REST tool groups backing this domain.'),
  enabled: z.boolean().optional().describe('Whether the domain is live. Defaults to false — validate first.'),
  toolStrategy: TOOL_STRATEGY.optional(),
  maxToolTurns: z.number().int().min(1).max(5).optional(),
  exclusive: z.boolean().optional(),
  composerRenderHint: RENDER_HINT.optional(),
  composerVerbosity: VERBOSITY.optional(),
  composerPrivacy: PRIVACY.optional(),
  digestTemplate: z.string().optional(),
  composerStreamingFields: STREAMING_FIELDS.optional().describe(
    'Payload field names that stream character-by-character into the widget (max 5).',
  ),
  toolProgressMessages: TOOL_PROGRESS_MESSAGES.describe(
    'Per-tool progress messages shown while a tool runs (toolName → message; max 25 entries).',
  ),
} as const;

// Mirrors cloud/src/services/chat/agents/schemas/colorSchemeSchemas.ts → HexColor.
const HEX_COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a 6-digit hex color, e.g. "#0084ff".');

// Widget configs are large (40+ fields incl. nested theme objects). We advertise
// the common scalars and `.passthrough()` the rest — the cloud validates the full
// shape. Pair with get_chat_widget_config / get_search_widget_config to
// read-before-modify.
const chatWidgetConfigInput = z
  .object({
    enabled: z.boolean().optional(),
    title: z.string().max(100).optional(),
    subtitle: z.string().max(200).optional(),
    greeting: z.string().max(500).optional(),
    greetingSubtext: z.string().max(500).optional(),
    placeholder: z.string().max(200).optional(),
    triggerPosition: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).optional(),
    cardLayout: z.enum(['carousel', 'stack']).optional(),
    promptStyle: z.enum(['inline', 'input', 'both']).optional(),
    customCSS: z.string().max(10000).optional(),
    resetToDefaults: z.boolean().optional(),
  })
  .passthrough();

const searchWidgetConfigInput = z
  .object({
    enabled: z.boolean().optional(),
    showTrigger: z.boolean().optional(),
    triggerPosition: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).optional(),
    searchProducts: z.boolean().optional(),
    searchPosts: z.boolean().optional(),
    resultLayout: z.enum(['stacked', 'tabbed']).optional(),
    productTabLabel: z.string().max(50).optional(),
    postTabLabel: z.string().max(50).optional(),
    inputPlaceholder: z.string().max(200).optional(),
    customCSS: z.string().max(10000).optional(),
  })
  .passthrough();

// `update` accepts the same fields, all optional — derived from the create
// shape (not re-declared) so the two can't drift. Keeps the create-time bounds,
// matching cloud's updateCustomDomainSchema (min(3)/min(10)/min(20)…, optional).
const customDomainUpdateShape = z.object(customDomainFields).partial().shape;

// `validate` is intentionally LOOSER than create/update: cloud's
// validateCustomDomainSchema drops the min-length bounds so an agent can
// validate a *partial* draft (e.g. a 5-char classifier prompt) and get back the
// quality/overlap feedback rather than a client-side Zod rejection. Mirror that
// looseness here — otherwise the validate-before-write flow can't validate drafts.
const customDomainValidateShape = {
  name: z.string().optional(),
  classifierPrompt: z.string().optional(),
  agentPrompt: z.string().optional(),
  progressMessage: z.string().optional(),
  mcpServers: z.array(mcpServerSchema).optional(),
  apiEndpoints: z.array(apiEndpointGroupSchema).optional(),
  enabled: z.boolean().optional(),
  toolStrategy: TOOL_STRATEGY.optional(),
  maxToolTurns: z.number().int().optional(),
  exclusive: z.boolean().optional(),
  composerRenderHint: RENDER_HINT.optional(),
  composerVerbosity: VERBOSITY.optional(),
  composerPrivacy: PRIVACY.optional(),
  digestTemplate: z.string().optional(),
  composerStreamingFields: STREAMING_FIELDS.optional(),
  toolProgressMessages: TOOL_PROGRESS_MESSAGES,
} as const;

// `test_domain_connection` dry-runs a config, so it must accept the same drafts
// `validate` does (no min-length bounds) — cloud's testCustomDomainSchema uses
// plain strings too. Derived from the loose validate shape with the core fields
// the cloud test route requires made present (and the `id` it needs). Building
// from customDomainFields instead would re-impose create-time mins and break the
// validate → test flow.
const customDomainTestShape = {
  ...customDomainValidateShape,
  id: z.string().describe('Domain id (use any placeholder for an unsaved draft).'),
  name: z.string(),
  classifierPrompt: z.string(),
  agentPrompt: z.string(),
  progressMessage: z.string(),
  mcpServers: z.array(mcpServerSchema),
} as const;

// Built-in (product/post) domain tool config. Mirrors
// cloud/src/routes/workspace.ts → builtinDomainToolsPatchSchema: every field is
// nullable (null clears it) and optional (partial). `tools` reuses the same REST
// tool-group shape as custom domains.
const builtinDomainToolsSchema = z
  .object({
    tools: z
      .array(apiEndpointGroupSchema)
      .max(2)
      .nullable()
      .optional()
      .describe('REST tool groups wired to this built-in domain (max 2). null clears them.'),
    usageHints: z.string().max(1000).nullable().optional().describe('When the curator should call these tools.'),
    maxTurns: z.number().int().min(1).max(5).nullable().optional(),
    toolProgressMessages: z.record(z.string(), z.string()).nullable().optional(),
  })
  .describe('Built-in domain tool config (partial).');

const builtinToolsSchema = z
  .object({
    product: builtinDomainToolsSchema.nullable().optional(),
    post: builtinDomainToolsSchema.nullable().optional(),
  })
  .describe('Attach REST tools to the built-in product/post domains. Partial — only the domains you set change.');

export function registerConfigTools(server: McpServer, ctx: ToolContext): number {
  let registered = 0;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'update_workspace_settings',
      description:
        "Update a workspace's AI-behaviour settings. PATCH-style partial merge: only the fields you supply change; everything else is left intact. Call `get_workspace_settings` first to see current values. Covers `specialInstructions` (facts and corrections the assistant must honour over indexed content), the live-agent handoff config, the business description used for classification, and the progress messages shown while the bot works, and `builtinTools` (attach REST tools to the built-in product/post domains). At least one field must be supplied. (Custom domains and widget branding have their own dedicated tools.)",
      scope: 'config:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        workspaceDescription: z
          .string()
          .max(500)
          .optional()
          .describe('Short description of the business; helps the assistant classify queries.'),
        specialInstructions: z
          .string()
          .max(5000)
          .optional()
          .describe(
            'Admin-provided facts and corrections (markdown supported). The assistant prioritises these over indexed content.',
          ),
        triageProgressMessage: z
          .string()
          .max(100)
          .optional()
          .describe('Message shown to the visitor during the triage/understanding phase.'),
        composerProgressMessage: z
          .string()
          .max(100)
          .optional()
          .describe('Message shown to the visitor while the response is being composed.'),
        liveAgent: liveAgentSchema.optional(),
        builtinTools: builtinToolsSchema.optional(),
      },
      handler: async ({ client }, args) => {
        const { workspaceId, ...body } = args;
        // Zod drops unset optional keys, so an all-empty call yields `{}`.
        // Reject it client-side rather than firing a no-op PATCH.
        if (Object.keys(body).length === 0) {
          throw new SavantoApiError({
            status: 400,
            message: 'At least one settings field must be provided',
            code: 'INVALID_REQUEST',
          });
        }
        const data = await request(client, {
          method: 'PATCH',
          path: `/workspace/${encodeURIComponent(workspaceId)}/settings`,
          body,
        });
        return okResult(data, `Updated settings for workspace "${workspaceId}".`);
      },
    })
  )
    registered++;

  // ── Custom domains ─────────────────────────────────────────────────
  // A "custom domain" is a customer-defined capability (e.g. order tracking)
  // backed by MCP servers / REST tools. The intended agent flow is:
  //   discover_tools → generate_domain_config → validate_custom_domain →
  //   create_custom_domain → test_domain_connection.

  if (
    maybeRegisterTool(server, ctx, {
      name: 'list_custom_domains',
      description:
        'List the custom domains configured for a workspace (id, name, enabled state, prompts, backing tools). Call before updating or deleting one.',
      scope: 'config:admin',
      inputSchema: { workspaceId: WORKSPACE_ID_SCHEMA },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          path: `/workspace/${encodeURIComponent(args.workspaceId)}/custom-domain`,
        });
        return okResult(data, `Custom domains for workspace "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'discover_tools',
      readOnly: true,
      description:
        'Probe one or more MCP servers and return the tools they expose. Use this before generating or creating a custom domain so the domain config references real, reachable tools.',
      scope: 'config:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        mcpServers: z
          .array(z.object({ name: z.string().min(1), url: z.string().url() }))
          .min(1)
          .max(5)
          .describe('MCP servers to probe.'),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'POST',
          path: `/workspace/${encodeURIComponent(args.workspaceId)}/discover-tools`,
          body: { mcpServers: args.mcpServers },
        });
        return okResult(data, `Discovered tools from ${args.mcpServers.length} MCP server(s).`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'generate_domain_config',
      readOnly: true,
      description:
        'AI-generate a draft custom-domain configuration from a natural-language description (and optional reference URLs/text). Returns a config you can review, validate_custom_domain, then create_custom_domain. Does NOT persist anything.',
      scope: 'config:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        description: z
          .string()
          .min(10)
          .max(2000)
          .describe('What the domain should do, e.g. "look up order status and tracking from our Shopify store".'),
        references: z
          .array(
            z.object({
              type: z.enum(['url', 'text']),
              value: z.string().min(1).max(10000),
              label: z.string().max(100).optional(),
            }),
          )
          .max(5)
          .optional()
          .describe('Reference material (docs URLs or pasted text) to ground the generated config.'),
      },
      handler: async ({ client }, args) => {
        const { workspaceId, ...body } = args;
        const data = await request(client, {
          method: 'POST',
          path: `/workspace/${encodeURIComponent(workspaceId)}/custom-domain/generate`,
          body,
        });
        return okResult(data, 'Generated a draft custom-domain config. Validate it before creating.');
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'validate_custom_domain',
      readOnly: true,
      description:
        'Validate a draft custom-domain config WITHOUT saving it. Returns prompt-quality issues and overlap warnings against existing domains. Always validate before create_custom_domain or update_custom_domain. Pass `id` when validating an edit to an existing domain so overlap checks exclude it.',
      scope: 'config:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        ...customDomainValidateShape,
        id: DOMAIN_ID_SCHEMA.optional().describe(
          'Existing domain id, when validating an edit (excludes it from overlap checks).',
        ),
        skipLlmValidation: z
          .boolean()
          .optional()
          .describe('Skip the slower LLM prompt-quality pass; only run structural checks.'),
      },
      handler: async ({ client }, args) => {
        const { workspaceId, ...body } = args;
        const data = await request(client, {
          method: 'POST',
          path: `/workspace/${encodeURIComponent(workspaceId)}/custom-domain/validate`,
          body,
        });
        return okResult(data, 'Validation complete — review issues and overlap warnings before persisting.');
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'create_custom_domain',
      description:
        'Create a custom domain. Run validate_custom_domain first. Defaults to disabled (`enabled: false`) so you can test_domain_connection before going live; set `enabled: true` only once validated and tested.',
      scope: 'config:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        ...customDomainFields,
      },
      handler: async ({ client }, args) => {
        const { workspaceId, ...body } = args;
        const data = await request(client, {
          method: 'POST',
          path: `/workspace/${encodeURIComponent(workspaceId)}/custom-domain`,
          body,
        });
        return okResult(data, `Created custom domain "${args.name}" in workspace "${workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'update_custom_domain',
      description:
        'Update an existing custom domain (partial — only supplied fields change). Validate the intended result first with validate_custom_domain (passing the same `id`).',
      scope: 'config:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        domainId: DOMAIN_ID_SCHEMA,
        ...customDomainUpdateShape,
      },
      handler: async ({ client }, args) => {
        const { workspaceId, domainId, ...body } = args;
        if (Object.keys(body).length === 0) {
          throw new SavantoApiError({
            status: 400,
            message: 'At least one field to update must be provided',
            code: 'INVALID_REQUEST',
          });
        }
        const data = await request(client, {
          method: 'PUT',
          path: `/workspace/${encodeURIComponent(workspaceId)}/custom-domain/${encodeURIComponent(domainId)}`,
          body,
        });
        return okResult(data, `Updated custom domain "${domainId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'delete_custom_domain',
      description:
        'Delete a custom domain. Irreversible — always confirm with the user first. Requires `confirm: true`.',
      scope: 'config:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        domainId: DOMAIN_ID_SCHEMA,
        confirm: z
          .literal(true)
          .describe('Must be `true` to proceed. Safety gate so a hallucinated tool call cannot delete a domain.'),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'DELETE',
          path: `/workspace/${encodeURIComponent(args.workspaceId)}/custom-domain/${encodeURIComponent(args.domainId)}`,
        });
        return okResult(data ?? { deleted: true }, `Deleted custom domain "${args.domainId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'test_domain_connection',
      readOnly: true,
      description:
        'Dry-run a custom-domain config against sample visitor queries to see whether triage would route them to it (and exercise its tools) — without saving. Use after generate/validate to sanity-check classification before create_custom_domain.',
      scope: 'config:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        domain: z
          .object(customDomainTestShape)
          .describe('The full domain config to test (an `id` is required; use any placeholder for an unsaved draft).'),
        testQueries: z
          .array(z.string().max(500))
          .min(1)
          .max(5)
          .describe('Sample visitor messages to classify against this domain.'),
      },
      handler: async ({ client }, args) => {
        const { workspaceId, ...body } = args;
        const data = await request(client, {
          method: 'POST',
          path: `/workspace/${encodeURIComponent(workspaceId)}/test-connection`,
          body,
        });
        return okResult(data, `Tested ${args.testQueries.length} query(ies) against the domain config.`);
      },
    })
  )
    registered++;

  // ── Branding & widget presentation ─────────────────────────────────

  if (
    maybeRegisterTool(server, ctx, {
      name: 'generate_color_scheme',
      readOnly: true,
      description:
        'Generate a full light + dark widget color palette from one or two brand hex colors. Returns a theme object you can review and then apply via update_chat_widget_config. Does NOT persist anything.',
      scope: 'config:admin',
      inputSchema: {
        primaryColor: HEX_COLOR.describe('Primary brand color, e.g. "#0084ff".'),
        secondaryColor: HEX_COLOR.optional().describe('Optional secondary brand color for a richer palette.'),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'POST',
          path: '/config/color-scheme',
          body: args,
        });
        return okResult(data, 'Generated a color palette. Apply it with update_chat_widget_config.');
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_chat_widget_config',
      description:
        'Read the chat widget presentation config (trigger, header, greeting, card layout, theme/colors, custom CSS). Read this before update_chat_widget_config so you only change what you intend.',
      scope: 'config:admin',
      inputSchema: { workspaceId: WORKSPACE_ID_SCHEMA },
      handler: async ({ client }, args) => {
        const data = await request(client, { path: `/workspace/${encodeURIComponent(args.workspaceId)}/chat` });
        return okResult(data, `Chat widget config for workspace "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'update_chat_widget_config',
      description:
        'Update the chat widget presentation. Read get_chat_widget_config first and pass only the fields you want to change — common scalars are advertised here, and any other valid widget-config field (theme/darkTheme objects, etc.) is passed through to the server, which validates it. Pass `resetToDefaults: true` to restore defaults.',
      scope: 'config:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        config: chatWidgetConfigInput.describe(
          'Chat widget fields to change (partial). Extra valid fields pass through.',
        ),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'POST',
          path: `/workspace/${encodeURIComponent(args.workspaceId)}/chat`,
          body: args.config,
        });
        return okResult(data, `Updated chat widget config for workspace "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_search_widget_config',
      description:
        'Read the search widget presentation config (trigger, layout, product/post tabs, theme). Read before update_search_widget_config.',
      scope: 'config:admin',
      inputSchema: { workspaceId: WORKSPACE_ID_SCHEMA },
      handler: async ({ client }, args) => {
        const data = await request(client, { path: `/workspace/${encodeURIComponent(args.workspaceId)}/search` });
        return okResult(data, `Search widget config for workspace "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'update_search_widget_config',
      description:
        'Update the search widget presentation. Read get_search_widget_config first and pass only the fields you want to change; common scalars are advertised and other valid fields (theme object, etc.) pass through to the server, which validates them.',
      scope: 'config:admin',
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        config: searchWidgetConfigInput.describe(
          'Search widget fields to change (partial). Extra valid fields pass through.',
        ),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'POST',
          path: `/workspace/${encodeURIComponent(args.workspaceId)}/search`,
          body: args.config,
        });
        return okResult(data, `Updated search widget config for workspace "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  return registered;
}
