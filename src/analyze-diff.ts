export const parseDiffFiles = (diff: string): Map<string, string> => {
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

export const isDeletedFileDiff = (fileDiff: string): boolean => {
  if (!fileDiff) return false;
  if (/^deleted file mode\s+/m.test(fileDiff)) return true;
  if (/^---\s+a\/.+$/m.test(fileDiff) && /^\+\+\+\s+\/dev\/null$/m.test(fileDiff)) return true;
  return false;
};
