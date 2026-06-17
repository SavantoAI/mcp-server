#!/usr/bin/env bash
#
# Re-sync the public mirror (github.com/SavantoAI/mcp-server) from this monorepo's
# sdks/mcp, then leave you to review + push. Pushing is intentionally NOT done by
# this script — publishing private source to the public repo is a deliberate human
# step. The mirror publishes to npm on a `v<x.y.z>` TAG push (OIDC Trusted
# Publishing); pushing main updates the source, the matching tag does the release.
#
# What it does:
#   - clones the public mirror (to preserve its .github/ release workflow + history)
#   - replaces everything tracked there EXCEPT .github with this repo's sdks/mcp
#   - drops internal planning docs (TIER1-PLAN.md, REMOTE-MCP-PLAN.md)
#   - rewrites package.json repository/bugs/homepage for the standalone repo
#   - commits the result and prints the diff + the exact push command
#
# Usage:  bash sdks/mcp/scripts/sync-public-mirror.sh
set -euo pipefail

MIRROR_URL="https://github.com/SavantoAI/mcp-server.git"
REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
PKG_DIR="$REPO_ROOT/sdks/mcp"
VERSION="$(node -p "require('$PKG_DIR/package.json').version")"

# Stable, re-runnable work dir. NOT auto-deleted — you push from it after review,
# so it must outlive this script. Re-running wipes the previous clone first.
WORK="${TMPDIR:-/tmp}/savanto-mcp-mirror-sync"
rm -rf "$WORK"
mkdir -p "$WORK"
echo "→ Cloning mirror into $WORK/mirror"
git clone --quiet "$MIRROR_URL" "$WORK/mirror"
cd "$WORK/mirror"

# Replace everything except .git and the mirror-only .github/ (its release
# workflow) with this repo's sdks/mcp. `find -exec ... +` is portable across
# BSD/macOS + GNU (no `xargs -r`); `git add -A` later stages the deletions.
find . -mindepth 1 -maxdepth 1 ! -name .git ! -name .github -exec rm -rf {} +

# Overlay the current monorepo package (tracked files only → no dist/node_modules).
git -C "$REPO_ROOT" archive HEAD:sdks/mcp | tar -x -C .

# Strip internal planning docs that must not ship publicly.
rm -f TIER1-PLAN.md REMOTE-MCP-PLAN.md

# Point package metadata at the standalone public repo (in the monorepo it
# correctly points at savanto.git#sdks/mcp; the mirror is its own repo root).
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  p.repository = { type: "git", url: "git+https://github.com/SavantoAI/mcp-server.git" };
  p.bugs = { url: "https://github.com/SavantoAI/mcp-server/issues" };
  p.homepage = "https://savanto.ai/mcp";
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
'

git add -A
if git diff --cached --quiet; then
  echo "✓ Mirror already matches the monorepo — nothing to publish."
  exit 0
fi

git commit -q -m "release: ${VERSION}"
echo
echo "──────────────────────────────────────────────────────────────"
echo "Staged release ${VERSION}. Review the changes:"
echo
git --no-pager diff --stat HEAD~1
echo
echo "If it looks right, publish it (the deliberate go-public step). The mirror"
echo "releases on a v<x.y.z> TAG push (OIDC Trusted Publishing) — pushing main only"
echo "updates the source; the matching tag is what triggers the npm release:"
echo
echo "    cd $WORK/mirror"
echo "    git push origin main          # update source"
echo "    git tag v${VERSION}"
echo "    git push origin v${VERSION}   # triggers publish of ${VERSION} to npm"
echo
echo "Then watch the run: gh run watch -R SavantoAI/mcp-server"
echo "Verify:             npm view @savantoai/mcp-server version   # → ${VERSION}"
echo "──────────────────────────────────────────────────────────────"
