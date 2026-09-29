#!/bin/bash
set -euo pipefail

echo "Installing Remodex..."

if ! command -v node &>/dev/null; then
  echo "Node.js 18+ is required. Install Node from https://nodejs.org/ and rerun this script." >&2
  exit 1
fi

NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18+ is required. Current version: $(node --version)" >&2
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "npm is required to install the published Remodex package." >&2
  exit 1
fi

echo "Using Node $(node --version)"

# Install Remodex globally.
# If npm reports "install scripts blocked" for bun, rerun as:
#   npm install -g --allow-scripts=bun @remodex/rmx
# (keep sudo if the original install used sudo)
npm install -g @remodex/rmx

CLI_COMMAND=""
for candidate in rmx remodex opencodex ocx; do
  if command -v "$candidate" &>/dev/null; then
    CLI_COMMAND="$candidate"
    break
  fi
done
if [ -z "$CLI_COMMAND" ]; then
  NPM_BIN="$(npm bin -g 2>/dev/null || printf "%s/bin" "$(npm prefix -g)")"
  echo "Remodex installed, but the canonical 'rmx' command is not on PATH." >&2
  echo "Add your npm global bin directory to PATH, then rerun your shell: $NPM_BIN" >&2
  exit 1
fi

if ! "$CLI_COMMAND" help >/dev/null; then
  echo "Remodex installed, but '$CLI_COMMAND help' failed. Check your npm global install and PATH." >&2
  exit 1
fi

echo ""
echo "✅ Remodex installed! Run 'rmx init' (aliases: remodex, opencodex, ocx) to set up."
