import path from 'path';
import { Octokit } from '@octokit/rest';
import { minimatch } from 'minimatch';
import { AppContextSummary, DocsMap, DocsMapDocEntry, PlanningResult, RepoDocFile, SupplementalContextSummary, TargetDoc } from './types.js';

const tokenize = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

const buildContextTerms = (supplementalContext?: SupplementalContextSummary, appContext?: AppContextSummary): string[] => {
  const collected = [
    ...(supplementalContext?.items.flatMap((item) => [
      ...tokenize(item.label),
      ...tokenize(item.excerpt),
    ]) || []),
    ...(appContext?.files.flatMap((file) => [
      ...tokenize(file.path),
      ...tokenize(file.excerpt),
    ]) || []),
  ];
  return unique(collected).filter((term) => !['context', 'document', 'feature', 'requirements'].includes(term)).slice(0, 60);
};

const extractHeadings = (content: string): string[] =>
  content
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean);

export const resolveTargets = (files: string[], map: DocsMap): TargetDoc[] => {
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
        byDoc.set(key, {
          docsPath: entry.path,
          anchor: entry.anchor,
          matchedFiles: Array.from(new Set(matched)),
          source: 'mapped',
          rationale: `Matched docs-map pattern ${m.code}`,
        });
      } else {
        existing.matchedFiles = Array.from(new Set([...existing.matchedFiles, ...matched]));
      }
    }
  }
  return Array.from(byDoc.values());
};

const applyOfflineDocState = (targets: TargetDoc[], offlineDocs?: boolean): TargetDoc[] =>
  offlineDocs ? targets.map((target) => ({ ...target, docExists: false })) : targets;

const scoreDocMatch = (filePath: string, doc: RepoDocFile, contextTerms: string[]): number => {
  const fileTokens = unique(tokenize(filePath));
  const docTokenSet = new Set(doc.tokens);
  let score = 0;
  for (const token of fileTokens) {
    if (docTokenSet.has(token)) score += 2;
  }
  for (const term of contextTerms) {
    if (docTokenSet.has(term)) score += 1;
  }
  const basename = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const normalizedDocPath = doc.path.toLowerCase();
  if (basename && normalizedDocPath.includes(basename)) score += 3;
  if (/release-notes\.md$/i.test(doc.path)) score += 1;
  if (/troubleshooting/i.test(doc.path) && /error|exception|troubleshoot/i.test(filePath)) score += 1;
  return score;
};

const inferDocPathForFile = (filePath: string, contextTerms: string[]): string[] => {
  const normalized = filePath.replace(/\\/g, '/');
  const basename = path.basename(normalized, path.extname(normalized)).toLowerCase();
  const name = basename === 'index' ? path.basename(path.dirname(normalized)).toLowerCase() || 'overview' : basename || 'overview';
  if (normalized.startsWith('src/api/')) {
    return [`docs/api/${name}.md`, 'docs/api.md', 'docs/release-notes.md'];
  }
  if (normalized.startsWith('src/')) {
    return [`docs/features/${name}.md`, `docs/${name}.md`, 'docs/release-notes.md'];
  }
  if (normalized.startsWith('cli/')) {
    return ['docs/cli.md', `docs/cli/${name}.md`, 'docs/release-notes.md'];
  }
  if (normalized.startsWith('config/')) {
    return ['docs/configuration.md', `docs/config/${name}.md`, 'docs/release-notes.md'];
  }
  if (normalized.startsWith('ui/')) {
    return [`docs/ui/${name}.md`, 'docs/ui.md', 'docs/release-notes.md'];
  }
  return [`docs/features/${name}.md`, `docs/${name}.md`, 'docs/release-notes.md'];
};

const listMarkdownFilesFromRepo = async (octokit: Octokit, repo: string, ref: string): Promise<string[]> => {
  const [owner, repoName] = repo.split('/');
  const branch = await octokit.repos.getBranch({ owner, repo: repoName, branch: ref });
  const tree = await octokit.git.getTree({
    owner,
    repo: repoName,
    tree_sha: branch.data.commit.sha,
    recursive: 'true',
  });
  return (tree.data.tree || [])
    .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string' && /\.md$/i.test(entry.path))
    .map((entry) => entry.path as string)
    .sort();
};

const buildRepoDocIndex = async (
  octokit: Octokit,
  repo: string,
  ref: string,
  docsPaths: string[],
  fetchFileFromRepo: (octokit: Octokit, repo: string, filePath: string, ref: string) => Promise<string>,
): Promise<RepoDocFile[]> => {
  const files: RepoDocFile[] = [];
  for (const docsPath of docsPaths) {
    try {
      const content = await fetchFileFromRepo(octokit, repo, docsPath, ref);
      const headings = extractHeadings(content);
      files.push({
        path: docsPath,
        headings,
        tokens: unique([...tokenize(docsPath), ...headings.flatMap((heading) => tokenize(heading))]),
      });
    } catch {
      // Ignore transient fetch failures during indexing; target fetch still happens later.
    }
  }
  return files;
};

