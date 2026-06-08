---
title: Onboard a WordPress / WooCommerce site
use: Run this when the user wants to set up Savanto for a WordPress or WooCommerce site.
tools: [list_workspaces, create_workspace, update_crawl_config, start_crawl, get_crawl_status, chat, whoami]
---

# Onboard a WordPress / WooCommerce site

You are helping set up Savanto AI for a WordPress (or WooCommerce) site. Follow this playbook end-to-end. Do not skip the verification step — an un-tested workspace is worse than no workspace.

## Step 1 — Confirm identity

Call `whoami` and report the tenant ID and tier back to the user. If the `keyType` is not `secret`, stop and ask the user to supply a secret key.

## Step 2 — Check for an existing workspace

Call `list_workspaces`. If one already exists for this site (match by `domain` or workspace slug), ask the user whether they want to reuse it, update it, or create a new one.

## Step 3 — Create the workspace

If needed, call `create_workspace` with:
- `workspaceId`: derived from the site URL (e.g. `example-com` for `https://example.com`). Ask the user to confirm.
- `platform`: `"wordpress"`.
- `siteUrl`: the full URL including scheme.
- `name`: human-readable brand name.

## Step 4 — Configure crawl before running it

Call `get_crawl_config`. If the config is default (no exclude patterns), call `update_crawl_config` with a WordPress-flavoured exclude list:

```
["**/tag/**", "**/author/**", "**/page/*/", "**/wp-admin/**", "**/wp-login.php", "**/feed/**", "**/?**"]
```

If the site has a sitemap at `/sitemap.xml`, also set `sitemapUrl`.

## Step 5 — Start the crawl

Call `start_crawl` with `strategy: "smart"` (unless the user explicitly asks for a full re-index). Record the returned `crawlId`.

**Do not block.** Immediately tell the user the crawl has started, share the `crawlId`, and inform them it typically takes 5-60 minutes.

## Step 6 — Poll for completion

Call `get_crawl_status` every 20-30 seconds. When `status` is `completed`, proceed. If `failed` or `cancelled`, report the error and stop. If it is still `running` after ~10 minutes, offer to poll again later — don't hammer the endpoint.

## Step 7 — Verify by asking a real question

Ask the user for one or two representative customer questions their site should answer. Send each via the `chat` tool. Summarize the responses back, and flag any answers that look hallucinated or off-topic — those usually indicate missing KB coverage (see the `debug-empty-search` skill).

## Step 8 — Report

Summarize: workspace ID, pagesIndexed, elapsed crawl time, sample chat responses, and next recommended action (e.g. "install the widget", "tune chat persona").
