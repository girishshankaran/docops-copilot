import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import yaml from 'js-yaml';
import { Octokit } from '@octokit/rest';
import { minimatch } from 'minimatch';
import OpenAI, { AzureOpenAI } from 'openai';

interface DocsMapDocEntry {
  path: string;
  anchor?: string;
}

interface DocsMapMapping {
  code: string;
  docs: string | Array<string | DocsMapDocEntry>;
  anchor?: string;
}

interface DocsMap {
  mappings: DocsMapMapping[];
  fallback?: { search_headings?: boolean };
  style_guide?: string;
}

interface TargetDoc {
  docsPath: string;
  anchor?: string;
  matchedFiles: string[];
}

const loadEnvFile = () => {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
};

loadEnvFile();

const readFileSafe = (p: string): string | undefined => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const idx = args.indexOf(flag);
    if (idx >= 0 && args[idx + 1]) return args[idx + 1];
    return fallback;
  };
  const has = (flag: string) => args.includes(flag);
  const buildGatewayUser = (): string | undefined => {
    if (process.env.OPENAI_USER) return process.env.OPENAI_USER;
    if (process.env.BRIDGE_API_APP_KEY) {
      return JSON.stringify({ appkey: process.env.BRIDGE_API_APP_KEY });
    }
    if (process.env.OPENAI_USER_APPKEY) {
      return JSON.stringify({ appkey: process.env.OPENAI_USER_APPKEY });
    }
    return undefined;
  };
  return {
    diffPath: get('--diff'),
    docsMapPath: get('--docs-map', 'docs-map.yaml'),
    docsRepo: get('--docs-repo') || process.env.DOCS_REPO,
    docsBranch: get('--docs-branch', process.env.DOCS_BRANCH || 'main'),
    outDir: get('--out-dir', 'suggestions'),
    commentPr: get('--comment-pr'),
    codeRepo: get('--code-repo'),
    styleGuidePath: get('--style-guide'),
    openaiBaseUrl: get('--openai-base-url', process.env.OPENAI_BASE_URL),
    model: get('--model', process.env.OPENAI_MODEL || 'gpt-4o-mini'),
    azure: has('--azure') || Boolean(process.env.AZURE_OPENAI_ENDPOINT),
    azureEndpoint: get('--azure-endpoint', process.env.AZURE_OPENAI_ENDPOINT),
    azureDeployment: get('--azure-deployment', process.env.AZURE_OPENAI_DEPLOYMENT),
    azureApiVersion: get('--azure-api-version', process.env.AZURE_OPENAI_API_VERSION || '2024-10-01-preview'),
    user: get('--user', buildGatewayUser()),
    verbose: has('--verbose'),
    mock: has('--mock'),
    llmOnly: has('--llm-only') || String(process.env.LLM_ONLY || '').toLowerCase() === 'true',
  };
};

const loadDocsMap = (p: string): DocsMap => {
  const content = readFileSafe(p);
  if (!content) {
    throw new Error(`docs-map not found at ${p}`);
  }
  const parsed = yaml.load(content) as DocsMap;
  if (!parsed.mappings || !Array.isArray(parsed.mappings)) {
    throw new Error('docs-map must include mappings[]');
  }
  for (const m of parsed.mappings) {
    if (!m || typeof m.code !== 'string' || !m.code.trim()) {
      throw new Error('docs-map mapping.code must be a non-empty string');
    }
    if (typeof m.docs === 'string') continue;
    if (!Array.isArray(m.docs) || m.docs.length === 0) {
      throw new Error('docs-map mapping.docs must be a string or non-empty array');
    }
    for (const d of m.docs) {
      if (typeof d === 'string') continue;
      if (!d || typeof d.path !== 'string' || !d.path.trim()) {
        throw new Error('docs-map mapping.docs[].path must be a non-empty string');
      }
    }
  }
  return parsed;
};

const parseDiffFiles = (diff: string): Map<string, string> => {
  const fileToDiff = new Map<string, string>();
  const lines = diff.split(/\r?\n/);
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) fileToDiff.set(current, buffer.join('\n'));
    buffer = [];
  };
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (current) flush();
      const parts = line.split(' ');
      const b = parts[3];
      const file = b?.replace('b/', '');
      current = file || null;
      buffer.push(line);
      continue;
    }
    buffer.push(line);
  }
  if (current) flush();
  return fileToDiff;
};

