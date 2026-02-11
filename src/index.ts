import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { Octokit } from '@octokit/rest';
import minimatch from 'minimatch';
import OpenAI from 'openai';

interface DocsMapMapping {
  code: string;
  docs: string;
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
  return {
    diffPath: get('--diff'),
    docsMapPath: get('--docs-map', 'docs-map.yaml'),
    docsRepo: get('--docs-repo') || process.env.DOCS_REPO,
    docsBranch: get('--docs-branch', process.env.DOCS_BRANCH || 'main'),
    outDir: get('--out-dir', 'suggestions'),
    commentPr: get('--comment-pr'),
    codeRepo: get('--code-repo'),
    styleGuidePath: get('--style-guide'),
    verbose: has('--verbose'),
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

const resolveTargets = (files: string[], map: DocsMap): TargetDoc[] => {
  const targets: TargetDoc[] = [];
  for (const m of map.mappings) {
    const matched = files.filter((f) => minimatch(f, m.code, { dot: true }));
    if (matched.length === 0) continue;
    targets.push({ docsPath: m.docs, anchor: m.anchor, matchedFiles: matched });
  }
  return targets;
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

const generatePatch = async (client: OpenAI, prompt: string): Promise<string> => {
  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'You generate minimal documentation patches from code diffs.' },
      { role: 'user', content: prompt },
    ],
  });
  const text = completion.choices[0].message.content || '';
  const match = text.match(/```patch\n([\s\S]*?)```/);
  return match ? match[1].trim() : text.trim();
};

const ensureDir = (p: string) => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
};

const writeSuggestionFiles = (outDir: string, docPath: string, patch: string, rationale?: string) => {
  ensureDir(outDir);
  const safeName = docPath.replace(/[\\/]/g, '__');
  fs.writeFileSync(path.join(outDir, `${safeName}.patch`), patch, 'utf8');
  if (rationale) fs.writeFileSync(path.join(outDir, `${safeName}.txt`), rationale, 'utf8');
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

const main = async () => {
  const args = parseArgs();
  if (!args.docsRepo) throw new Error('docs repo is required (--docs-repo or DOCS_REPO env)');
  const diff = args.diffPath ? readFileSafe(args.diffPath) : undefined;
  if (!diff) throw new Error('diff is required; pass --diff path');
  const docsMap = loadDocsMap(args.docsMapPath);
  const fileDiffs = parseDiffFiles(diff);
  const changedFiles = Array.from(fileDiffs.keys());
  const targets = resolveTargets(changedFiles, docsMap);
  if (targets.length === 0) {
    console.log('No matching docs for changed files.');
    return;
  }

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) throw new Error('OPENAI_API_KEY missing');
  const client = new OpenAI({ apiKey: openaiApiKey });

  const styleGuidePath = args.styleGuidePath || docsMap.style_guide;
  const styleGuide = styleGuidePath ? await fetchFileFromRepo(octokit, args.docsRepo, styleGuidePath, args.docsBranch) : undefined;

  ensureDir(args.outDir);
  const collected: { docPath: string; patch: string; matchedFiles: string[] }[] = [];

  for (const target of targets) {
    const docContent = await fetchFileFromRepo(octokit, args.docsRepo, target.docsPath, args.docsBranch);
    const snippet = extractSection(docContent, target.anchor);
    const combinedDiff = target.matchedFiles.map((f) => fileDiffs.get(f) || '').join('\n');
    const prompt = buildPrompt({ diff: combinedDiff, docPath: target.docsPath, docContent: snippet, styleGuide });
    if (args.verbose) console.log(`\nPrompt for ${target.docsPath}:\n${prompt}\n`);
    const patch = await generatePatch(client, prompt);
    writeSuggestionFiles(args.outDir, target.docsPath, patch);
    collected.push({ docPath: target.docsPath, patch, matchedFiles: target.matchedFiles });
  }

  const summaryMd = buildCommentBody(collected);
  fs.writeFileSync(path.join(args.outDir, 'suggestions.md'), summaryMd, 'utf8');
  console.log(`Suggestions written to ${args.outDir}`);

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
