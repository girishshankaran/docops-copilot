# DocOps Copilot

AI-assisted bridge between code changes and Markdown documentation across two GitHub repos (code + docs).

## What it does
- Watches code changes on `main`/`copilot` pushes and PRs targeting `main`/`copilot`, then reads the git diff.
- Uses the diff first, then selectively scans key app files (changed files, nearby modules, and canonical repo files like `README.md` or `package.json`) when additional code context is useful.
- Maps changed files to relevant docs via `docs-map.yaml` globs, or infers target docs by indexing the docs repo when no mapping is available.
- For each target doc, fetches the current Markdown from the docs repo, feeds the code diff + doc snippet + style guide to an LLM, and returns a unified patch.
- Writes patches to `suggestions/` and can optionally post them as a PR comment in the code repo.
- Emits `doc-plan.json` so target selection is reviewable before patch application.
- A companion workflow in the docs repo applies patches on maintainer command, runs lint/build, and opens/updates a docs PR.
- If the docs repo is empty, it can infer bootstrap target paths and generate new-file patches instead of only updating existing docs.

## Quick start (local dry run)
1) Copy `docs-map.example.yaml` to `docs-map.yaml` and edit mappings.
2) Add secrets to `.env` (see `.env.example`). At minimum: `BRIDGE_API_APP_KEY`, `GITHUB_TOKEN`, `DOCS_REPO`.
3) Produce a diff file (example):
   ```bash
   git diff HEAD^ HEAD > /tmp/diff.patch
   ```
4) Run suggester:
   ```bash
   npx ts-node src/index.ts \
     --diff /tmp/diff.patch \
     --docs-map docs-map.yaml \
     --docs-repo your-org/your-docs-repo \
     --docs-branch main \
     --out-dir suggestions \
     --context-file references/prd.md \
     --context-file references/jira-123.txt
   ```
   Patches land in `suggestions/` and `suggestions.md` holds a ready-to-post comment.

## Local preflight (recommended before reruns)
Validate the same auth path used by GitHub Actions:
```bash
scripts/preflight-doc-suggest.sh
```
It checks token minting (or static token fallback), docs repo token access, and Chat-AI auth.

## Local workflow smoke test
Run a mock end-to-end workflow test with a sample diff and sample PRD context:
```bash
scripts/test-local-workflow.sh
```
It writes sample outputs under `/tmp/docops-local-test/out` by default.
The smoke test uses `--offline-docs` so it can run without GitHub access by treating the docs repo as empty.

## Local real-mode test
Run the same sample scenario against your real docs repo and LLM configuration:
```bash
DOCS_REPO=your-org/your-docs-repo scripts/test-local-workflow-real.sh
```
It runs [scripts/preflight-doc-suggest.sh](/Users/gisankar/Documents/DocOPs-Copilot/scripts/preflight-doc-suggest.sh) first, then writes outputs under `/tmp/docops-local-real-test/out` by default.

## GitHub Actions wiring
### In the code repo (`.github/workflows/doc-suggest.yml`)
Triggered on pushes to `main`/`copilot`, PRs to `main`/`copilot`, or manual dispatch.
```yaml
name: Doc Suggestions
on:
  push:
    branches: [main, copilot]
  pull_request:
    branches: [main, copilot]
  workflow_dispatch:

jobs:
  suggest-docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install tool
        run: |
          npm install -g ts-node typescript
          npm install openai @octokit/rest js-yaml minimatch
          curl -sL https://raw.githubusercontent.com/your-org/docops-copilot/main/docs-map.example.yaml -o docs-map.yaml
          # Optionally vendor this repo as a submodule and `npm ci` instead.
      - name: Collect diff
        run: git diff --unified=3 HEAD^ HEAD > /tmp/diff.patch
      - name: Generate suggestions
        env:
          BRIDGE_OAUTH_BASIC: ${{ secrets.BRIDGE_OAUTH_BASIC }}       # OAuth client credentials (base64 client_id:client_secret)
          BRIDGE_API_APP_KEY: ${{ secrets.BRIDGE_API_APP_KEY }}       # app key for Cisco Chat-AI user field
          GITHUB_TOKEN: ${{ secrets.DOCS_PAT }}           # PAT with repo scope so action can read docs repo
          DOCS_REPO: girishshankaran/docops-copilot-docs  # or set as repo variable DOCS_REPO
        run: |
          ts-node src/index.ts \
            --diff /tmp/diff.patch \
            --docs-repo ${{ vars.DOCS_REPO || 'girishshankaran/docops-copilot-docs' }} \
            --docs-branch ${DOCS_BRANCH:-main} \
            --out-dir suggestions \
            --code-repo ${{ github.repository }} \
            --comment-pr ${{ github.event.number }}
      - name: Upload suggestions artifact
        uses: actions/upload-artifact@v4
        with:
          name: doc-suggestions
          path: suggestions
```

