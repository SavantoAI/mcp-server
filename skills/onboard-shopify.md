---
title: Onboard a Shopify store
use: Run this when the user wants to set up Savanto for a Shopify store (via crawl-based ingestion — not the Shopify app).
tools: [list_workspaces, create_workspace, update_crawl_config, start_crawl, get_crawl_status, chat, whoami]
---

# Onboard a Shopify store (crawl-based)

Use this when the merchant does NOT want to install the Savanto Shopify app and instead wants Savanto to crawl their storefront. If they can install the app, prefer that — this skill is the crawl-only fallback.

## Step 1 — Identity

Call `whoami`. Confirm `keyType === 'secret'`.

## Step 2 — Existing workspace check

Call `list_workspaces`. If the merchant already has a workspace, reuse it unless they ask otherwise.

## Step 3 — Create the workspace

Call `create_workspace`:
- `workspaceId`: the shop subdomain (e.g. `acme-store` for `acme-store.myshopify.com`).
- `platform`: `"shopify"`.
- `siteUrl`: the full public storefront URL (custom domain if set, otherwise `.myshopify.com`).

## Step 4 — Shopify-specific crawl config

Call `update_crawl_config` with exclude patterns that skip Shopify's internal URLs and infinite-pagination noise:

```
["**/account/**", "**/cart/**", "**/checkout/**", "**/search?*", "**/?page=*", "**/products/*/reviews", "**/apps/**"]
```

Set `sitemapUrl` to `<storeUrl>/sitemap_products_1.xml` and `<storeUrl>/sitemap_pages_1.xml` if the storefront exposes them.

## Step 5 — Start the crawl and poll

Same pattern as the WordPress skill: `start_crawl` with `strategy: "smart"`, capture `crawlId`, tell the user the crawl has started, and poll `get_crawl_status` every 20-30 seconds.

Large Shopify stores (10k+ products) can take 1-2 hours; don't block the user.

## Step 6 — Verify

Send 2-3 product-intent chat queries ("do you have blue running shoes", "what's your return policy") via the `chat` tool. If product questions hit, the product index is working. If policy questions hit, the content index is working. Gaps usually mean the crawler's exclude patterns need tightening.

## Step 7 — Next steps

Tell the user:
- Widget install: paste the chat widget `<script>` tag into their theme's `theme.liquid` before `</body>`.
- Ongoing sync: the crawl schedule in `update_crawl_config` determines how often content re-syncs. Default is daily.
- If they later install the Savanto Shopify app, it will take over product sync automatically.
