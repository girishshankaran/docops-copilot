#!/usr/bin/env bash
set -euo pipefail

# Local smoke test for the doc suggestion workflow.
# Creates a sample diff and optional context, then runs the CLI in mock mode.
#
# Usage:
#   scripts/test-local-workflow.sh [output-dir]
#
# Optional env:
#   DOCS_REPO       Docs repo to target. Default: your-org/your-docs-repo
#   DOCS_BRANCH     Docs branch. Default: main
#   TARGET_MODE     Target selection mode. Default: infer

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT_DIR="${1:-/tmp/docops-local-test}"
DOCS_REPO="${DOCS_REPO:-your-org/your-docs-repo}"
DOCS_BRANCH="${DOCS_BRANCH:-main}"
TARGET_MODE="${TARGET_MODE:-infer}"

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

echo "Running local workflow smoke test..."
echo "Output directory: $OUT_DIR"
echo "Docs repo: $DOCS_REPO"
echo "Docs branch: $DOCS_BRANCH"
echo "Target mode: $TARGET_MODE"

npm run build >/dev/null

node dist/index.js \
  --diff "$OUT_DIR/diff.patch" \
  --docs-repo "$DOCS_REPO" \
  --docs-branch "$DOCS_BRANCH" \
  --out-dir "$OUT_DIR/out" \
  --mock \
  --offline-docs \
  --target-mode "$TARGET_MODE" \
  --context-file "$OUT_DIR/context/prd.md"

echo
echo "Smoke test complete. Inspect these files:"
echo "  $OUT_DIR/out/doc-plan.json"
echo "  $OUT_DIR/out/run-report.json"
echo "  $OUT_DIR/out/llm-input-debug.json"
echo "  $OUT_DIR/out/app-context-summary.json"
echo "  $OUT_DIR/out/context-summary.json"
echo "  $OUT_DIR/out/suggestions.md"
echo
echo "Patch files:"
find "$OUT_DIR/out" -maxdepth 1 -name '*.patch' -print | sed 's/^/  /'
