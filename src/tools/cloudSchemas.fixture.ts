/**
 * Cloud request-schema mirrors for the MCP tool tests.
 *
 * Extracted from tools.test.ts to keep that file focused. These are trimmed
 * Zod mirrors of each cloud route request body; the per-tool tests round-trip
 * the outgoing body through them so a tool drifting from the cloud contract
 * lights up. They are deliberately INDEPENDENT of the tools own schemas (not
 * imported from the tool modules) — that independence is what lets them catch
 * tool-vs-cloud drift. Keep them in lock-step with cloud/src/routes/*.ts.
 */

import { z } from 'zod';

// cloud/src/routes/products.ts → productSchema (subset the MCP emits). Shared by
// the single + bulk upsert mirrors so they can't drift.
const productItemCloud = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    content: z.string().optional(),
    excerpt: z.string().optional(),
    price: z.number().nullable().optional(),
    salePrice: z.number().nullable().optional(),
    image: z.string().nullable().optional(),
    url: z.string().optional(),
    categories: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    brands: z.array(z.string()).optional(),
    stockStatus: z.enum(['instock', 'outofstock', 'onbackorder']).optional(),
    sku: z.string().optional(),
  })
  .strict();

// cloud/src/routes/posts.ts → postSchema (subset).
const postItemCloud = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    content: z.string().optional(),
    url: z.string().optional(),
    excerpt: z.string().optional(),
    tags: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    publishedAt: z.string().nullable().optional(),
  })
  .strict();

// cloud/src/routes/taxonomies.ts → taxonomySchema (subset the MCP emits).
const taxonomyItemCloud = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    slug: z.string().min(1),
    taxonomyName: z.string().min(1),
    description: z.string().optional(),
    parent: z.number().int().min(0).optional(),
    type: z.string().optional(),
    taxonomyLabel: z.string().optional(),
    hierarchy: z.array(z.string()).optional(),
  })
  .strict();

// cloud/src/routes/prompts.ts → promptSchema (strict; subset the MCP emits).
const promptItemCloud = z
  .object({
    id: z.string().min(1).max(100).optional(),
    prompt: z.string().min(1).max(1000),
    title: z.string().max(200).optional(),
    description: z.string().max(500).optional(),
    cannedResponse: z.string().max(5000).optional(),
    responseFormat: z.enum(['markdown', 'text', 'html']).optional(),
    overrideMode: z.enum(['override', 'fallback']).optional(),
    productIds: z.array(z.string().max(100)).max(50).optional(),
    postIds: z.array(z.string().max(100)).max(50).optional(),
    followUpIds: z.array(z.string().max(100)).max(20).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
    categories: z.array(z.string().max(50)).max(10).optional(),
    status: z.string().max(50).optional(),
    priority: z.number().int().min(0).max(9999).optional(),
    icon: z.string().max(10).optional(),
  })
  .strict();

// cloud/src/routes/workspace.ts → builtinDomainToolsPatchSchema (nullable fields).
// `tools` is a list of REST endpoint groups (passthrough — cloud validates the
// nested shape, like the custom-domain mirrors).
const builtinDomainToolsCloud = z
  .object({
    tools: z.array(z.object({}).passthrough()).max(2).nullable().optional(),
    usageHints: z.string().max(1000).nullable().optional(),
    maxTurns: z.number().int().min(1).max(5).nullable().optional(),
    toolProgressMessages: z.record(z.string(), z.string()).nullable().optional(),
  })
  .strict();

