---
title: Audit and improve a workspace
use: Run this when the user wants to find what their AI assistant is getting wrong and fix it — "why is the bot underperforming", "improve our answers", "what are we missing".
tools: [list_workspaces, get_chat_analytics, get_search_analytics, search_search_logs, list_feedback, search_threads, get_thread_messages, get_thread_analytics, upsert_post, upsert_product, list_prompts, upsert_prompt, generate_domain_config, validate_custom_domain, create_custom_domain, update_workspace_settings, chat]
---

# Audit and improve a workspace

This is the **observe → diagnose → refine → verify** loop. The goal is to turn raw signals (failing chats, zero-result searches, thumbs-down) into concrete fixes, then prove the fix worked. Work one root cause at a time and confirm with the user before any change that affects live behaviour.

## Step 1 — Select the workspace

`list_workspaces`, confirm the target.

## Step 2 — Observe: where is it weak?

Pull the high-signal reads (read-only — safe to run freely):
- `get_chat_analytics` / `get_search_analytics` — volume, resolution, zero-result rate.
- `search_search_logs { zeroResultsOnly: true }` — exactly which visitor searches returned nothing. **These are content gaps.**
- `list_feedback { rating: "negative" }` — answers users marked unhelpful.
- `search_threads { hasUnresolvedQueries: true }` — conversations the assistant couldn't resolve.

Summarize the top 3–5 problem clusters back to the user.

## Step 3 — Diagnose: read the actual failures

For the worst clusters, `get_thread_messages` on a few representative threads to see *how* it failed. Classify each:
- **Missing content** — the answer isn't in the KB (no product/post covers it).
- **Missing capability** — it needs live data/an action (order status, stock) → a custom domain.
- **Wrong behaviour** — tone, over-refusal, missing upsell, bad routing → special instructions or a prompt.

## Step 4 — Refine: apply the matching fix

- Missing content → `upsert_product` / `upsert_post` (or bulk) to add what's missing.
- Missing capability → `generate_domain_config` → `validate_custom_domain` → `create_custom_domain` (see the configure-custom-domain skill). Create disabled, test, then enable.
- Wrong behaviour → `update_workspace_settings { specialInstructions }`, or add/adjust a suggestion with `upsert_prompt`.

Make one change at a time.

## Step 5 — Verify

Re-run the failing queries through `chat` and confirm the answer is now right. After a day of traffic, re-check `get_chat_analytics` / the zero-result list to confirm the metric moved. Report before/after to the user.

## Notes

- Steps 2–3 are entirely read-only — run them liberally to build a picture before proposing changes.
- This pairs with `onboard-store-end-to-end` (which gets a store live) — run audit-and-improve on a cadence afterward to keep it sharp.
