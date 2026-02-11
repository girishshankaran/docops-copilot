import { execSync } from 'child_process';
import fs from 'fs';

const patchPath = process.argv[2];
if (!patchPath) {
  console.error('Usage: ts-node src/apply-patch.ts <patch-file>');
  process.exit(1);
}
if (!fs.existsSync(patchPath)) {
  console.error(`Patch file not found: ${patchPath}`);
  process.exit(1);
}
try {
  execSync(`git apply ${patchPath}`, { stdio: 'inherit' });
} catch (err) {
  console.error('git apply failed');
  process.exit(1);
}