export const CLOUD_SCHEMAS = {
  // cloud/src/routes/threads.ts → threadSearchSchema (search_threads).
  searchThreads: z
    .object({
      query: z.string().optional(),
      userId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      minMessages: z.number().int().min(0).optional(),
      maxMessages: z.number().int().min(0).optional(),
      minTokens: z.number().int().min(0).optional(),
      maxTokens: z.number().int().min(0).optional(),
      hasUnresolvedQueries: z.boolean().optional(),
      sortBy: z.enum(['timestamp', 'messageCount', 'tokenCount']).optional(),
      sortOrder: z.enum(['asc', 'desc']).optional(),
    })
    .strict(),
  // cloud/src/routes/analytics.ts → searchSearchBodySchema (search_search_logs).
  searchSearchLogs: z
    .object({
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
      workspaceId: z.string().optional(),
      query: z.string().optional(),
      zeroResultsOnly: z.boolean().optional(),
      source: z.union([z.string(), z.array(z.string())]).optional(),
      type: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      sortBy: z.string().optional(),
      sortOrder: z.enum(['asc', 'desc']).optional(),
    })
    .strict(),
  // cloud/src/routes/webhooks.ts → createWebhookSchema (subset the MCP emits).
  createWebhook: z
    .object({
      name: z.string().min(1).max(255),
      url: z.string().url(),
      events: z.array(z.string()).min(1),
      description: z.string().max(1000).optional(),
      method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
      secret: z.string().optional(),
      timeoutMs: z.number().int().min(1000).max(60000).optional(),
      status: z.enum(['active', 'inactive']).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  // cloud/src/routes/webhooks.ts → updateWebhookSchema (all optional subset).
  updateWebhook: z
    .object({
      name: z.string().min(1).max(255).optional(),
      url: z.string().url().optional(),
      events: z.array(z.string()).min(1).optional(),
      description: z.string().max(1000).optional(),
      method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
      secret: z.string().optional(),
      timeoutMs: z.number().int().min(1000).max(60000).optional(),
      status: z.enum(['active', 'inactive', 'suspended']).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  // cloud/src/routes/prompts.ts → promptSchema (see promptItemCloud above).
  upsertPrompt: promptItemCloud,
  bulkUpsertPrompts: z.object({ entities: z.array(promptItemCloud).min(1).max(100) }).strict(),
  // cloud/src/routes/taxonomies.ts → taxonomySchema (see taxonomyItemCloud above).
  upsertTaxonomy: taxonomyItemCloud,
  bulkUpsertTaxonomies: z.object({ entities: z.array(taxonomyItemCloud).min(1).max(100) }).strict(),
  // cloud/src/routes/crawl.ts → startCrawlSchema
  startCrawl: z.object({
    url: z.string().min(1),
    workspaceId: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
    isOnboarding: z.boolean().optional(),
    strategy: z.enum(['full', 'smart']).optional(),
    trigger: z.enum(['manual', 'scheduled']).optional(),
  }),
  // cloud/src/routes/crawl.ts → updateCrawlConfigSchema
  updateCrawlConfig: z.object({
    workspaceId: z.string().optional(),
    strategy: z.enum(['full', 'smart']).optional(),
    schedule: z.enum(['none', 'daily', 'weekly', 'monthly']).optional(),
    preferredHour: z.number().int().min(0).max(23).optional(),
    maxPages: z.number().int().positive().optional(),
    excludePatterns: z.array(z.string()).optional(),
    excludeSelectors: z.array(z.string()).optional(),
    includePatterns: z.array(z.string()).optional(),
    overagesEnabled: z.boolean().optional(),
  }),
  // cloud/src/routes/tenant.ts → createWorkspaceBodySchema.
  // The cloud route's body actually accepts `description` and `source`
  // as well, but they are dropped on the server side — so we model the
  // *effective* contract here (what MCP should emit) and use strict mode
  // to catch the easy regression of re-introducing `platform` /
  // `description` to the MCP inputSchema.
  createWorkspace: z
    .object({
      workspaceId: z
        .string()
        .min(3)
        .max(50)
        .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/),
      name: z.string().optional(),
      siteUrl: z.string().optional(),
    })
    .strict(),
  // cloud/src/routes/tenant.ts → updateWorkspaceBodySchema.
  // Mirrors the cloud's `.refine(name || domain)` constraint as well.
  updateWorkspace: z
    .object({
      name: z.string().min(1).max(200).optional(),
      domain: z.string().min(1).max(255).optional(),
    })
    .strict()
    .refine((v) => v.name !== undefined || v.domain !== undefined, {
      message: 'At least one field (name, domain) must be provided',
    }),
  // cloud/src/routes/products.ts → productSchema (see productItemCloud above).
  upsertProduct: productItemCloud,
  // cloud/src/routes/posts.ts → postSchema (see postItemCloud above).
  upsertPost: postItemCloud,
  // cloud/src/routes/{products,posts}.ts → bulkUpsertSchema { entities }.
  bulkUpsertProducts: z.object({ entities: z.array(productItemCloud).min(1).max(100) }).strict(),
  bulkUpsertPosts: z.object({ entities: z.array(postItemCloud).min(1).max(100) }).strict(),
  // cloud/src/routes/{products,posts}.ts → bulkDeleteSchema.
  bulkDelete: z
    .object({
      ids: z
        .array(z.union([z.string(), z.number()]))
        .min(1)
        .max(100),
    })
    .strict(),
  // cloud/src/routes/{products,posts}.ts → patchSchema.
  patchContent: z.object({ indexStatus: z.enum(['active', 'hidden', 'disabled']).optional() }).strict(),
  // cloud/src/routes/products.ts / posts.ts → searchSchema (both
  // identical on the fields we send). `filters` mirrors the products
  // route's value union — string | number | boolean | string[] | object
  // — so nested operator objects like { price: { gte: 50, lte: 200 } }
  // round-trip through the schema instead of getting filtered out.
  search: z
    .object({
      text: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
      filters: z
        .record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.object({}).passthrough()]),
        )
        .optional(),
    })
    .strict(),
  // cloud/src/routes/chat.ts → chatSchema
  chat: z.object({
    message: z.string().min(1),
    threadId: z.string().min(1),
    stream: z.boolean().optional(),
  }),
  // cloud/src/routes/workspace.ts → updateSettingsSchema (+ liveAgentSettingsSchema,
  // builtinToolsPatchSchema). Strict so a tool leaking an unmodeled field (or
  // `workspaceId`) lights up. builtinTools sub-fields are nullable (null clears).
  updateWorkspaceSettings: z
    .object({
      workspaceDescription: z.string().max(500).optional(),
      specialInstructions: z.string().max(5000).optional(),
      triageProgressMessage: z.string().max(100).optional(),
      composerProgressMessage: z.string().max(100).optional(),
      liveAgent: z
        .object({
          enabled: z.boolean().optional(),
          provider: z.enum(['none', 'slack', 'whatsapp', 'teams']).optional(),
          autoHandoff: z.boolean().optional(),
          manualHandoff: z.boolean().optional(),
          escalationPrompt: z.string().max(1500).optional(),
          inactivityTimeout: z.number().int().min(60).max(3600).optional(),
          contactFormEnabled: z.boolean().optional(),
          businessHours: z.string().max(500).optional(),
        })
        .strict()
        .optional(),
      builtinTools: z
        .object({
          product: builtinDomainToolsCloud.nullable().optional(),
          post: builtinDomainToolsCloud.nullable().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  // cloud/src/routes/workspace.ts → createCustomDomainSchema. Nested
  // mcpServers/apiEndpoints use passthrough to match the MCP tool's
  // "model the identifying fields, let the cloud validate the rest" stance;
  // top-level strict still catches a leaked workspaceId.
  createCustomDomain: z
    .object({
      name: z.string().min(3).max(50),
      classifierPrompt: z.string().min(10).max(500),
      agentPrompt: z.string().min(20).max(20000),
      progressMessage: z.string().min(5).max(100),
      mcpServers: z
        .array(z.object({ name: z.string(), url: z.string(), requiresAuth: z.boolean() }).passthrough())
        .max(5),
      apiEndpoints: z.array(z.object({}).passthrough()).max(3).optional(),
      enabled: z.boolean().optional(),
      toolStrategy: z.enum(['required', 'auto']).optional(),
      maxToolTurns: z.number().int().min(1).max(5).optional(),
      exclusive: z.boolean().optional(),
      composerRenderHint: z.enum(['card', 'inline', 'prose-only', 'gallery']).optional(),
      composerVerbosity: z.enum(['terse', 'standard', 'detailed']).optional(),
      composerPrivacy: z.enum(['public', 'sensitive']).optional(),
      digestTemplate: z.string().optional(),
      composerStreamingFields: z.array(z.string().min(1).max(64)).max(5).optional(),
      toolProgressMessages: z.record(z.string().min(1).max(64), z.string().min(1).max(100)).optional(),
    })
    .strict(),
  // cloud/src/routes/workspace.ts → generateDomainSchema
  generateDomain: z
    .object({
      description: z.string().min(10).max(2000),
      references: z
        .array(
          z.object({
            type: z.enum(['url', 'text']),
            value: z.string().min(1).max(10000),
            label: z.string().max(100).optional(),
          }),
        )
        .max(5)
        .optional(),
    })
    .strict(),
  // cloud/src/routes/workspace.ts → discoverToolsSchema
  discoverTools: z
    .object({
      mcpServers: z
        .array(z.object({ name: z.string(), url: z.string() }))
        .min(1)
        .max(5),
    })
    .strict(),
  // cloud/src/routes/workspace.ts → testCustomDomainSchema
  testConnection: z
    .object({
      domain: z.object({ id: z.string(), name: z.string() }).passthrough(),
      testQueries: z.array(z.string().max(500)).min(1).max(5),
    })
    .strict(),
  // cloud/src/services/chat/agents/schemas/colorSchemeSchemas.ts → ColorSchemeRequest
  colorScheme: z
    .object({
      primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      secondaryColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    })
    .strict(),
  // cloud/src/routes/workspace.ts → chatWidgetConfigSchema (subset; cloud
  // validates the full shape). Passthrough mirrors the tool's passthrough.
  chatWidgetConfig: z
    .object({
      enabled: z.boolean().optional(),
      title: z.string().max(100).optional(),
      cardLayout: z.enum(['carousel', 'stack']).optional(),
      resetToDefaults: z.boolean().optional(),
    })
    .passthrough(),
  // cloud/src/routes/workspace.ts → searchWidgetConfigSchema (subset).
  searchWidgetConfig: z
    .object({
      enabled: z.boolean().optional(),
      resultLayout: z.enum(['stacked', 'tabbed']).optional(),
    })
    .passthrough(),
  // cloud/src/routes/workspace.ts → updateCustomDomainSchema (all optional, but
  // KEEPS the create-time min bounds). Strict top-level catches a leaked
  // workspaceId/domainId; nested objects passthrough like the tool.
  updateCustomDomain: z
    .object({
      name: z.string().min(3).max(50).optional(),
      classifierPrompt: z.string().min(10).max(500).optional(),
      agentPrompt: z.string().min(20).max(20000).optional(),
      progressMessage: z.string().min(5).max(100).optional(),
      mcpServers: z
        .array(z.object({ name: z.string(), url: z.string(), requiresAuth: z.boolean() }).passthrough())
        .max(5)
        .optional(),
      apiEndpoints: z.array(z.object({}).passthrough()).max(3).optional(),
      enabled: z.boolean().optional(),
      toolStrategy: z.enum(['required', 'auto']).optional(),
      maxToolTurns: z.number().int().min(1).max(5).optional(),
      exclusive: z.boolean().optional(),
      composerRenderHint: z.enum(['card', 'inline', 'prose-only', 'gallery']).optional(),
      composerVerbosity: z.enum(['terse', 'standard', 'detailed']).optional(),
      composerPrivacy: z.enum(['public', 'sensitive']).optional(),
      digestTemplate: z.string().optional(),
      composerStreamingFields: z.array(z.string().min(1).max(64)).max(5).optional(),
      toolProgressMessages: z.record(z.string().min(1).max(64), z.string().min(1).max(100)).optional(),
    })
    .strict(),
  // cloud/src/routes/workspace.ts → validateCustomDomainSchema. Intentionally
  // LOOSE (no min bounds) so partial drafts validate; + id + skipLlmValidation.
  validateCustomDomain: z
    .object({
      name: z.string().optional(),
      classifierPrompt: z.string().optional(),
      agentPrompt: z.string().optional(),
      progressMessage: z.string().optional(),
      mcpServers: z
        .array(z.object({ name: z.string(), url: z.string(), requiresAuth: z.boolean() }).passthrough())
        .optional(),
      apiEndpoints: z.array(z.object({}).passthrough()).optional(),
      enabled: z.boolean().optional(),
      toolStrategy: z.enum(['required', 'auto']).optional(),
      maxToolTurns: z.number().int().optional(),
      exclusive: z.boolean().optional(),
      composerRenderHint: z.enum(['card', 'inline', 'prose-only', 'gallery']).optional(),
      composerVerbosity: z.enum(['terse', 'standard', 'detailed']).optional(),
      composerPrivacy: z.enum(['public', 'sensitive']).optional(),
      digestTemplate: z.string().optional(),
      composerStreamingFields: z.array(z.string().min(1).max(64)).max(5).optional(),
      toolProgressMessages: z.record(z.string().min(1).max(64), z.string().min(1).max(100)).optional(),
      id: z.string().optional(),
      skipLlmValidation: z.boolean().optional(),
    })
    .strict(),
};
