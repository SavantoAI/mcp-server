import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { maybeRegisterTool, type ToolContext } from './context.js';
import { SavantoApiError, type SavantoClient } from './utils/fetch.js';
import type { Whoami } from './whoami.js';

const CLIENT: SavantoClient = { baseUrl: 'http://localhost:3001', apiKey: 'if_sk_test' };

function makeServer() {
  return { registerTool: vi.fn() } as unknown as Parameters<typeof maybeRegisterTool>[0];
}

function ctxFor(who: Partial<Whoami>): ToolContext {
  return {
    client: CLIENT,
    who: {
      tenantId: 't-1',
      tier: 'pro',
      apiKeyId: 'k-1',
      keyType: 'secret',
      scopes: [],
      ...who,
    },
  };
}

describe('maybeRegisterTool', () => {
  it('registers the tool and returns true when the caller has the scope', () => {
    const server = makeServer();
    const registered = maybeRegisterTool(server, ctxFor({ scopes: ['tenant:admin'] }), {
      name: 'list_workspaces',
      description: 'List every workspace.',
      scope: 'tenant:admin',
      inputSchema: {},
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    expect(registered).toBe(true);
    expect(server.registerTool).toHaveBeenCalledOnce();
    // First positional arg is the tool name, then the metadata object,
    // then the wrapped handler — lock this shape so future MCP SDK
    // upgrades don't silently flip positional args.
    const [name, meta, handler] = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(name).toBe('list_workspaces');
    expect(meta.description).toBe('List every workspace.');
    expect(typeof handler).toBe('function');
  });

  it('does NOT register the tool and returns false when the scope is missing', () => {
    const server = makeServer();
    const registered = maybeRegisterTool(server, ctxFor({ scopes: ['chat'] }), {
      name: 'delete_workspace',
      description: 'Delete a workspace.',
      scope: 'tenant:admin',
      inputSchema: {},
      handler: async () => ({ content: [] }),
    });
    expect(registered).toBe(false);
    expect(server.registerTool).not.toHaveBeenCalled();
  });

  it('array scope uses OR — registers if the key has ANY one of the listed scopes', () => {
    // A key with only admin:prompts should still get a tool gated on
    // ['prompts:read', 'admin:prompts'] (mirrors cloud's read-OR-admin routes).
    const server = makeServer();
    const registered = maybeRegisterTool(server, ctxFor({ scopes: ['admin:prompts'] }), {
      name: 'list_prompts',
      description: 'List prompts.',
      scope: ['prompts:read', 'admin:prompts'],
      inputSchema: {},
      handler: async () => ({ content: [] }),
    });
    expect(registered).toBe(true);
    expect(server.registerTool).toHaveBeenCalledOnce();
  });

  it('an empty scope array fails closed (never registers, even for a wildcard key)', () => {
    const server = makeServer();
    const registered = maybeRegisterTool(server, ctxFor({ scopes: ['*'] }), {
      name: 'oops',
      description: 'A tool with a mistaken empty scope array.',
      scope: [],
      inputSchema: {},
      handler: async () => ({ content: [] }),
    });
    expect(registered).toBe(false);
    expect(server.registerTool).not.toHaveBeenCalled();
  });

  it('array scope returns false when the key has NONE of the listed scopes', () => {
    const server = makeServer();
    const registered = maybeRegisterTool(server, ctxFor({ scopes: ['chat'] }), {
      name: 'list_prompts',
      description: 'List prompts.',
      scope: ['prompts:read', 'admin:prompts'],
      inputSchema: {},
      handler: async () => ({ content: [] }),
    });
    expect(registered).toBe(false);
    expect(server.registerTool).not.toHaveBeenCalled();
  });

  it('treats a secret key with an empty scope list as having all scopes (wildcard)', () => {
    const server = makeServer();
    const registered = maybeRegisterTool(server, ctxFor({ keyType: 'secret', scopes: [] }), {
      name: 'legacy',
      description: 'Legacy key compat.',
      scope: 'admin:posts',
      inputSchema: {},
      handler: async () => ({ content: [] }),
    });
    expect(registered).toBe(true);
  });

  it('registers tools with NO scope requirement for any authenticated key', () => {
    const server = makeServer();
    const registered = maybeRegisterTool(server, ctxFor({ keyType: 'publishable', scopes: [] }), {
      name: 'whoami',
      description: 'Identity probe.',
      inputSchema: {},
      handler: async () => ({ content: [] }),
    });
    expect(registered).toBe(true);
  });

  it('catches SavantoApiError thrown by the handler and returns a structured MCP error', async () => {
    const server = makeServer();
    maybeRegisterTool(server, ctxFor({ scopes: ['*'] }), {
      name: 'flaky',
      description: 'Always fails.',
      scope: 'tenant:admin',
      inputSchema: { x: z.string() },
      handler: async () => {
        throw new SavantoApiError({ status: 404, message: 'Not found', code: 'NOT_FOUND' });
      },
    });
    // Pull out the wrapped handler and invoke it directly — the SDK
    // would do this when an agent calls the tool.
    const handler = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][2] as (
      args: unknown,
    ) => Promise<{ isError?: boolean; content: unknown[] }>;
    const result = await handler({ x: 'anything' });
    expect(result.isError).toBe(true);
  });

  it('re-throws unexpected errors so MCP reports them as internal errors', async () => {
    const server = makeServer();
    maybeRegisterTool(server, ctxFor({ scopes: ['*'] }), {
      name: 'buggy',
      description: 'Bug.',
      inputSchema: {},
      handler: async () => {
        throw new TypeError('regression');
      },
    });
    const handler = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][2] as (
      args: unknown,
    ) => Promise<unknown>;
    await expect(handler({})).rejects.toThrow(TypeError);
  });
});