const isDeletedFileDiff = (fileDiff: string): boolean => {
  if (!fileDiff) return false;
  if (/^deleted file mode\s+/m.test(fileDiff)) return true;
  if (/^---\s+a\/.+$/m.test(fileDiff) && /^\+\+\+\s+\/dev\/null$/m.test(fileDiff)) return true;
  return false;
};

const resolveTargets = (files: string[], map: DocsMap): TargetDoc[] => {
  const byDoc = new Map<string, TargetDoc>();
  const keyOf = (docsPath: string, anchor?: string) => `${docsPath}::${anchor || ''}`;
  for (const m of map.mappings) {
    const matched = files.filter((f) => minimatch(f, m.code, { dot: true }));
    if (matched.length === 0) continue;
    const docsEntries: DocsMapDocEntry[] = typeof m.docs === 'string'
      ? [{ path: m.docs, anchor: m.anchor }]
      : m.docs.map((d) => (typeof d === 'string' ? { path: d, anchor: m.anchor } : { path: d.path, anchor: d.anchor || m.anchor }));
    for (const entry of docsEntries) {
      const key = keyOf(entry.path, entry.anchor);
      const existing = byDoc.get(key);
      if (!existing) {
        byDoc.set(key, { docsPath: entry.path, anchor: entry.anchor, matchedFiles: Array.from(new Set(matched)) });
      } else {
        existing.matchedFiles = Array.from(new Set([...existing.matchedFiles, ...matched]));
      }
    }
  }
  return Array.from(byDoc.values());
};

const fetchFileFromRepo = async (octokit: Octokit, repo: string, filePath: string, ref: string): Promise<string> => {
  const [owner, repoName] = repo.split('/');
  const res = await octokit.repos.getContent({ owner, repo: repoName, path: filePath, ref });
  if (!('content' in res.data)) throw new Error(`File ${filePath} has no content field`);
  const buff = Buffer.from(res.data.content, 'base64');
  return buff.toString('utf8');
};

const extractSection = (content: string, anchor?: string): string => {
  if (!anchor) return content;
  const lines = content.split(/\r?\n/);
  const heading = anchor.replace(/^#+\s*/, '').trim().toLowerCase();
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#')) {
      const clean = l.replace(/^#+\s*/, '').trim().toLowerCase();
      if (clean === heading) {
        start = i;
        break;
      }
    }
  }
  const snippet = lines.slice(start).join('\n');
  return snippet.length > 2400 ? snippet.slice(0, 2400) : snippet;
};

const buildPrompt = (params: {
  diff: string;
  docPath: string;
  docContent: string;
  styleGuide?: string;
}): string => {
  const { diff, docPath, docContent, styleGuide } = params;
  const guideBlock = styleGuide ? `Style guide (respect tone, voice, formatting):\n${styleGuide}\n` : '';
  return [
    'You are an expert technical writer. Update the Markdown documentation based on the provided code diff.',
    guideBlock,
    'Constraints: respond with a unified diff patch against the target doc only. Do not add new files. Keep existing formatting.',
    `Target doc: ${docPath}`,
    'Code diff:',
    diff,
    'Current doc content (truncate if long):',
    docContent,
    'Return only the patch between ```patch``` fences.',
  ].filter(Boolean).join('\n\n');
};

const buildStrictPatchPrompt = (params: {
  diff: string;
  docPath: string;
  docContent: string;
  styleGuide?: string;
}): string => {
  const base = buildPrompt(params);
  return [
    base,
    'IMPORTANT PATCH FORMAT RULES:',
    '- Include diff header: diff --git a/<path> b/<path>.',
    '- Include --- a/<path> and +++ b/<path> lines.',
    '- Every hunk header must include ranges (example: @@ -10,2 +10,3 @@).',
    '- Do not output bare @@.',
    '- Do not include markdown fences.',
    '- Patch must be directly applicable with git apply.',
  ].join('\n');
};

