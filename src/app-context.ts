import fs from 'fs';
import path from 'path';
import { AppContextFile, AppContextSummary } from './types.js';

const MAX_FILE_CHARS = 2400;
const MAX_TOTAL_CHARS = 9000;

const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

const truncate = (value: string, maxChars: number): string =>
  value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;

const isLikelySourceFile = (filePath: string): boolean =>
  /\.(ts|tsx|js|jsx|json|ya?ml|md|mdx|txt|sh)$/i.test(filePath);

const canonicalRepoFiles = [
  'README.md',
  'package.json',
  'tsconfig.json',
  'docs-map.yaml',
  'docs-map.example.yaml',
  'SEA-API.json',
];

const extractRelevantExcerpt = (content: string): string => {
  const lines = content.split(/\r?\n/);
  const picked = lines.filter((line) => {
    const trimmed = line.trim();
    return (
      /^#{1,6}\s+/.test(trimmed) ||
      /^\s*(export|interface|type|const|function|class)\b/.test(trimmed) ||
      /^\s*"(name|version|description|scripts|dependencies|paths|openapi|swagger)"/.test(trimmed) ||
      /^\s*-\s+/.test(trimmed)
    );
  });
  const pool = picked.length > 0 ? picked : lines.filter((line) => line.trim()).slice(0, 40);
  return truncate(pool.join('\n'), MAX_FILE_CHARS);
};

const existingFile = (rootDir: string, relativePath: string): string | undefined => {
  const absolutePath = path.resolve(rootDir, relativePath);
  if (!fs.existsSync(absolutePath)) return undefined;
  if (!fs.statSync(absolutePath).isFile()) return undefined;
  return absolutePath;
};

const gatherSiblingFiles = (rootDir: string, changedFile: string): string[] => {
  const absolutePath = path.resolve(rootDir, changedFile);
  if (!fs.existsSync(absolutePath)) return [];
  if (!fs.statSync(absolutePath).isFile()) return [];
  const dirPath = path.dirname(absolutePath);
  const basename = path.basename(changedFile, path.extname(changedFile)).toLowerCase();
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .filter((candidate) => candidate !== absolutePath && isLikelySourceFile(candidate))
    .filter((candidate) => {
      const name = path.basename(candidate, path.extname(candidate)).toLowerCase();
      return name.includes(basename) || basename.includes(name) || ['index', 'types', 'schema', 'config'].includes(name);
    })
    .slice(0, 2);
};

export const collectAppContext = (rootDir: string, changedFiles: string[]): AppContextSummary | undefined => {
  const candidates = new Map<string, string>();

  for (const relativePath of canonicalRepoFiles) {
    const absolutePath = existingFile(rootDir, relativePath);
    if (absolutePath) candidates.set(absolutePath, 'canonical repo file');
  }

  for (const changedFile of changedFiles) {
    const absolutePath = existingFile(rootDir, changedFile);
    if (absolutePath && isLikelySourceFile(absolutePath)) {
      candidates.set(absolutePath, 'changed file');
    }
    for (const sibling of gatherSiblingFiles(rootDir, changedFile)) {
      if (!candidates.has(sibling)) candidates.set(sibling, 'related nearby file');
    }
  }

  const files: AppContextFile[] = [];
  for (const [absolutePath, reason] of candidates) {
    const content = fs.readFileSync(absolutePath, 'utf8');
    files.push({
      path: path.relative(rootDir, absolutePath),
      reason,
      excerpt: extractRelevantExcerpt(content),
    });
  }

  if (files.length === 0) return undefined;

  const lines: string[] = [];
  for (const file of files) {
    lines.push(`App context: ${file.path} (${file.reason})`);
    lines.push(file.excerpt);
    lines.push('');
    if (lines.join('\n').length >= MAX_TOTAL_CHARS) break;
  }

  return {
    files: unique(files.map((file) => JSON.stringify(file))).map((item) => JSON.parse(item) as AppContextFile),
    combinedSummary: truncate(lines.join('\n').trim(), MAX_TOTAL_CHARS),
  };
};
