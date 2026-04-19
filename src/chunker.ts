/**
 * Extracts a specific section from a Markdown document based on an anchor heading.
 * Returns the text before the section, the section itself, and the text after.
 */
export const extractMarkdownSection = (
  content: string,
  anchor?: string
): { before: string; section: string; after: string; found: boolean } => {
  if (!anchor) {
    return { before: '', section: content, after: '', found: false };
  }

  const lines = content.split(/\r?\n/);
  const targetHeading = anchor.replace(/^#+\s*/, '').trim().toLowerCase();
  
  let startIdx = -1;
  let endIdx = -1;
  let targetLevel = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.*)/);
    
    if (match) {
      const level = match[1].length;
      const headingText = match[2].trim().toLowerCase();
      
      if (startIdx === -1) {
        if (headingText === targetHeading) {
          startIdx = i;
          targetLevel = level;
        }
      } else {
        // We are currently inside the section.
        // A section ends when we encounter a heading of the SAME or HIGHER level.
        // (e.g., if target is ## (level 2), a ### (level 3) is a subsection, but a ## (level 2) or # (level 1) ends it)
        if (level <= targetLevel) {
          endIdx = i;
          break;
        }
      }
    }
  }

  if (startIdx === -1) {
    // Anchor not found
    return { before: '', section: content, after: '', found: false };
  }

  if (endIdx === -1) {
    // Section goes to the end of the file
    endIdx = lines.length;
  }

  const before = lines.slice(0, startIdx).join('\n');
  const section = lines.slice(startIdx, endIdx).join('\n');
  const after = lines.slice(endIdx).join('\n');

  return { before, section, after, found: true };
};
