# DocOps Copilot

AI-assisted bridge between code changes and Markdown documentation across two GitHub repos (code + docs).

## What it does
- Watches code merges (push to `main`) and reads the git diff.
- Maps changed files to relevant docs via `docs-map.yaml` globs.
- For each target doc, fetches the current Markdown from the docs repo, feeds the code diff + doc snippet + style guide to an LLM, and returns a unified patch.
- Writes patches to `suggestions/` and can optionally post them as a PR comment in the code repo.
- A companion workflow in the docs repo applies patches on maintainer command, runs lint/build, and opens/updates a docs PR.

## Quick start (local dry run)
1) Copy `docs-map.example.yaml` to `docs-map.yaml` and edit mappings.
2) Add secrets to `.env` (see `.env.example`). At minimum: `OPENAI_API_KEY`, `GITHUB_TOKEN`, `DOCS_REPO`.
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
     --out-dir suggestions
   ```
   Patches land in `suggestions/` and `suggestions.md` holds a ready-to-post comment.

## GitHub Actions wiring
### In the code repo (`.github/workflows/doc-suggest.yml`)
Triggered on merge to `main`; generates doc suggestions and comments on the originating PR.
```yaml
name: Doc Suggestions
on:
  push:
    branches: [main]

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
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DOCS_REPO: your-org/docs-repo
        run: |
          ts-node src/index.ts \
            --diff /tmp/diff.patch \
            --docs-repo your-org/docs-repo \
            --docs-branch main \
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
      docs: "docs/api.md"
      anchor: "API"
    - code: "cli/**"
      docs: "docs/cli.md"
  style_guide: "docs/STYLE.md"
  ```
- Style guide is optional; when present it is fed to the model to preserve tone.

## Security & guardrails
- Low-temp model call (`temperature: 0.2`) to reduce hallucinations.
- Only touches mapped docs; if no mapping, it reports coverage gap.
- Patches are reviewed by humans (comment + apply command) before landing.
- Build/lint step prevents broken docs from merging.

## Project structure
- `src/index.ts` – main CLI to generate doc patches from code diff.
- `src/apply-patch.ts` – convenience helper to apply a saved patch via `git apply`.
- `docs-map.example.yaml` – starter mapping file.
- `.env.example` – required secrets.

## Limitations
- Requires OpenAI API access and GitHub token with repo scope.
- Diff-to-doc matching is glob-based; for better recall, add more mappings or integrate search later.

## Next steps (stretch)
- Add vector search over docs for fallback targeting.
- Confidence scoring + block auto-apply on low confidence.
- Publish this repo as an npm package or composite GitHub Action for easier reuse.
