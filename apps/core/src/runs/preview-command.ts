import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The dev/preview command a workspace's package.json offers (`dev`, then `start`, then `preview`). */
export function detectPreviewCommand(workspacePath: string): string | null {
  const pkgFile = path.join(workspacePath, 'package.json');
  if (!existsSync(pkgFile)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const hasPnpmLock = existsSync(path.join(workspacePath, 'pnpm-lock.yaml'));
    const runner = hasPnpmLock ? 'pnpm' : 'npm run';
    if (pkg.scripts?.dev) return `${runner} dev`;
    if (pkg.scripts?.start) return `${runner} start`;
    if (pkg.scripts?.preview) return `${runner} preview`;
  } catch {
    // ignore invalid package.json
  }
  return null;
}
