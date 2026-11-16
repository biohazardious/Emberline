import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

const BANNED_HEADING_WORDS = ['Studio', 'Hub', 'Matrix', 'Multiplexer', 'Control Center'] as const;

const M6_CSS_FILES = [
  'ui.css',
  'components/board/board-ux.css',
  'components/codeExplorer/code-explorer.css',
  'components/docker/docker-ux.css',
  'components/fleet/fleet-ux.css',
  'components/liveBrowser/live-browser.css',
  'components/project-settings-ux.css',
  'components/projectStatus/project-status.css',
  'components/roadmap/roadmap-ux.css',
  'components/runInspector/run-inspector.css',
  'components/settings/providers/providers.css',
  'components/settings/settings-panels.css',
  'components/settings/settings-sections.css',
  'components/sidebar/sidebar.css',
  'components/wizard/wizard-ux.css',
  'pages/build-outputs-ux.css',
  'pages/dashboard-ux.css',
  'pages/inbox-ux.css',
] as const;

function walkFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkFiles(full, ext));
    } else if (full.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

function findSmallInlineFontSizes(source: string): string[] {
  const violations: string[] = [];
  for (const match of source.matchAll(/fontSize\s*:\s*['"]([0-9.]+)(rem|px)['"]/g)) {
    const value = Number.parseFloat(match[1] ?? '');
    const unit = match[2];
    if (unit === 'rem' && value < 0.8) {
      violations.push(match[0]);
    } else if (unit === 'px' && value < 12.8) {
      violations.push(match[0]);
    }
  }
  return violations;
}

function findBannedHeadingWords(text: string): string[] {
  const hits: string[] = [];
  for (const word of BANNED_HEADING_WORDS) {
    const pattern = new RegExp(`\\b${word.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (pattern.test(text)) {
      hits.push(word);
    }
  }
  return hits;
}

describe('AC-6.7 & AC-6.6 source guards (uxCopy)', () => {
  const tsxFiles = walkFiles(SRC_ROOT, '.tsx');

  it('finds no inline fontSize below 0.8rem in apps/web/src/**/*.tsx', () => {
    const violations: string[] = [];
    for (const file of tsxFiles) {
      const source = readFileSync(file, 'utf8');
      for (const hit of findSmallInlineFontSizes(source)) {
        violations.push(`${relative(SRC_ROOT, file)}: ${hit}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('finds no hex colour and no font-size below 0.8rem in M6 CSS files', () => {
    const hexViolations: string[] = [];
    const fontSizeViolations: string[] = [];

    for (const rel of M6_CSS_FILES) {
      const full = resolve(SRC_ROOT, rel);
      const css = readFileSync(full, 'utf8');

      for (const hex of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        hexViolations.push(`${rel}: ${hex[0]}`);
      }

      for (const px of css.matchAll(/font-size:\s*[0-9.]+px/g)) {
        fontSizeViolations.push(`${rel}: ${px[0]}`);
      }

      for (const rem of css.matchAll(/font-size:\s*([0-9.]+)rem/g)) {
        const value = Number.parseFloat(rem[1] ?? '');
        if (value < 0.8) {
          fontSizeViolations.push(`${rel}: ${rem[0]}`);
        }
      }
    }

    expect(hexViolations).toEqual([]);
    expect(fontSizeViolations).toEqual([]);
  });

  it('ensures no page file declares more than one h1 or PageHeader', () => {
    const pageFiles = walkFiles(resolve(SRC_ROOT, 'pages'), '.tsx');
    const violations: string[] = [];

    for (const file of pageFiles) {
      const source = readFileSync(file, 'utf8');
      const h1Matches = source.match(/<h1[\s>]/g) ?? [];
      const pageHeaderMatches = source.match(/<PageHeader[\s>]/g) ?? [];
      const total = h1Matches.length + pageHeaderMatches.length;
      if (total > 1) {
        violations.push(`${relative(SRC_ROOT, file)}: found ${total} h1/PageHeader elements`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('ensures no heading, PageHeader title or nav/tab label uses banned marketing words', () => {
    const violations: string[] = [];

    for (const file of tsxFiles) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC_ROOT, file);

      for (const m of source.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)) {
        const hits = findBannedHeadingWords(m[1] ?? '');
        if (hits.length > 0) violations.push(`${rel} <h1>: ${hits.join(', ')}`);
      }

      for (const m of source.matchAll(/<PageHeader\b[^>]*\btitle=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) {
        const rawTitle = m[1] ?? m[2] ?? m[3] ?? '';
        const hits = findBannedHeadingWords(rawTitle);
        if (hits.length > 0) violations.push(`${rel} <PageHeader>: ${hits.join(', ')}`);
      }

      if (rel.includes('SidebarNav.tsx') || rel.includes('SettingsPage.tsx')) {
        for (const m of source.matchAll(/\blabel:\s*['"]([^'"]+)['"]/g)) {
          const hits = findBannedHeadingWords(m[1] ?? '');
          if (hits.length > 0) violations.push(`${rel} label: ${hits.join(', ')}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
