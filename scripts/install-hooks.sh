#!/usr/bin/env bash
# Enables the repo's git hooks for this checkout (scripts/hooks).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
chmod +x scripts/hooks/pre-commit scripts/hooks/pre-push
git config core.hooksPath scripts/hooks
echo "git hooks enabled: core.hooksPath = scripts/hooks (undo: git config --unset core.hooksPath)"