describe('maybeRegisterTool annotations', () => {
  function annotationsFor(name: string, overrides: Record<string, unknown> = {}) {
    const server = makeServer();
    maybeRegisterTool(server, ctxFor({ scopes: ['*'] }), {
      name,
      description: 'x',
      inputSchema: {},
      handler: async () => ({ content: [] }),
      ...overrides,
    });
    return (server.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][1].annotations as {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
    };
  }

  it('derives readOnlyHint from get_/list_/search_/whoami names', () => {
    expect(annotationsFor('get_product').readOnlyHint).toBe(true);
    expect(annotationsFor('list_products').readOnlyHint).toBe(true);
    expect(annotationsFor('search_threads').readOnlyHint).toBe(true);
    expect(annotationsFor('whoami').readOnlyHint).toBe(true);
    expect(annotationsFor('upsert_product').readOnlyHint).toBe(false);
  });

  it('derives destructiveHint + idempotentHint for delete tools', () => {
    const del = annotationsFor('delete_product');
    expect(del.destructiveHint).toBe(true);
    expect(del.idempotentHint).toBe(true);
    const bulk = annotationsFor('bulk_delete_threads');
    expect(bulk.destructiveHint).toBe(true);
  });

  it('marks upsert/update/patch idempotent but create non-idempotent', () => {
    expect(annotationsFor('upsert_post').idempotentHint).toBe(true);
    expect(annotationsFor('update_webhook').idempotentHint).toBe(true);
    expect(annotationsFor('create_workspace').idempotentHint).toBe(false);
    expect(annotationsFor('create_workspace').destructiveHint).toBe(false);
  });

  it('honors an explicit readOnly override for no-persist POST tools', () => {
    // e.g. generate_domain_config POSTs but never mutates state.
    expect(annotationsFor('generate_domain_config', { readOnly: true }).readOnlyHint).toBe(true);
    expect(annotationsFor('generate_domain_config').readOnlyHint).toBe(false); // without override
  });
});