const buildFullDocPrompt = (params: {
  diff: string;
  docPath: string;
  docContent: string;
  styleGuide?: string;
}): string => {
  const { diff, docPath, docContent, styleGuide } = params;
  const guideBlock = styleGuide ? `Style guide (respect tone, voice, formatting):\n${styleGuide}\n` : '';
  const standardsBlock = [
    'Documentation standards:',
    '- For feature docs, keep documentation for a feature in a single Markdown file and include these sections when applicable:',
    '  - Overview',
    '  - Configuration & Installation',
    '  - API Documentation',
    '  - Troubleshooting',
    '- For release notes (`release-notes.md`):',
    '  - Keep it as a standalone aggregate file.',
    '  - Organize entries by date or version.',
    '  - For new features, add/update a row under "New Features" with columns: Feature | Description | More Information.',
    '  - Link each release-note feature entry to its primary feature documentation file when possible.',
  ].join('\n');
  return [
    'You are an expert technical writer. Update the Markdown documentation based on the provided code diff.',
    guideBlock,
    standardsBlock,
    `Target doc: ${docPath}`,
    'Editing rules (strict):',
    '- Keep unchanged lines verbatim whenever possible.',
    '- Only modify sections directly impacted by the provided code diff.',
    '- Do not reorder existing headings or sections.',
    '- Do not rewrite style/wording of unaffected content.',
    '- Preserve existing Markdown structure unless required by the code change.',
    'Code diff:',
    diff,
    'Current doc content:',
    docContent,
    'Return the COMPLETE updated Markdown document content only.',
    'Do not include code fences.',
  ].filter(Boolean).join('\n\n');
};

const generatePatch = async (
  client: OpenAI | AzureOpenAI,
  model: string,
  prompt: string,
  user?: string,
): Promise<{ patch: string; raw: string }> => {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'You generate minimal documentation patches from code diffs.' },
      { role: 'user', content: prompt },
    ],
    ...(user ? { user } : {}),
  });
  if (!completion || !Array.isArray((completion as any).choices) || (completion as any).choices.length === 0) {
    throw new Error(`LLM response missing choices: ${JSON.stringify(completion)}`);
  }
  const text = (completion as any).choices[0]?.message?.content || '';
  const match = text.match(/```patch\n([\s\S]*?)```/);
  return { patch: match ? match[1].trim() : text.trim(), raw: text };
};

const generateUpdatedDoc = async (
  client: OpenAI | AzureOpenAI,
  model: string,
  prompt: string,
  user?: string,
): Promise<{ doc: string; raw: string }> => {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'You rewrite full Markdown documents based on code diffs.' },
      { role: 'user', content: prompt },
    ],
    ...(user ? { user } : {}),
  });
  if (!completion || !Array.isArray((completion as any).choices) || (completion as any).choices.length === 0) {
    throw new Error(`LLM response missing choices: ${JSON.stringify(completion)}`);
  }
  const text = (completion as any).choices[0]?.message?.content || '';
  const fenced = text.match(/```(?:markdown|md)?\n([\s\S]*?)```/i);
  return { doc: (fenced ? fenced[1] : text).trim(), raw: text };
};

const ensureDir = (p: string) => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
};

const createClient = (args: ReturnType<typeof parseArgs>) => {
  if (args.azure) {
    // Avoid conflicts with OpenAI baseURL when using Azure client.
    if (process.env.OPENAI_BASE_URL) delete process.env.OPENAI_BASE_URL;
    if (!args.azureEndpoint) throw new Error('AZURE_OPENAI_ENDPOINT is required for Azure usage');
    if (!process.env.AZURE_OPENAI_API_KEY) throw new Error('AZURE_OPENAI_API_KEY is required for Azure usage');
    const deployment = args.azureDeployment || args.model;
    if (!deployment) throw new Error('AZURE_OPENAI_DEPLOYMENT (or --model) is required for Azure usage');
    const client = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: args.azureEndpoint,
      apiVersion: args.azureApiVersion,
    });
    return { client, model: deployment };
  }

  const apiKey = process.env.AZURE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = args.model || 'gpt-4o-mini';
  const client = new OpenAI({
    apiKey,
    baseURL: args.openaiBaseUrl,
    // Some gateways expect `api-key` header instead of Authorization: Bearer
    defaultHeaders: { 'api-key': apiKey },
  });
  return { client, model };
};

const writeSuggestionFiles = (outDir: string, docPath: string, patch: string, rationale?: string) => {
  ensureDir(outDir);
  const safeName = docPath.replace(/[\\/]/g, '__');
  fs.writeFileSync(path.join(outDir, `${safeName}.patch`), patch, 'utf8');
  if (rationale) fs.writeFileSync(path.join(outDir, `${safeName}.txt`), rationale, 'utf8');
};

const fixBareHunkHeaders = (patch: string): string => {
  const lines = patch.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '@@') {
      out.push(line);
      continue;
    }
    const hunk: string[] = [];
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('@@') && !lines[j].startsWith('diff --git')) {
      hunk.push(lines[j]);
      j++;
    }
    const oldCount = hunk.filter((l) => !l.startsWith('+') && l !== '\\ No newline at end of file').length;
    const newCount = hunk.filter((l) => !l.startsWith('-') && l !== '\\ No newline at end of file').length;
    const oldStart = oldCount === 0 ? 0 : 1;
    const newStart = 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    out.push(...hunk);
    i = j - 1;
  }
  return out.join('\n');
};

