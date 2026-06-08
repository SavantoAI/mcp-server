/**
 * Skills = opinionated multi-step playbooks we ship with the MCP server.
 *
 * Each skill is a markdown file in `../skills/*.md` with YAML-ish
 * frontmatter describing title and one-line use. We surface them as MCP
 * "prompts" so clients that implement prompt discovery (Claude Desktop,
 * Cursor, Claude Code) can suggest them to the user by name:
 *
 *     /mcp savanto-mcp onboard-wordpress
 *
 * An agent invoked via a skill gets a more directed prompt than the
 * generic "do whatever the user asks". That makes provisioning flows
 * converge faster and reduces the number of tool calls per successful
 * onboard.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface SkillDefinition {
  id: string;
  title: string;
  description: string;
  /** Filename (relative to skills dir) holding the full markdown body. */
  file: string;
}

/**
 * Curated skill set for v1. Keep this list short — every skill we ship
 * is a promise to maintain; five is enough to cover the most common
 * provisioning paths without diluting the catalog.
 */
const SKILLS: SkillDefinition[] = [
  {
    id: 'onboard-wordpress',
    title: 'Onboard WordPress site',
    description:
      'End-to-end playbook for standing up a Savanto workspace for a WordPress / WooCommerce site: create workspace, configure crawl, start first crawl, and smoke-test chat.',
    file: 'onboard-wordpress.md',
  },
  {
    id: 'onboard-shopify',
    title: 'Onboard Shopify store',
    description:
      'Playbook for connecting a Shopify storefront: create workspace, review crawl patterns for /products/ and /collections/, trigger crawl, validate with sample chat queries.',
    file: 'onboard-shopify.md',
  },
  {
    id: 'configure-chat',
    title: 'Tune chat behavior',
    description:
      'Walk through chat widget settings (persona, special instructions, allowed domains) for a workspace, and verify changes via live chat tests.',
    file: 'configure-chat.md',
  },
  {
    id: 'debug-empty-search',
    title: 'Debug empty search results',
    description:
      'Diagnostic flow for "the chat is not finding my product/article X". Checks indexing status, raw search results, and KB coverage for a specific query.',
    file: 'debug-empty-search.md',
  },
  {
    id: 'migrate-from-competitor',
    title: 'Migrate from another chat vendor',
    description:
      'Plan and execute a migration from a competing chat provider: inventory existing KB, create workspace, bulk-upsert content, and verify parity.',
    file: 'migrate-from-competitor.md',
  },
];

function skillsDir(): string {
  // When built, this file lives at dist/skills.js. The markdown sits at
  // ../skills/ relative to the package root in both dev (src/skills.ts)
  // and prod (dist/skills.js), so resolve from `import.meta.url`.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'skills');
}

function readSkillBody(file: string): string {
  try {
    return readFileSync(join(skillsDir(), file), 'utf8');
  } catch {
    // Missing file is a packaging bug; keep the server alive and surface
    // a useful fallback that also explains the outage.
    return `# Skill file missing\n\nThe file \`${file}\` could not be read from the package. This is a packaging bug — please file an issue.`;
  }
}

export function countBuiltInSkills(): number {
  return SKILLS.length;
}

export function registerSkillPrompts(server: McpServer): number {
  let registered = 0;
  for (const skill of SKILLS) {
    server.registerPrompt(
      skill.id,
      {
        title: skill.title,
        description: skill.description,
      },
      async () => ({
        description: skill.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: readSkillBody(skill.file),
            },
          },
        ],
      }),
    );
    registered++;
  }
  return registered;
}
