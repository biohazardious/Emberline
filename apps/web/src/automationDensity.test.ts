// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MCP_SERVERS, DEFAULT_SKILL_PLUGINS, FactorySettings } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AutopilotSection } from './components/settings/AutopilotSection';
import { McpPluginsSection } from './components/settings/McpPluginsSection';
import { autopilotDraftFrom } from './components/settings/settingsDraft';
import { cleanup, renderDom } from './domRender';
import { visibleWordCount } from './uxDensity';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 0.9.3 default-render visible word counts measured with `visibleWordCount(container)`
 * before the M6 redesign (AC-6.5: at most 60% of 0.9.3 baseline words).
 */
export const AUTOMATION_093_BASELINE_WORDS = 635;
export const MCP_PLUGINS_093_BASELINE_WORDS = 520;
export const AUTOMATION_WORD_BUDGET_RATIO = 0.6;

afterEach(cleanup);

function makeSettings(): FactorySettings {
  const defaultChain = [{ agent: 'claude' as const, model: 'opus' as const, credential: 'login' as const }];
  return FactorySettings.parse({
    personaAgents: {},
    personaRoutes: {
      product_owner: defaultChain,
      architect: defaultChain,
      ui_ux: defaultChain,
      coder: defaultChain,
      dba: defaultChain,
      qa: defaultChain,
      security: defaultChain,
    },
  });
}

describe('AC-6.5 Settings → Automation and MCP and skills density budget (<= 60% of 0.9.3 words)', () => {
  it('keeps Automation default view at or below 60% of 0.9.3 words', async () => {
    const settings = makeSettings();
    const view = await renderDom(
      createElement(AutopilotSection, {
        settings,
        theme: 'dark',
        onChangeTheme: () => undefined,
        draft: autopilotDraftFrom(settings),
        onChangeDraft: () => undefined,
        saving: false,
        onSave: () => undefined,
      }),
    );

    const words = visibleWordCount(view.container);
    const budget = Math.floor(AUTOMATION_093_BASELINE_WORDS * AUTOMATION_WORD_BUDGET_RATIO);
    expect(words).toBeLessThanOrEqual(budget);
  });

  it('keeps MCP and skills default view at or below 60% of 0.9.3 words', async () => {
    const view = await renderDom(
      createElement(McpPluginsSection, {
        mcpServers: DEFAULT_MCP_SERVERS,
        skillPlugins: DEFAULT_SKILL_PLUGINS,
        saving: false,
        onChangeMcpServers: () => undefined,
        onChangeSkillPlugins: () => undefined,
        onSave: () => undefined,
      }),
    );

    const words = visibleWordCount(view.container);
    const budget = Math.floor(MCP_PLUGINS_093_BASELINE_WORDS * AUTOMATION_WORD_BUDGET_RATIO);
    expect(words).toBeLessThanOrEqual(budget);
  });

  it('enforces concise labels, one-sentence summaries, and no &/+ chains or parenthesised sub-titles in headings and Automation labels', async () => {
    const settings = makeSettings();
    const autoView = await renderDom(
      createElement(AutopilotSection, {
        settings,
        theme: 'dark',
        onChangeTheme: () => undefined,
        draft: autopilotDraftFrom(settings),
        onChangeDraft: () => undefined,
        saving: false,
        onSave: () => undefined,
      }),
    );

    const headings = [...autoView.container.querySelectorAll('h1, h2, h3')].map(
      (h) => h.textContent?.trim() ?? '',
    );
    for (const heading of headings) {
      expect(heading).not.toContain('&');
      expect(heading).not.toContain('+');
      expect(heading).not.toContain('(');
    }

    const labels = [...autoView.container.querySelectorAll('.ui-setting-label')].map(
      (l) => l.textContent?.trim() ?? '',
    );
    expect(labels).toHaveLength(16);
    for (const label of labels) {
      expect(label.split(/\s+/).length).toBeLessThanOrEqual(5);
      expect(label).not.toContain('&');
      expect(label).not.toContain('+');
      // Only the 2-letter unit (GB) is permitted in parentheses; no multi-word parenthesised subtitles
      expect(label).not.toMatch(/\([^)]*\s[^)]*\)/);
    }

    const summaries = [...autoView.container.querySelectorAll('.ui-setting-summary')].map(
      (s) => s.textContent?.trim() ?? '',
    );
    expect(summaries).toHaveLength(16);
    for (const summary of summaries) {
      // At most one sentence (no internal sentence break followed by another sentence)
      expect(summary).not.toMatch(/[.!?]\s+[A-Z]/);
    }
  });

  it('enforces token-only colours, >= 0.8rem font sizes, zero inline styles, and < 450 lines in target files', () => {
    const css = readFileSync(resolve(HERE, 'components/settings/settings-sections.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/font-size:\s*[0-9.]+px/);
    const fontSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const rem of fontSizes) {
      expect(rem).toBeGreaterThanOrEqual(0.8);
    }

    const targetFiles = [
      'components/settings/AutopilotSection.tsx',
      'components/settings/McpPluginsSection.tsx',
      'components/settings/SkillPluginsSection.tsx',
      'components/settings/automation/QueueAndGatesSection.tsx',
      'components/settings/automation/MergingAndCommitSection.tsx',
      'components/settings/automation/McpServerRow.tsx',
      'components/settings/automation/SkillPluginRow.tsx',
    ];
    for (const rel of targetFiles) {
      const src = readFileSync(resolve(HERE, rel), 'utf8');
      expect(src, `${rel} must not contain inline styles`).not.toContain('style={{');
      expect(src, `${rel} must not contain style= props`).not.toContain('style={');
      expect(src.split('\n').length, `${rel} must stay under 450 lines`).toBeLessThan(450);
    }
  });
});
