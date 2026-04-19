import fs from 'fs';
import path from 'path';
import { SupplementalContextItem, SupplementalContextSummary } from './types.js';

const MAX_ITEM_CHARS = 4000;
const MAX_TOTAL_SUMMARY_CHARS = 8000;

const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

const listFilesRecursive = (dirPath: string): string[] => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
};

const truncate = (value: string, maxChars: number): string =>
  value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;

const extractExcerpt = (content: string): string => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const interesting = lines.filter((line) => /^#{1,6}\s+/.test(line) || /^[*-]\s+/.test(line) || /^\d+\.\s+/.test(line));
  const pool = interesting.length > 0 ? interesting : lines;
  return truncate(pool.slice(0, 24).join('\n'), 1200);
};

const isLikelyContextFile = (filePath: string): boolean =>
  /\.(md|mdx|txt|rst|adoc|json|ya?ml)$/i.test(filePath);

export const loadSupplementalContext = (contextFiles: string[], contextDirs: string[]): SupplementalContextSummary | undefined => {
  const expandedFiles = [
    ...contextFiles,
    ...contextDirs.flatMap((dirPath) => listFilesRecursive(dirPath).filter(isLikelyContextFile)),
  ];
  const normalizedFiles = unique(expandedFiles.map((filePath) => path.resolve(filePath)));
  const items: SupplementalContextItem[] = [];
  for (const filePath of normalizedFiles) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`context file not found: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    items.push({
      path: filePath,
      label: path.basename(filePath),
      content: truncate(content, MAX_ITEM_CHARS),
      excerpt: extractExcerpt(content),
    });
  }
  if (items.length === 0) return undefined;
  const combinedLines: string[] = [];
  for (const item of items) {
    combinedLines.push(`Context: ${item.label} (${item.path})`);
    combinedLines.push(item.excerpt);
    combinedLines.push('');
    if (combinedLines.join('\n').length >= MAX_TOTAL_SUMMARY_CHARS) break;
  }
  return {
    items,
    combinedSummary: truncate(combinedLines.join('\n').trim(), MAX_TOTAL_SUMMARY_CHARS),
  };
};
