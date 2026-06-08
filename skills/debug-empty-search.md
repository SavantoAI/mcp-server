---
title: Debug "the chat is not finding X"
use: Run this when a user reports the chat widget doesn't surface a specific product, article, or policy that they know is on their site.
tools: [list_workspaces, search_products, search_posts, chat, get_crawl_history, get_crawl_status]
---

# Debug empty / hallucinated chat results

When a user says "I asked about product X and the chat didn't find it" or "the bot hallucinated an answer it should have pulled from our help center", walk the symptom back to its source.

## Step 1 — Identify the workspace and the missing content

Ask the user:
1. Which workspace is this happening on?
2. What exact query did they type?
3. What content (product name, article title, URL) did they expect to be found?

## Step 2 — Test the retrieval layer directly

Call `search_products` with the user's exact query. Then call `search_posts` with the same query. You're looking at the raw hits, not a generated answer.

- **Hit at rank 1-3**: retrieval is fine. The problem is in the response agent — likely a persona/safety instruction suppressing the answer. Proceed to Step 4.
- **Hit at rank 4-10**: retrieval is working but the answer agent chose a better-ranked match. Consider improving the document (title/description/tags) or re-crawling with the canonical URL.
- **No hit at all**: the content is missing from the index. Jump to Step 3.

## Step 3 — Check indexing

If the content is missing:

1. Call `get_crawl_history` for the workspace. When did the last crawl run? Did it complete?
2. If the content was added AFTER the last completed crawl, the user needs to re-crawl — tell them.
3. If a crawl ran but the content is still missing, the URL was likely skipped by an exclude pattern or by a listing-page classifier. Call `get_crawl_config` and ask the user to share the URL of the missing content — compare against the patterns.
4. For stubborn cases, point the user at the `scrapePage` endpoint (not exposed as an MCP tool in v1 — we recommend surgical page-level scrape via the dashboard instead).

## Step 4 — Compare against chat

Call `chat` with the user's query. Compare the answer to the search results you got in Step 2. The delta is almost always one of:

- Special-instructions over-filtering ("don't mention prices" → product results get suppressed).
- The answer agent prefers a higher-authority source it found (often a post over a product).
- Multi-turn context from the chat thread — but you're in a single-turn here, so rule this out.

## Step 5 — Report

Summarise for the user: where the gap is (retrieval vs. ranking vs. response), and what they should change next (tweak crawl config, re-crawl, edit content, or adjust chat persona).
