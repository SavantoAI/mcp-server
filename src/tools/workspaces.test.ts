import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../utils/fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fetch.js')>('../utils/fetch.js');
  return { ...actual, request: hoisted.request };
});

import { CLOUD_SCHEMAS } from './cloudSchemas.fixture.js';
import { CLIENT, createRequestProbe, ctxFor, makeServer } from './testHarness.js';
import { registerWorkspaceTools } from './workspaces.js';

const { lastRequestBody, lastRequestPath } = createRequestProbe(hoisted.request);

beforeEach(() => {
  hoisted.request.mockReset();
  hoisted.request.mockResolvedValue({});
});

describe('registerWorkspaceTools', () => {
  it('registers all five workspace tools for an admin key', () => {
    const { server, names } = makeServer();
    // Lifecycle tools gate on tenant:admin; get_workspace_settings reads
    // /workspace/{id}/details which requires config:admin — so a full admin key
    // carries both.
    const count = registerWorkspaceTools(server, ctxFor(['tenant:admin', 'config:admin']));
    expect(count).toBe(5);
    expect(names().sort()).toEqual(
      ['create_workspace', 'delete_workspace', 'get_workspace_settings', 'list_workspaces', 'update_workspace'].sort(),
    );
  });

  it('get_workspace_settings gates on config:admin, not tenant:admin', () => {
    const { names } = (() => {
      const s = makeServer();
      registerWorkspaceTools(s.server, ctxFor(['tenant:admin']));
      return s;
    })();
    // tenant:admin alone gets the 4 lifecycle tools but NOT get_workspace_settings.
    expect(names()).not.toContain('get_workspace_settings');
    expect(names()).toContain('list_workspaces');
  });

  it('registers NONE of the workspace tools for a publishable widget key', () => {
    const { server } = makeServer();
    expect(registerWorkspaceTools(server, ctxFor(['chat', 'search:products'], 'publishable'))).toBe(0);
  });

  it('create_workspace POSTs to /tenant/workspaces and round-trips against the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    await byName('create_workspace')?.call({ workspaceId: 'acme', name: 'Acme Inc.', siteUrl: 'https://acme.test' });
    expect(hoisted.request).toHaveBeenCalledWith(CLIENT, {
      method: 'POST',
      path: '/tenant/workspaces',
      body: { workspaceId: 'acme', name: 'Acme Inc.', siteUrl: 'https://acme.test' },
    });
    expect(() => CLOUD_SCHEMAS.createWorkspace.parse(lastRequestBody())).not.toThrow();
  });

  it('create_workspace strips `platform` / `description` from the outgoing body', async () => {
    // Regression for the audit finding: the previous inputSchema
    // advertised `platform` and `description`, but the cloud route
    // ignored both (hardcoding `platform: 'wordpress'` and never
    // reading `description`). The fix is to drop those keys from the
    // inputSchema — Zod's default behaviour then strips them on parse,
    // so even if an agent still passes them, the cloud never sees them.
    // We assert on the OUTGOING body (what the cloud receives) since
    // that is the contract worth pinning.
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    await byName('create_workspace')?.call({
      workspaceId: 'acme',
      name: 'Acme',
      platform: 'shopify',
      description: 'My store',
    });
    const body = lastRequestBody();
    expect(body.platform).toBeUndefined();
    expect(body.description).toBeUndefined();
    expect(body).toEqual({ workspaceId: 'acme', name: 'Acme' });
    expect(() => CLOUD_SCHEMAS.createWorkspace.parse(body)).not.toThrow();
  });

  it('create_workspace rejects invalid slugs (enforces slug regex for NEW workspaces)', async () => {
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    // Contains capital letters and a space — disallowed for new workspaces.
    await expect(byName('create_workspace')?.call({ workspaceId: 'Acme Store' })).rejects.toThrow();
  });

  it('update_workspace PUTs to /tenant/workspaces/:id and round-trips against the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    await byName('update_workspace')?.call({ workspaceId: 'acme', name: 'Acme v2' });
    expect(lastRequestPath()).toBe('/tenant/workspaces/acme');
    expect(lastRequestBody()).toEqual({ name: 'Acme v2' });
    expect(() => CLOUD_SCHEMAS.updateWorkspace.parse(lastRequestBody())).not.toThrow();
  });

  it('update_workspace strips `platform` from the outgoing body', async () => {
    // The old MCP schema accepted `platform`; the cloud's
    // updateWorkspaceBodySchema does not, so the field was silently
    // dropped server-side. Dropping it from the inputSchema means Zod
    // strips it client-side instead — same end-state, but now the
    // contract is enforced at the boundary where the agent can see it.
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    await byName('update_workspace')?.call({ workspaceId: 'acme', name: 'Acme v2', platform: 'shopify' });
    const body = lastRequestBody();
    expect(body.platform).toBeUndefined();
    expect(body).toEqual({ name: 'Acme v2' });
    expect(() => CLOUD_SCHEMAS.updateWorkspace.parse(body)).not.toThrow();
  });

  it('update_workspace requires at least one of name/domain (mirrors the cloud .refine())', async () => {
    // The handler throws SavantoApiError, which maybeRegisterTool
    // converts into a structured `isError: true` envelope (rather than
    // letting it propagate as a JS exception) — that's the same shape
    // every other API failure surfaces with, so we assert on it
    // directly. The key guarantee is that no network call happens.
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    const result = (await byName('update_workspace')?.call({ workspaceId: 'acme' })) as {
      isError?: boolean;
      structuredContent?: { error?: { status?: number; code?: string; message?: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
      message: expect.stringMatching(/at least one field/i),
    });
    expect(hoisted.request).not.toHaveBeenCalled();
  });

  it('get_workspace_settings accepts loose workspace ids and URL-encodes them', async () => {
    // Historical workspaces may have IDs that contain spaces or capitals.
    // The tool schema is intentionally permissive for READ paths; strict
    // validation happens only at create time.
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    await byName('get_workspace_settings')?.call({ workspaceId: 'acme store' });
    expect(lastRequestPath()).toBe('/workspace/acme%20store/details');
  });
});

// ── Crawl ────────────────────────────────────────────────────────────