const checkPatchApplicable = (
  docPath: string,
  docContent: string,
  patch: string,
  fileExists = true,
): { ok: boolean; error?: string } => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docops-patch-check-'));
  try {
    if (fileExists) {
      // git apply expects the working-tree-relative path after stripping a/ b/ prefixes.
      const targetPath = path.join(tmpRoot, docPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, docContent, 'utf8');
    }
    fs.writeFileSync(path.join(tmpRoot, 'candidate.patch'), patch, 'utf8');
    execSync(`git apply --check "${path.join(tmpRoot, 'candidate.patch')}"`, { cwd: tmpRoot, stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
};

const normalizePatch = (docPath: string, docContent: string, patch: string, fileExists = true): string => {
  const normalized = patch.replace(/\r\n/g, '\n');
  const candidate = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  const first = checkPatchApplicable(docPath, docContent, candidate, fileExists);
  if (first.ok) return candidate;
  const fixed = fixBareHunkHeaders(candidate);
  if (fixed !== candidate) {
    const fixedWithNl = fixed.endsWith('\n') ? fixed : `${fixed}\n`;
    const second = checkPatchApplicable(docPath, docContent, fixedWithNl, fileExists);
    if (second.ok) return fixedWithNl;
    throw new Error(`Generated patch for ${docPath} is invalid/corrupt (${second.error || 'check failed'})`);
  }
  throw new Error(`Generated patch for ${docPath} is invalid/corrupt (${first.error || 'check failed'})`);
};

const buildPatchFromContent = (docPath: string, oldContent: string, newContent: string): string | undefined => {
  const normalizedOld = oldContent.replace(/\r\n/g, '\n');
  const normalizedNew = newContent.replace(/\r\n/g, '\n');
  if (normalizedOld === normalizedNew) return undefined;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docops-content-diff-'));
  try {
    const oldPath = path.join(tmpRoot, 'old.md');
    const newPath = path.join(tmpRoot, 'new.md');
    fs.writeFileSync(oldPath, normalizedOld, 'utf8');
    fs.writeFileSync(newPath, normalizedNew, 'utf8');
    const res = spawnSync('git', ['diff', '--no-index', '--unified=3', oldPath, newPath], { encoding: 'utf8' });
    if (res.status !== 0 && res.status !== 1) {
      throw new Error(res.stderr?.trim() || `git diff failed with status ${res.status}`);
    }
    const raw = (res.stdout || '').replace(/\r\n/g, '\n');
    if (!raw.trim()) return undefined;
    const lines = raw.split('\n');
    const hunkStart = lines.findIndex((l) => l.startsWith('@@ '));
    if (hunkStart < 0) return undefined;
    const hunks = lines.slice(hunkStart).join('\n').replace(/\n*$/, '\n');
    return [
      `diff --git a/${docPath} b/${docPath}`,
      `--- a/${docPath}`,
      `+++ b/${docPath}`,
      hunks,
    ].join('\n').replace(/\n*$/, '\n');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
};

const buildReplaceAllPatch = (docPath: string, oldContent: string, newContent: string): string => {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const body = [
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ].join('\n');
  return [
    `diff --git a/${docPath} b/${docPath}`,
    `--- a/${docPath}`,
    `+++ b/${docPath}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    body,
  ].join('\n');
};

const buildNewFilePatch = (docPath: string, content: string): string => {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const count = lines.length;
  const added = lines.map((l) => `+${l}`).join('\n');
  return [
    `diff --git a/${docPath} b/${docPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${docPath}`,
    `@@ -0,0 +1,${count} @@`,
    added,
  ].join('\n');
};

const buildDeleteFilePatch = (docPath: string, oldContent: string): string => {
  const normalizedOld = oldContent.replace(/\r\n/g, '\n');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docops-delete-diff-'));
  try {
    const oldPath = path.join(tmpRoot, 'old.md');
    fs.writeFileSync(oldPath, normalizedOld, 'utf8');
    const res = spawnSync('git', ['diff', '--no-index', '--unified=3', oldPath, '/dev/null'], { encoding: 'utf8' });
    if (res.status !== 0 && res.status !== 1) {
      throw new Error(res.stderr?.trim() || `git diff failed with status ${res.status}`);
    }
    const raw = (res.stdout || '').replace(/\r\n/g, '\n');
    const lines = raw.split('\n');
    const deletedMode = lines.find((l) => l.startsWith('deleted file mode')) || 'deleted file mode 100644';
    const hunkStart = lines.findIndex((l) => l.startsWith('@@ '));
    if (hunkStart < 0) throw new Error(`failed to build delete patch hunk for ${docPath}`);
    const hunks = lines.slice(hunkStart).join('\n').replace(/\n*$/, '\n');
    return [
      `diff --git a/${docPath} b/${docPath}`,
      deletedMode,
      `--- a/${docPath}`,
      '+++ /dev/null',
      hunks,
    ].join('\n').replace(/\n*$/, '\n');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
};

const buildDeterministicUiDocUpdate = (docContent: string, combinedDiff: string): string => {
  const diffLower = combinedDiff.toLowerCase();
  const added = combinedDiff
    .split(/\r?\n/)
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1).trim())
    .filter(Boolean)
    .slice(0, 8);
  const removed = combinedDiff
    .split(/\r?\n/)
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1).trim())
    .filter(Boolean)
    .slice(0, 8);
  const ts = new Date().toISOString().slice(0, 19) + 'Z';
  const lines: string[] = [];
  lines.push('## Automated UI Sync Notes');
  lines.push('');
  lines.push(`Last synced from \`ui/home1.html\` at ${ts}.`);
  if (added.length) {
    lines.push('');
    lines.push('### Added UI lines');
    for (const a of added) lines.push(`- \`${a}\``);
  }
  if (removed.length) {
    lines.push('');
    lines.push('### Removed UI lines');
    for (const r of removed) lines.push(`- \`${r}\``);
  }
  // Add actionable procedures inferred from added UI actions (generic, not feature-specific).
  const addedButtons = added
    .map((l) => {
      const m = l.match(/<button[^>]*id="([^"]+)"[^>]*>([^<]+)<\/button>/i);
      if (!m) return undefined;
      return { id: m[1], label: m[2].trim() };
    })
    .filter((v): v is { id: string; label: string } => Boolean(v));
  const addedActionIds = new Set(
    added
      .map((l) => {
        const m = l.match(/getElementById\('([^']+)'\)\.onclick/i);
        return m ? m[1] : undefined;
      })
      .filter((v): v is string => Boolean(v)),
  );
  const actionLabels = addedButtons
    .filter((b) => addedActionIds.size === 0 || addedActionIds.has(b.id))
    .map((b) => b.label)
    .filter((v, i, arr) => arr.indexOf(v) === i);
  const addedModals = added
    .map((l) => {
      const m = l.match(/id="([^"]*modal[^"]*)"/i);
      return m ? m[1] : undefined;
    })
    .filter((v): v is string => Boolean(v))
    .filter((v, i, arr) => arr.indexOf(v) === i);
  if (actionLabels.length > 0 || addedModals.length > 0 || diffLower.includes('onclick')) {
    lines.push('');
    lines.push('### Procedure: Use New UI Actions');
    const scopedActions = actionLabels.length > 0 ? actionLabels : ['new toolbar action'];
    for (const label of scopedActions) {
      lines.push(`1. Open the Cisco Social home page and click **${label}**.`);
      if (addedModals.length > 0) {
        lines.push(`2. Use the opened panel/modal (${addedModals.join(', ')}) and enter required inputs.`);
      } else {
        lines.push('2. Follow the on-screen prompts and enter required inputs for the action.');
      }
      lines.push('3. Complete the action and verify confirmation via updated UI state or toast message.');
    }
  }
  const block = lines.join('\n');
  if (docContent.includes('## Automated UI Sync Notes')) {
    return docContent.replace(/## Automated UI Sync Notes[\s\S]*$/m, block);
  }
  return `${docContent.trim()}\n\n${block}\n`;
};

const buildMockPatch = (docPath: string): string =>
  [
    `diff --git a/${docPath} b/${docPath}`,
    `--- a/${docPath}`,
    `+++ b/${docPath}`,
    '@@ -1,0 +1,1 @@',
    '+<!-- mock patch: generated locally without OpenAI -->',
  ].join('\n');

const formatDocTitleFromPath = (docPath: string): string => {
  const base = path.basename(docPath).replace(/\.md$/i, '');
  return base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ') || 'Feature';
};

const buildReleaseNotesSeed = (): string => {
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return [
    '# Release Notes',
    '',
    date,
    '',
    '## New Features',
    'Feature | Description | More Information',
    '--- | --- | ---',
  ].join('\n');
};

const buildFeatureDocSeed = (docPath: string): string => {
  const title = formatDocTitleFromPath(docPath);
  return [
    `# ${title}`,
    '',
    '## Overview',
    'Describe the feature, its use case, and its value proposition.',
    '',
    '## Configuration & Installation',
    'Document setup, prerequisites, environment variables, and dependencies.',
    '',
    '## API Documentation',
    'Document endpoints, request parameters, response schema, and examples.',
    '',
    '## Troubleshooting',
    'List common issues, error messages/codes, and resolution steps.',
  ].join('\n');
};

const buildSeedDocContent = (docPath: string): string => {
  if (/release-notes\.md$/i.test(docPath)) return buildReleaseNotesSeed();
  return buildFeatureDocSeed(docPath);
};

const buildCommentBody = (items: { docPath: string; patch: string; matchedFiles: string[] }[]): string => {
  const lines: string[] = [];
  lines.push('📝 AI doc suggestions');
  for (const item of items) {
    lines.push(`\n**${item.docPath}** (from ${item.matchedFiles.join(', ')})`);
    lines.push('```patch');
    lines.push(item.patch);
    lines.push('```');
    lines.push('Reply with `/apply-doc-patch` and keep this patch block to apply.');
  }
  return lines.join('\n');
};

interface TargetRunReport {
  docPath: string;
  matchedFiles: string[];
  status: 'generated' | 'skipped_invalid_patch' | 'fetch_failed' | 'skipped_no_change';
  reason?: string;
  strictRetry?: boolean;
  contentFallback?: boolean;
}

interface TargetDebugReport {
  docPath: string;
  matchedFiles: string[];
  combinedDiffChars: number;
  combinedDiffPreview: string;
  snippetChars?: number;
  promptChars?: number;
  promptPreview?: string;
  strictPromptChars?: number;
  strictPromptPreview?: string;
  fullDocPromptChars?: number;
  fullDocPromptPreview?: string;
  patchResponsePreview?: string;
  strictPatchResponsePreview?: string;
  fullDocResponsePreview?: string;
  contentPatchPreview?: string;
  replaceAllPatchUsed?: boolean;
  deterministicUiFallbackUsed?: boolean;
}

const main = async () => {
  const args = parseArgs();
  if (!args.docsRepo) throw new Error('docs repo is required (--docs-repo or DOCS_REPO env)');
  const docsRepo = args.docsRepo as string;
  const docsBranch = args.docsBranch || 'main';
  const docsMapPath = args.docsMapPath || 'docs-map.yaml';
  const outDir = args.outDir || 'suggestions';
  const diff = args.diffPath ? readFileSafe(args.diffPath) : undefined;
  if (!diff) throw new Error('diff is required; pass --diff path');
  const docsMap = loadDocsMap(docsMapPath);
  const fileDiffs = parseDiffFiles(diff);
  const changedFiles = Array.from(fileDiffs.keys());
  const targets = resolveTargets(changedFiles, docsMap);
  ensureDir(outDir);
  const runReport: {
    generatedAt: string;
    changedFiles: string[];
    targetCount: number;
    generatedPatchCount: number;
    note?: string;
    targets: TargetRunReport[];
  } = {
    generatedAt: new Date().toISOString(),
    changedFiles,
    targetCount: targets.length,
    generatedPatchCount: 0,
    targets: [],
  };
  const debugReport: {
    generatedAt: string;
    model: string;
    changedFiles: string[];
    targetCount: number;
    targets: TargetDebugReport[];
  } = {
    generatedAt: new Date().toISOString(),
    model: args.model || 'gpt-4o-mini',
    changedFiles,
    targetCount: targets.length,
    targets: [],
  };
  if (targets.length === 0) {
    console.log('No matching docs for changed files.');
    runReport.note = 'No docs-map targets matched changed files.';
    fs.writeFileSync(path.join(outDir, 'run-report.json'), JSON.stringify(runReport, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, 'llm-input-debug.json'), JSON.stringify(debugReport, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, 'suggestions.md'), 'No matching docs for changed files.\n', 'utf8');
    return;
  }

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const clientBundle = createClient(args);
  if (!args.mock && !clientBundle) {
    throw new Error('Missing LLM credentials: set AZURE_OPENAI_API_KEY (or OPENAI_API_KEY fallback), or use --mock');
  }

  const styleGuidePath = args.styleGuidePath || docsMap.style_guide;
  const styleGuide = styleGuidePath ? await fetchFileFromRepo(octokit, docsRepo, styleGuidePath, docsBranch) : undefined;

  const collected: { docPath: string; patch: string; matchedFiles: string[] }[] = [];

  for (const target of targets) {
    const targetDebug: TargetDebugReport = {
      docPath: target.docsPath,
      matchedFiles: target.matchedFiles,
      combinedDiffChars: 0,
      combinedDiffPreview: '',
    };
    let docContent = '';
    let docExists = true;
    const deletionOnlyTarget = target.matchedFiles.length > 0
      && target.matchedFiles.every((f) => isDeletedFileDiff(fileDiffs.get(f) || ''));
    const deleteTargetDoc = deletionOnlyTarget && !/release-notes\.md$/i.test(target.docsPath);
    try {
      docContent = await fetchFileFromRepo(octokit, docsRepo, target.docsPath, docsBranch);
    } catch (e) {
      const msg = (e as Error).message;
      if (deleteTargetDoc && /Not Found/i.test(msg)) {
        debugReport.targets.push(targetDebug);
        runReport.targets.push({
          docPath: target.docsPath,
          matchedFiles: target.matchedFiles,
          status: 'skipped_no_change',
          reason: 'Target doc already absent for delete-only code changes.',
        });
        console.log(`No doc deletion needed for ${target.docsPath}; file already absent.`);
        continue;
      }
      if (/Not Found/i.test(msg)) {
        docExists = false;
        docContent = buildSeedDocContent(target.docsPath);
      } else {
        debugReport.targets.push(targetDebug);
        runReport.targets.push({
          docPath: target.docsPath,
          matchedFiles: target.matchedFiles,
          status: 'fetch_failed',
          reason: msg,
        });
        console.warn(`Skipping ${target.docsPath}: ${msg}`);
        continue;
      }
    }
    const snippet = extractSection(docContent, target.anchor);
    const combinedDiff = target.matchedFiles.map((f) => fileDiffs.get(f) || '').join('\n');
    targetDebug.combinedDiffChars = combinedDiff.length;
    targetDebug.combinedDiffPreview = combinedDiff.slice(0, 1600);
    targetDebug.snippetChars = snippet.length;
    if (deleteTargetDoc && docExists) {
      const deletePatch = buildDeleteFilePatch(target.docsPath, docContent);
      targetDebug.contentPatchPreview = deletePatch.slice(0, 12000);
      const normalizedDeletePatch = normalizePatch(target.docsPath, docContent, deletePatch, true);
      debugReport.targets.push(targetDebug);
      writeSuggestionFiles(outDir, target.docsPath, normalizedDeletePatch);
      collected.push({ docPath: target.docsPath, patch: normalizedDeletePatch, matchedFiles: target.matchedFiles });
      runReport.targets.push({
        docPath: target.docsPath,
        matchedFiles: target.matchedFiles,
        status: 'generated',
        strictRetry: false,
        contentFallback: false,
      });
      continue;
    }
    let patch: string;
    let strictRetry = false;
    let contentFallback = !args.mock;
    if (args.mock) {
      patch = docExists ? buildMockPatch(target.docsPath) : buildNewFilePatch(target.docsPath, docContent);
    } else {
      if (!clientBundle) throw new Error('LLM client not initialized');
      try {
        const fullDocPrompt = buildFullDocPrompt({
          diff: combinedDiff,
          docPath: target.docsPath,
          docContent,
          styleGuide,
        });
        targetDebug.fullDocPromptChars = fullDocPrompt.length;
        targetDebug.fullDocPromptPreview = fullDocPrompt.slice(0, 12000);
        const full = await generateUpdatedDoc(clientBundle!.client, clientBundle!.model, fullDocPrompt, args.user);
        targetDebug.fullDocResponsePreview = full.raw.slice(0, 12000);
        const updatedDoc = full.doc;
        let contentPatch = docExists
          ? buildPatchFromContent(target.docsPath, docContent, updatedDoc)
          : buildNewFilePatch(target.docsPath, updatedDoc);
        if (!contentPatch) {
          if (!args.llmOnly && target.docsPath === 'docs/ui/home1.md') {
            const deterministicDoc = buildDeterministicUiDocUpdate(docContent, combinedDiff);
            const deterministicPatch = buildPatchFromContent(target.docsPath, docContent, deterministicDoc);
            if (deterministicPatch) {
              targetDebug.deterministicUiFallbackUsed = true;
              targetDebug.contentPatchPreview = deterministicPatch.slice(0, 12000);
              patch = normalizePatch(target.docsPath, docContent, deterministicPatch, docExists);
              debugReport.targets.push(targetDebug);
              writeSuggestionFiles(outDir, target.docsPath, patch);
              collected.push({ docPath: target.docsPath, patch, matchedFiles: target.matchedFiles });
              runReport.targets.push({
                docPath: target.docsPath,
                matchedFiles: target.matchedFiles,
                status: 'generated',
                strictRetry,
                contentFallback,
              });
              continue;
            }
          }
          debugReport.targets.push(targetDebug);
          runReport.targets.push({
            docPath: target.docsPath,
            matchedFiles: target.matchedFiles,
            status: 'skipped_no_change',
            reason: 'LLM full-doc generation produced no content changes.',
            strictRetry,
            contentFallback,
          });
          console.log(`No doc changes for ${target.docsPath} after LLM full-doc generation.`);
          continue;
        }
        if (docExists && !checkPatchApplicable(target.docsPath, docContent, contentPatch, docExists).ok) {
          const replaceAllPatch = buildReplaceAllPatch(target.docsPath, docContent, updatedDoc);
          if (!args.llmOnly && checkPatchApplicable(target.docsPath, docContent, replaceAllPatch, docExists).ok) {
            contentPatch = replaceAllPatch;
            targetDebug.replaceAllPatchUsed = true;
          }
        }
        targetDebug.contentPatchPreview = contentPatch.slice(0, 12000);
        patch = normalizePatch(target.docsPath, docContent, contentPatch, docExists);
      } catch (e) {
        if (!args.llmOnly && target.docsPath === 'docs/ui/home1.md') {
          try {
            const deterministicDoc = buildDeterministicUiDocUpdate(docContent, combinedDiff);
            const deterministicPatch = buildPatchFromContent(target.docsPath, docContent, deterministicDoc);
            if (deterministicPatch) {
              targetDebug.deterministicUiFallbackUsed = true;
              targetDebug.contentPatchPreview = deterministicPatch.slice(0, 12000);
              patch = normalizePatch(target.docsPath, docContent, deterministicPatch, docExists);
              debugReport.targets.push(targetDebug);
              writeSuggestionFiles(outDir, target.docsPath, patch);
              collected.push({ docPath: target.docsPath, patch, matchedFiles: target.matchedFiles });
              runReport.targets.push({
                docPath: target.docsPath,
                matchedFiles: target.matchedFiles,
                status: 'generated',
                strictRetry,
                contentFallback,
              });
              continue;
            }
          } catch (detErr) {
            targetDebug.deterministicUiFallbackUsed = true;
            targetDebug.contentPatchPreview = `deterministic-ui-fallback-error: ${(detErr as Error).message}`;
          }
        }
        debugReport.targets.push(targetDebug);
        console.warn(`Skipping ${target.docsPath}: ${(e as Error).message}`);
        runReport.targets.push({
          docPath: target.docsPath,
          matchedFiles: target.matchedFiles,
          status: 'skipped_invalid_patch',
          reason: (e as Error).message,
          strictRetry,
          contentFallback,
        });
        continue;
      }
    }
    debugReport.targets.push(targetDebug);
    writeSuggestionFiles(outDir, target.docsPath, patch);
    collected.push({ docPath: target.docsPath, patch, matchedFiles: target.matchedFiles });
    runReport.targets.push({
      docPath: target.docsPath,
      matchedFiles: target.matchedFiles,
      status: 'generated',
      strictRetry,
      contentFallback,
    });
  }
  runReport.generatedPatchCount = collected.length;
  fs.writeFileSync(path.join(outDir, 'run-report.json'), JSON.stringify(runReport, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'llm-input-debug.json'), JSON.stringify(debugReport, null, 2), 'utf8');

  if (collected.length === 0) {
    console.log('No valid doc patches generated.');
    fs.writeFileSync(path.join(outDir, 'suggestions.md'), 'No valid doc patches generated.\n', 'utf8');
    return;
  }

  const summaryMd = buildCommentBody(collected);
  fs.writeFileSync(path.join(outDir, 'suggestions.md'), summaryMd, 'utf8');
  console.log(`Suggestions written to ${outDir}`);

  if (args.commentPr && args.codeRepo) {
    const [owner, repo] = args.codeRepo.split('/');
    await octokit.issues.createComment({ owner, repo, issue_number: Number(args.commentPr), body: summaryMd });
    console.log(`Comment posted to PR #${args.commentPr} in ${args.codeRepo}`);
  }
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