### In the docs repo (`.github/workflows/apply-doc-patch.yml`)
Applies a patch when a maintainer comments `/apply-doc-patch` containing a patch block.
```yaml
name: Apply Doc Patch
on:
  issue_comment:
    types: [created]

jobs:
  apply:
    if: contains(github.event.comment.body, '/apply-doc-patch')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Extract patch from comment
        run: |
          echo "${{ github.event.comment.body }}" \
            | awk 'BEGIN{f=0}/```patch/{f=1;next}/```/{f=0}f' > /tmp/doc.patch
      - name: Apply patch
        run: git apply /tmp/doc.patch
      - name: Lint/Build
        run: |
          npm ci
          npm run lint --if-present
          npm run build --if-present
      - name: Commit & push
        env:
          GIT_AUTHOR_NAME: doc-bot
          GIT_AUTHOR_EMAIL: doc-bot@users.noreply.github.com
        run: |
          git checkout -B doc-bot/${{ github.run_id }}
          git add .
          git commit -m "Docs: auto-update from code change"
          git push --force origin HEAD
```

## Configuration
- `docs-map.yaml` (checked into the code repo) maps code globs to doc files/anchors. Example:
  ```yaml
  mappings:
    - code: "src/api/**/*.ts"
      docs:
        - path: "docs/api.md"
          anchor: "API"
        - path: "docs/release-notes.md"
          anchor: "Unreleased"
    - code: "cli/**"
      docs:
        - "docs/cli.md"
        - path: "docs/release-notes.md"
          anchor: "Unreleased"
  style_guide: "docs/STYLE.md"
  ```
- `docs` supports:
  - a single string path (`docs: "docs/api.md"`),
  - an array of string paths, or
  - an array of objects with per-doc anchors (`path` + optional `anchor`).
- If multiple mappings target the same doc, matched code files are merged and one patch is generated for that doc target.
- Style guide is optional; when present it is fed to the model to preserve tone.
- Target selection modes:
  - `--target-mode auto` (default): use `docs-map.yaml` when it yields targets, otherwise infer from the docs repo index.
  - `--target-mode infer`: ignore `docs-map.yaml` and infer doc targets.
  - `--target-mode map`: require `docs-map.yaml` and only use mapped targets.
- Supplemental context:
  - Use repeatable `--context-file <path>` flags for PRDs, Jira exports, design notes, or reference docs.
  - Use repeatable `--context-dir <path>` flags to ingest a folder of Markdown, text, JSON, or YAML files.
  - The tool summarizes this context into a bounded prompt block and writes `context-summary.json` plus source provenance into `doc-plan.json`.
  - Supplemental context is optional. When present, it biases both doc planning and doc generation; when absent, the tool falls back to code diff analysis plus docs repo indexing.
- App repo context:
  - The tool automatically collects bounded context from key app files and writes `app-context-summary.json`.
  - This targeted scan is used to improve planning and generation when the diff alone lacks enough surrounding code context.
