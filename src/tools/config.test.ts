import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../utils/fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fetch.js')>('../utils/fetch.js');
  return { ...actual, request: hoisted.request };
});

import { CLOUD_SCHEMAS } from './cloudSchemas.fixture.js';
import { registerConfigTools } from './config.js';
import { createRequestProbe, ctxFor, makeServer } from './testHarness.js';

const { lastRequestBody, lastRequestPath } = createRequestProbe(hoisted.request);

beforeEach(() => {
  hoisted.request.mockReset();
  hoisted.request.mockResolvedValue({});
});

describe('registerConfigTools', () => {
  it('registers all config tools for a key with config:admin', () => {
    const { server, names } = makeServer();
    // Config tools gate on config:admin (the scope ADMIN_CONFIG routes require),
    // not tenant:admin (which gates the workspace-lifecycle tools).
    expect(registerConfigTools(server, ctxFor(['config:admin']))).toBe(14);
    expect(names().sort()).toEqual(
      [
        'create_custom_domain',
        'delete_custom_domain',
        'discover_tools',
        'generate_color_scheme',
        'generate_domain_config',
        'get_chat_widget_config',
        'get_search_widget_config',
        'list_custom_domains',
        'test_domain_connection',
        'update_chat_widget_config',
        'update_custom_domain',
        'update_search_widget_config',
        'update_workspace_settings',
        'validate_custom_domain',
      ].sort(),
    );
  });

  it('registers NO config tools for a tenant:admin-only key (config routes need config:admin)', () => {
    const { server } = makeServer();
    expect(registerConfigTools(server, ctxFor(['tenant:admin']))).toBe(0);
  });

  it('registers NONE of the config tools for a publishable widget key', () => {
    const { server } = makeServer();
    expect(registerConfigTools(server, ctxFor(['chat', 'search:products'], 'publishable'))).toBe(0);
  });

  it('PATCHes /workspace/:id/settings, strips workspaceId from the body, and round-trips the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('update_workspace_settings')?.call({
      workspaceId: 'acme',
      specialInstructions: 'We close on public holidays.',
      liveAgent: { manualHandoff: true, escalationPrompt: 'Escalate refunds over $500.' },
    });
    expect(lastRequestPath()).toBe('/workspace/acme/settings');
    const [, init] = hoisted.request.mock.calls.at(-1) ?? [];
    expect((init as { method?: string }).method).toBe('PATCH');
    const body = lastRequestBody();
    expect(body.workspaceId).toBeUndefined();
    expect(body).toEqual({
      specialInstructions: 'We close on public holidays.',
      liveAgent: { manualHandoff: true, escalationPrompt: 'Escalate refunds over $500.' },
    });
    expect(() => CLOUD_SCHEMAS.updateWorkspaceSettings.parse(body)).not.toThrow();
  });

  it('rejects an update with no settings fields (avoids a no-op PATCH)', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    // The registration wrapper turns a thrown SavantoApiError into an MCP
    // error result (isError) rather than a rejection — assert on that, and
    // that no network call was made.
    const result = (await byName('update_workspace_settings')?.call({ workspaceId: 'acme' })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(hoisted.request).not.toHaveBeenCalled();
  });

  it('update_workspace_settings passes builtinTools through (incl. null to clear) and round-trips', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('update_workspace_settings')?.call({
      workspaceId: 'acme',
      builtinTools: {
        product: { usageHints: 'Call inventory for stock.', maxTurns: 3 },
        post: null, // clear post-domain tools
      },
    });
    const body = lastRequestBody();
    expect(body.workspaceId).toBeUndefined();
    expect(body.builtinTools).toEqual({
      product: { usageHints: 'Call inventory for stock.', maxTurns: 3 },
      post: null,
    });
    expect(() => CLOUD_SCHEMAS.updateWorkspaceSettings.parse(body)).not.toThrow();
  });

  // ── custom domains ──

  it('list_custom_domains GETs /workspace/:id/custom-domain', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('list_custom_domains')?.call({ workspaceId: 'acme' });
    expect(lastRequestPath()).toBe('/workspace/acme/custom-domain');
  });

  it('discover_tools POSTs /discover-tools and round-trips the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('discover_tools')?.call({
      workspaceId: 'acme',
      mcpServers: [{ name: 'orders', url: 'https://mcp.acme.test/orders' }],
    });
    expect(lastRequestPath()).toBe('/workspace/acme/discover-tools');
    const body = lastRequestBody();
    expect(body.workspaceId).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.discoverTools.parse(body)).not.toThrow();
  });

  it('generate_domain_config POSTs /custom-domain/generate, strips workspaceId, round-trips schema', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('generate_domain_config')?.call({
      workspaceId: 'acme',
      description: 'Look up order status and tracking from our Shopify store.',
    });
    expect(lastRequestPath()).toBe('/workspace/acme/custom-domain/generate');
    const body = lastRequestBody();
    expect(body.workspaceId).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.generateDomain.parse(body)).not.toThrow();
  });

  it('validate_custom_domain POSTs /custom-domain/validate', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('validate_custom_domain')?.call({
      workspaceId: 'acme',
      name: 'Order Tracking',
      classifierPrompt: 'User asks about their order status or delivery tracking.',
      agentPrompt: 'You help customers track their orders using the connected tools.',
    });
    expect(lastRequestPath()).toBe('/workspace/acme/custom-domain/validate');
    const body = lastRequestBody();
    expect(body.workspaceId).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.validateCustomDomain.parse(body)).not.toThrow();
  });

  it('validate_custom_domain accepts a PARTIAL draft below create-time min lengths', async () => {
    // The whole point of validate-before-write: a short/incomplete draft must
    // reach the API (which returns quality feedback), not be rejected client-side.
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    const result = (await byName('validate_custom_domain')?.call({
      workspaceId: 'acme',
      classifierPrompt: 'orders', // 6 chars — below create's min(10)
      id: 'order-tracking',
      skipLlmValidation: true,
    })) as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(lastRequestPath()).toBe('/workspace/acme/custom-domain/validate');
    const body = lastRequestBody();
    expect(body).toEqual({ classifierPrompt: 'orders', id: 'order-tracking', skipLlmValidation: true });
    expect(() => CLOUD_SCHEMAS.validateCustomDomain.parse(body)).not.toThrow();
  });

  it('create_custom_domain POSTs /custom-domain and round-trips the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('create_custom_domain')?.call({
      workspaceId: 'acme',
      name: 'Order Tracking',
      classifierPrompt: 'User asks about their order status or delivery tracking.',
      agentPrompt: 'You help customers track their orders using the connected tools.',
      progressMessage: 'Looking up your order…',
      mcpServers: [{ name: 'orders', url: 'https://mcp.acme.test/orders', requiresAuth: false }],
    });
    expect(lastRequestPath()).toBe('/workspace/acme/custom-domain');
    const body = lastRequestBody();
    expect(body.workspaceId).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.createCustomDomain.parse(body)).not.toThrow();
  });

  it('create_custom_domain passes composerStreamingFields + toolProgressMessages through (not stripped)', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('create_custom_domain')?.call({
      workspaceId: 'acme',
      name: 'Order Tracking',
      classifierPrompt: 'User asks about their order status or delivery tracking.',
      agentPrompt: 'You help customers track their orders using the connected tools.',
      progressMessage: 'Looking up your order…',
      mcpServers: [{ name: 'orders', url: 'https://mcp.acme.test/orders', requiresAuth: false }],
      composerStreamingFields: ['summary'],
      toolProgressMessages: { lookup_order: 'Checking your order…' },
    });
    const body = lastRequestBody();
    expect(body.composerStreamingFields).toEqual(['summary']);
    expect(body.toolProgressMessages).toEqual({ lookup_order: 'Checking your order…' });
    expect(() => CLOUD_SCHEMAS.createCustomDomain.parse(body)).not.toThrow();
  });

  it('update_custom_domain PUTs /custom-domain/:domainId, strips path params, rejects empty', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('update_custom_domain')?.call({ workspaceId: 'acme', domainId: 'order-tracking', enabled: true });
    expect(lastRequestPath()).toBe('/workspace/acme/custom-domain/order-tracking');
    const body = lastRequestBody();
    expect(body.workspaceId).toBeUndefined();
    expect(body.domainId).toBeUndefined();
    expect(body).toEqual({ enabled: true });
    expect(() => CLOUD_SCHEMAS.updateCustomDomain.parse(body)).not.toThrow();

    // empty update → client-side error result, no network call
    hoisted.request.mockClear();
    const result = (await byName('update_custom_domain')?.call({
      workspaceId: 'acme',
      domainId: 'order-tracking',
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(hoisted.request).not.toHaveBeenCalled();
  });

  it('delete_custom_domain requires confirm:true and DELETEs the domain path', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    // missing confirm → zod parse rejects before any handler/network call
    await expect(byName('delete_custom_domain')?.call({ workspaceId: 'acme', domainId: 'd1' })).rejects.toThrow();
    expect(hoisted.request).not.toHaveBeenCalled();

    await byName('delete_custom_domain')?.call({ workspaceId: 'acme', domainId: 'd1', confirm: true });
    expect(lastRequestPath()).toBe('/workspace/acme/custom-domain/d1');
    const [, init] = hoisted.request.mock.calls.at(-1) ?? [];
    expect((init as { method?: string }).method).toBe('DELETE');
  });

  it('test_domain_connection POSTs /test-connection and round-trips the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('test_domain_connection')?.call({
      workspaceId: 'acme',
      domain: {
        id: 'draft',
        name: 'Order Tracking',
        classifierPrompt: 'User asks about their order status or delivery tracking.',
        agentPrompt: 'You help customers track their orders using the connected tools.',
        progressMessage: 'Looking up your order…',
        mcpServers: [{ name: 'orders', url: 'https://mcp.acme.test/orders', requiresAuth: false }],
      },
      testQueries: ['where is my order #123?'],
    });
    expect(lastRequestPath()).toBe('/workspace/acme/test-connection');
    const body = lastRequestBody();
    expect(body.workspaceId).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.testConnection.parse(body)).not.toThrow();
  });

  it('test_domain_connection accepts a partial DRAFT (below create-time min lengths)', async () => {
    // Parity with validate: a draft that passes validate_custom_domain must also
    // pass test_domain_connection — cloud's testCustomDomainSchema uses plain
    // strings, so the tool must not re-impose create-time min bounds.
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    const result = (await byName('test_domain_connection')?.call({
      workspaceId: 'acme',
      domain: {
        id: 'draft',
        name: 'OT', // < create min(3)
        classifierPrompt: 'orders', // < create min(10)
        agentPrompt: 'help', // < create min(20)
        progressMessage: 'hi', // < create min(5)
        mcpServers: [],
      },
      testQueries: ['where is my order?'],
    })) as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(lastRequestPath()).toBe('/workspace/acme/test-connection');
    expect(() => CLOUD_SCHEMAS.testConnection.parse(lastRequestBody())).not.toThrow();
  });

  // ── branding & widgets ──

  it('generate_color_scheme POSTs /config/color-scheme and round-trips the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('generate_color_scheme')?.call({ primaryColor: '#0084ff', secondaryColor: '#22c55e' });
    expect(lastRequestPath()).toBe('/config/color-scheme');
    expect(() => CLOUD_SCHEMAS.colorScheme.parse(lastRequestBody())).not.toThrow();
  });

  it('generate_color_scheme rejects a non-hex color', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await expect(byName('generate_color_scheme')?.call({ primaryColor: 'blue' })).rejects.toThrow();
  });

  it('get_chat_widget_config GETs /workspace/:id/chat', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('get_chat_widget_config')?.call({ workspaceId: 'acme' });
    expect(lastRequestPath()).toBe('/workspace/acme/chat');
  });

  it('update_chat_widget_config POSTs the config object (unwrapped) to /workspace/:id/chat', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    // `theme` is not an advertised field — passthrough must let it reach the cloud.
    await byName('update_chat_widget_config')?.call({
      workspaceId: 'acme',
      config: { title: 'Help', cardLayout: 'stack', theme: { primary: '#0084ff' } },
    });
    expect(lastRequestPath()).toBe('/workspace/acme/chat');
    const body = lastRequestBody();
    expect(body.workspaceId).toBeUndefined();
    expect(body).toEqual({ title: 'Help', cardLayout: 'stack', theme: { primary: '#0084ff' } });
    expect(() => CLOUD_SCHEMAS.chatWidgetConfig.parse(body)).not.toThrow();
  });

  it('get_search_widget_config GETs /workspace/:id/search', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('get_search_widget_config')?.call({ workspaceId: 'acme' });
    expect(lastRequestPath()).toBe('/workspace/acme/search');
  });

  it('update_search_widget_config POSTs the config object (unwrapped) to /workspace/:id/search', async () => {
    const { server, byName } = makeServer();
    registerConfigTools(server, ctxFor(['*']));
    await byName('update_search_widget_config')?.call({
      workspaceId: 'acme',
      config: { resultLayout: 'tabbed', searchPosts: false },
    });
    expect(lastRequestPath()).toBe('/workspace/acme/search');
    const body = lastRequestBody();
    expect(body.workspaceId).toBeUndefined();
    expect(body).toEqual({ resultLayout: 'tabbed', searchPosts: false });
    expect(() => CLOUD_SCHEMAS.searchWidgetConfig.parse(body)).not.toThrow();
  });
});

// ── Taxonomies ───────────────────────────────────────────────────────
