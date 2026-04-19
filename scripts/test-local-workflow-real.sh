#!/usr/bin/env bash
set -euo pipefail

# Local real-mode test for the doc suggestion workflow.
# Creates a sample diff and sample PRD context, validates auth, then runs the CLI
# against the real docs repo and LLM configuration from .env/environment.
#
# Usage:
#   scripts/test-local-workflow-real.sh [output-dir]
#
# Required env or .env:
#   GITHUB_TOKEN
#   DOCS_REPO
#   One of:
#     - BRIDGE_OAUTH_BASIC (or CISCO_OAUTH_BASIC), plus BRIDGE_API_APP_KEY/OPENAI_USER_APPKEY
#     - AZURE_OPENAI_API_KEY or OPENAI_API_KEY, plus OPENAI_USER/BRIDGE_API_APP_KEY
#
# Optional env:
#   DOCS_BRANCH     Docs branch. Default: main
#   TARGET_MODE     Target selection mode. Default: infer

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT_DIR="${1:-/tmp/docops-local-real-test}"
DOCS_REPO="${DOCS_REPO:-}"
DOCS_BRANCH="${DOCS_BRANCH:-main}"
TARGET_MODE="${TARGET_MODE:-infer}"

if [[ -z "$DOCS_REPO" ]]; then
  echo "DOCS_REPO is required for real-mode testing." >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/context"

cat >"$OUT_DIR/diff.patch" <<'EOF'
diff --git a/src/api/reports.ts b/src/api/reports.ts
index 1111111..2222222 100644
--- a/src/api/reports.ts
+++ b/src/api/reports.ts
@@ -1,6 +1,13 @@
 export interface ReportSummary {
   id: string;
   name: string;
   createdAt: string;
   category: 'operations' | 'security' | 'compliance';
+  status?: 'draft' | 'published';
 }
+
+export const listReportStatuses = (): string[] => {
+  return ['draft', 'published'];
+};
EOF

cat >"$OUT_DIR/context/prd.md" <<'EOF'
# Reporting Status PRD

## Summary
Add report lifecycle status support.

## User Value
Users should be able to distinguish draft reports from published reports.

## Documentation Notes
Update API documentation and release notes if applicable.
EOF

echo "Running local real-mode workflow test..."
echo "Output directory: $OUT_DIR"
echo "Docs repo: $DOCS_REPO"
echo "Docs branch: $DOCS_BRANCH"
echo "Target mode: $TARGET_MODE"
echo
echo "Running preflight..."
scripts/preflight-doc-suggest.sh

echo
echo "Building project..."
npm run build >/dev/null

echo
echo "Running real generation..."
node dist/index.js \
  --diff "$OUT_DIR/diff.patch" \
  --docs-repo "$DOCS_REPO" \
  --docs-branch "$DOCS_BRANCH" \
  --out-dir "$OUT_DIR/out" \
  --target-mode "$TARGET_MODE" \
  --context-file "$OUT_DIR/context/prd.md"

echo
echo "Real-mode test complete. Inspect these files:"
echo "  $OUT_DIR/out/doc-plan.json"
echo "  $OUT_DIR/out/run-report.json"
echo "  $OUT_DIR/out/llm-input-debug.json"
echo "  $OUT_DIR/out/app-context-summary.json"
echo "  $OUT_DIR/out/context-summary.json"
echo "  $OUT_DIR/out/suggestions.md"
echo
echo "Patch files:"
find "$OUT_DIR/out" -maxdepth 1 -name '*.patch' -print | sed 's/^/  /'
