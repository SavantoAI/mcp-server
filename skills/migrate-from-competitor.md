---
title: Migrate from another AI chat vendor to Savanto
use: Run when the user is switching from a competitor (e.g. Zendesk AI, Intercom Fin, Tidio AI) and wants to move their KB over.
tools: [list_workspaces, create_workspace, upsert_post, upsert_product, start_crawl, get_crawl_status, chat, get_tenant_usage]
---

# Migrate from another AI chat vendor

Migrations tend to fail not because of data loss but because of un-tested parity — the user switches over on a Monday, a customer asks a common question on Tuesday, the bot hallucinates, trust is gone. This playbook biases heavily toward test coverage before the cutover.

## Step 1 — Identity and scope

Call `whoami`. If `tier` is on a usage-constrained plan, also call `get_tenant_usage` so you know the headroom you're importing into.

## Step 2 — Inventory the source

Ask the user:
1. What's the source vendor?
2. Do they have an export (CSV, JSON) of their KB, or only the live dashboard?
3. How many articles / macros / product-facing snippets are in scope?
4. Are there any categories they specifically want to validate after cutover (shipping, returns, sizing, etc.)?

Ask them to paste 3-5 representative "gold" questions they want the new bot to answer correctly — you'll use these as regression tests in Step 5.

## Step 3 — Create the workspace

Call `create_workspace` with a sensible slug. Set `platform: "custom"` unless they're also on WordPress/Shopify.

## Step 4 — Ingest

Two paths:

**If the user has an export:**
- Walk through each row with them and call `upsert_post` (for articles) or `upsert_product` (for catalog items). Batch requests where possible.
- For large imports (>200 items) ask the user if they'd prefer to use the bulk-upsert REST endpoints directly (`POST /posts/bulk`, `POST /products/bulk`, 100 per request) — that's not exposed as an MCP tool in v1 on purpose.

**If the user only has the live site:**
- Call `start_crawl` and follow the `onboard-wordpress` or `onboard-shopify` skill from Step 4 onward.

## Step 5 — Parity regression

For each gold question the user provided in Step 2:
1. Call `chat` with that exact wording against the new Savanto workspace.
2. Present the response to the user and ask them to grade it (thumbs up / thumbs down / partial).

Document any thumbs-down answers. These drive the post-migration punch list — usually content that didn't carry over or persona tuning.

## Step 6 — Cutover plan

Summarise:
- Total items ingested (call `get_tenant_usage` again and diff).
- Gold-question pass rate.
- Remaining gaps and how to close them.

Recommend a soft cutover: run Savanto on 10-20% of traffic for a week before fully replacing the competitor, then compare CSAT / deflection rates.