- Offline docs mode:
  - Use `--offline-docs` for local testing when you want to skip GitHub docs repo access and treat the docs repo as empty.
- LLM config:
  - Cisco Chat-AI gateway (recommended): set `BRIDGE_OAUTH_BASIC` (used to mint fresh short-lived JWT per run) and `BRIDGE_API_APP_KEY` (app key used in request `user`), plus `OPENAI_BASE_URL`/`OPENAI_MODEL`.
  - Fallback static token mode: set `AZURE_OPENAI_API_KEY` (or `OPENAI_API_KEY`) if you cannot mint tokens in workflow.
  - Optional Azure OpenAI mode: set `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, and (optional) `AZURE_OPENAI_API_VERSION`. You can also use flags `--azure`, `--azure-endpoint`, `--azure-deployment`, `--azure-api-version`.

## Sample UI asset
- `ui/home1.html` – static Cisco Social home mock (posts, groups, polls). Open directly in a browser to preview; no build step required.

## Using Azure OpenAI
- Add to `.env`:
  - `AZURE_OPENAI_API_KEY=...`
  - `AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com`
  - `AZURE_OPENAI_DEPLOYMENT=<your-deployment>`
  - `AZURE_OPENAI_API_VERSION=2024-10-01-preview` (or your version)
- Run with the Azure client by either:
  - Passing `--azure --azure-endpoint ... --azure-deployment ...`, or
  - Setting the env vars above (auto-detected).
- Model name passed to the API is the deployment name; keep `--model`/`OPENAI_MODEL` in sync with your deployment if you prefer using that flag instead of `AZURE_OPENAI_DEPLOYMENT`.

## Security & guardrails
- Low-temp model call (`temperature: 0.2`) to reduce hallucinations.
- Only touches mapped docs; if no mapping, it reports coverage gap.
- Patches are reviewed by humans (comment + apply command) before landing.
- Build/lint step prevents broken docs from merging.

## Offline/mock testing (no OpenAI call)
- Run the CLI with `--mock` to skip the OpenAI API and emit a deterministic placeholder patch:
  ```bash
  npx ts-node src/index.ts \
    --diff /tmp/diff.patch \
    --docs-map docs-map.yaml \
    --docs-repo girishshankaran/docops-copilot-docs \
    --docs-branch main \
    --out-dir suggestions \
    --mock
  ```
  Use this to test the pipeline, artifact outputs, and patch handling without any API usage.

## Project structure
- `src/index.ts` – main CLI to generate doc patches from code diff.
- `src/planner.ts` – doc target planning and inference logic.
- `src/analyze-diff.ts` – diff parsing helpers.
- `src/context.ts` – supplemental context ingestion and summarization.
- `src/app-context.ts` – targeted app repo context collection.
- `src/types.ts` – shared planning and docs-map types.
- `src/apply-patch.ts` – convenience helper to apply a saved patch via `git apply`.
- `docs-map.example.yaml` – starter mapping file.
- `.env.example` – required secrets.
- `templates/feature-doc.template.md` – starter template for per-feature docs.
- `templates/release-notes.template.md` – starter template for release notes format.
- `templates/repo-init-checklist.md` – new product docs initialization checklist.

## Documentation standards (new products)
- Keep each feature in one Markdown file (for example, `feature-name.md`).
- Include these sections in each feature file when applicable:
  - `Overview` (mandatory)
  - `Configuration & Installation`
  - `API Documentation`
  - `Troubleshooting`
- Keep release notes in `release-notes.md` as a standalone aggregate.
- Group release notes by date/version and link each new feature entry back to its feature doc.

## Limitations
- Requires OpenAI API access and GitHub token with repo scope.
- Diff-to-doc matching is glob-based; for better recall, add more mappings or integrate search later.

## Next steps (stretch)
- Add vector search over docs for fallback targeting.
- Confidence scoring + block auto-apply on low confidence.
- Publish this repo as an npm package or composite GitHub Action for easier reuse.
