import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COPILOT_MODELS_SCRIPT,
  listCommandsFor,
  parseAgyModels,
  parseCodexModels,
  parseCopilotModels,
} from './list-command.js';
import { PickerParseError } from './parsers/errors.js';

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = read('agy-models.txt');

describe('parseAgyModels', () => {
  it('parses the captured listing', () => {
    const models = parseAgyModels(fixture);
    expect(models).toHaveLength(22);
    expect(models[0]).toEqual({ id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)' });
  });

  it('drops invalid ids, blanks and duplicates, and tolerates CRLF', () => {
    const text = 'Fetching available models...\r\nbad id\tX\r\n$(rm)\tX\r\n\r\na-1\tOne\r\na-1\tAgain\r\n';
    expect(parseAgyModels(text)).toEqual([{ id: 'a-1', label: 'One' }]);
  });
});

describe('parseCodexModels', () => {
  // The capture (codex-cli 0.169.0, free ChatGPT account) with its long per-model prompts left out.
  // The CLI prints it on one line.
  const capture = JSON.stringify(JSON.parse(read('codex-debug-models-0.169.0.json')));

  it('keeps the models the /model picker lists, in its order', () => {
    expect(parseCodexModels(capture)).toEqual([
      { id: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.' },
      {
        id: 'gpt-5.6-terra',
        label: 'GPT-5.6-Terra',
        description: 'Older balanced model for straightforward work.',
      },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', description: 'Older fast and efficient model.' },
    ]);
  });

  it('orders by priority, drops hidden and invalid slugs and duplicates, and reads around a notice', () => {
    const models = [
      { slug: 'b', display_name: 'B', visibility: 'list', priority: 2 },
      { slug: 'hidden', visibility: 'hide', priority: 0 },
      { slug: 'a', display_name: ' ', visibility: 'list', priority: 1 },
      { slug: 'bad slug', visibility: 'list', priority: 0 },
      { slug: 'b', display_name: 'B again', visibility: 'list', priority: 3 },
      { slug: 'c', visibility: 'list' },
      'noise',
    ];
    const text = `a notice\n${JSON.stringify({ models })}\n`;
    expect(parseCodexModels(text)).toEqual([
      { id: 'a', label: 'a' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'c' },
    ]);
  });

  it('throws on output that holds no catalog', () => {
    expect(() => parseCodexModels('error: not logged in')).toThrow(PickerParseError);
    expect(() => parseCodexModels('{"data":[]}')).toThrow('`codex debug models` printed no model catalog');
  });

  it('finds no models when every entry is hidden (a failed read, not an empty list)', () => {
    expect(parseCodexModels('{"models":[{"slug":"x","visibility":"hide"}]}')).toEqual([]);
  });
});

describe('parseCopilotModels', () => {
  it("drops Copilot's own auto and reads a free account's answer as no models of its own", () => {
    expect(parseCopilotModels(read('copilot-models-1.0.112-free.txt'))).toBeNull();
  });

  it('keeps the other models once each, with their names', () => {
    const text =
      'auto\tAuto\r\ngpt-5.6-luna\tGPT-5.6 Luna\nclaude-sonnet-5\t\nbad id\tX\ngpt-5.6-luna\tAgain\n';
    expect(parseCopilotModels(text)).toEqual([
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'claude-sonnet-5', label: 'claude-sonnet-5' },
    ]);
  });

  it('finds nothing in output without models', () => {
    expect(parseCopilotModels('\n')).toEqual([]);
  });
});

describe('listCommandsFor', () => {
  afterEach(() => {
    delete process.env.EMBERLINE_ANTIGRAVITY_COMMAND;
    delete process.env.EMBERLINE_CODEX_COMMAND;
    delete process.env.EMBERLINE_COPILOT_COMMAND;
  });
  it("reads the account's Codex catalog, honouring the command override", () => {
    expect(listCommandsFor('codex')).toEqual([
      { file: 'codex', args: ['-c', 'check_for_update_on_startup=false', 'debug', 'models'] },
    ]);
    process.env.EMBERLINE_CODEX_COMMAND = '/x/codex';
    expect(listCommandsFor('codex')[0]?.file).toBe('/x/codex');
  });
  it("runs the Copilot listing script against Copilot's command", () => {
    expect(listCommandsFor('copilot')).toEqual([{ file: COPILOT_MODELS_SCRIPT, args: ['copilot'] }]);
    process.env.EMBERLINE_COPILOT_COMMAND = ' /x/copilot ';
    expect(listCommandsFor('copilot')[0]?.args).toEqual(['/x/copilot']);
  });
  it('lists agy models, honouring the command override', () => {
    expect(listCommandsFor('antigravity')).toEqual([
      { file: 'agy', args: ['--log-file', '/dev/null', 'models'] },
    ]);
    process.env.EMBERLINE_ANTIGRAVITY_COMMAND = ' /x/agy ';
    expect(listCommandsFor('antigravity')[0]?.file).toBe('/x/agy');
  });
  it('has no listing for aider, Gemini CLI or the picker-read Claude', () => {
    expect(listCommandsFor('aider')).toEqual([]);
    expect(listCommandsFor('gemini')).toEqual([]);
    expect(listCommandsFor('claude')).toEqual([]);
  });
});
