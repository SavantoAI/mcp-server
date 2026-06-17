---
title: Onboard a store end-to-end
use: Run this to stand up a brand-new Savanto workspace from scratch — create it, ingest content, configure behaviour and branding, and smoke-test — in one guided flow.
tools: [list_workspaces, create_workspace, get_crawl_config, update_crawl_config, start_crawl, get_crawl_status, bulk_upsert_products, bulk_upsert_posts, update_workspace_settings, generate_color_scheme, get_chat_widget_config, update_chat_widget_config, chat]
---

# Onboard a store end-to-end

Takes a customer from nothing to a working, branded, smoke-tested assistant. The crawl is the long pole — kick it off, then do configuration/branding while it runs, and verify at the end.

## Step 1 — Create the workspace

`list_workspaces` to check it doesn't already exist, then `create_workspace` (slug + name + site URL).

## Step 2 — Ingest content

Pick the ingestion path with the user:
- **Crawl the site:** `update_crawl_config` to set exclude patterns (drop /tag/, /author/, cart/checkout) and depth, then `start_crawl`. Don't block — poll `get_crawl_status` periodically; continue with config while it runs.
- **Or push a catalog directly:** `bulk_upsert_products` / `bulk_upsert_posts` (up to 100 per call) if the user has the data, instead of (or alongside) a crawl.

## Step 3 — Configure behaviour

`update_workspace_settings`:
- `specialInstructions` — brand voice, key policies, dos/don'ts.
- `liveAgent` — set `manualHandoff` / an `escalationPrompt` if they want human handoff.
- Set `workspaceDescription` so triage classifies queries well.

## Step 4 — Brand the widget

`generate_color_scheme` from the brand's primary hex → review → apply via `update_chat_widget_config` (greeting, title, theme). Read `get_chat_widget_config` first if editing an existing look.

## Step 5 — Smoke-test

Once the crawl reaches a terminal state (`get_crawl_status`), run 3–5 representative questions through `chat` — a product lookup, a policy question, an edge case. Confirm answers cite real content and the tone matches.

## Step 6 — Hand off to refinement

Tell the user the store is live, and that the `audit-and-improve` skill can be run on a cadence to find and fix whatever the assistant still gets wrong.

## Notes

- `create_workspace` / content writes need a tenant-admin secret key; the tools won't appear for a publishable widget key.
- For Shopify/WordPress specifically, the `onboard-shopify` / `onboard-wordpress` skills have platform-specific crawl guidance.