const inferTargetsFromRepo = (
  files: string[],
  indexedDocs: RepoDocFile[],
  docsRepoEmpty: boolean,
  supplementalContext?: SupplementalContextSummary,
  appContext?: AppContextSummary,
): TargetDoc[] => {
  const byDoc = new Map<string, TargetDoc>();
  const contextTerms = buildContextTerms(supplementalContext, appContext);
  const addTarget = (docsPath: string, matchedFile: string, rationale: string, docExists: boolean) => {
    const existing = byDoc.get(docsPath);
    if (!existing) {
      byDoc.set(docsPath, {
        docsPath,
        matchedFiles: [matchedFile],
        source: 'inferred',
        docExists,
        rationale,
      });
      return;
    }
    existing.matchedFiles = unique([...existing.matchedFiles, matchedFile]);
    existing.rationale = existing.rationale === rationale ? rationale : `${existing.rationale}; ${rationale}`;
  };

  for (const filePath of files) {
    const ranked = indexedDocs
      .map((doc) => ({ doc, score: scoreDocMatch(filePath, doc, contextTerms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    if (ranked.length > 0) {
      for (const item of ranked) {
        addTarget(
          item.doc.path,
          filePath,
          `Inferred from existing docs index${contextTerms.length > 0 ? ' with supplemental context' : ''} (score ${item.score})`,
          true,
        );
      }
      continue;
    }
    const inferredPaths = inferDocPathForFile(filePath, contextTerms);
    for (const docsPath of inferredPaths.slice(0, 1)) {
      addTarget(
        docsPath,
        filePath,
        docsRepoEmpty
          ? `Docs repo is empty; bootstrapping inferred doc target${contextTerms.length > 0 ? ' using supplemental context terms' : ''}.`
          : `No matching docs found; using inferred fallback path${contextTerms.length > 0 ? ' informed by supplemental context' : ''}.`,
        false,
      );
    }
  }

  return Array.from(byDoc.values());
};

export const planTargets = async (params: {
  changedFiles: string[];
  docsMap?: DocsMap;
  docsMapPath: string;
  docsRepo: string;
  docsBranch: string;
  octokit: Octokit;
  targetMode: string;
  supplementalContext?: SupplementalContextSummary;
  appContext?: AppContextSummary;
  offlineDocs?: boolean;
  fetchFileFromRepo: (octokit: Octokit, repo: string, filePath: string, ref: string) => Promise<string>;
}): Promise<PlanningResult> => {
  const {
    changedFiles,
    docsMap,
    docsMapPath,
    docsRepo,
    docsBranch,
    octokit,
    targetMode,
    supplementalContext,
    appContext,
    offlineDocs,
    fetchFileFromRepo,
  } = params;
  const docsFiles = offlineDocs ? [] : await listMarkdownFilesFromRepo(octokit, docsRepo, docsBranch);
  const docsRepoEmpty = docsFiles.length === 0;
  const normalizedMode = String(targetMode || 'auto').toLowerCase();

  if (normalizedMode === 'map') {
    if (!docsMap) throw new Error(`docs-map not found at ${docsMapPath}`);
    return {
      targets: applyOfflineDocState(resolveTargets(changedFiles, docsMap), offlineDocs),
      usedDocsMap: true,
      docsRepoEmpty,
      styleGuidePath: docsMap.style_guide,
    };
  }

  if (normalizedMode === 'auto' && docsMap) {
    const mappedTargets = resolveTargets(changedFiles, docsMap);
    if (mappedTargets.length > 0) {
      return {
        targets: applyOfflineDocState(mappedTargets, offlineDocs),
        usedDocsMap: true,
        docsRepoEmpty,
        styleGuidePath: docsMap.style_guide,
        note: 'Using docs-map targets.',
      };
    }
  }

  const indexedDocs = offlineDocs
    ? []
    : await buildRepoDocIndex(octokit, docsRepo, docsBranch, docsFiles, fetchFileFromRepo);
  return {
    targets: inferTargetsFromRepo(changedFiles, indexedDocs, docsRepoEmpty, supplementalContext, appContext),
    usedDocsMap: false,
    docsRepoEmpty,
    styleGuidePath: docsMap?.style_guide,
    note: docsRepoEmpty
      ? `Docs repo is empty; using inferred bootstrap targets${supplementalContext || appContext ? ' with available context' : ''}.`
      : `Using inferred doc targets from docs repo index${supplementalContext || appContext ? ' with context bias' : ''}.`,
  };
};
