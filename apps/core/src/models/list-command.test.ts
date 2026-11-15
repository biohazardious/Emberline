import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { listCommandsFor, parseAgyModels, parseAiderModels } from './list-command.js';

const fixture = readFileSync(new URL('./fixtures/agy-models.txt', import.meta.url), 'utf8');

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

describe('parseAiderModels', () => {
  const sample =
    'Models which match "openai/":\n- openai/gpt-4o\n- openai/gpt-4o\n- azure/gpt-4o\n- openai/bad id\n\nnoise\n';
  it('keeps only ids under the given prefixes', () => {
    expect(parseAiderModels(sample, ['openai/'])).toEqual([{ id: 'openai/gpt-4o', label: 'openai/gpt-4o' }]);
  });
});

describe('listCommandsFor', () => {
  afterEach(() => {
    delete process.env.EMBERLINE_ANTIGRAVITY_COMMAND;
  });
  it('lists agy models, honouring the command override', () => {
    expect(listCommandsFor('antigravity', { aiderPrefixes: [] })).toEqual([
      { file: 'agy', args: ['--log-file', '/dev/null', 'models'] },
    ]);
    process.env.EMBERLINE_ANTIGRAVITY_COMMAND = ' /x/agy ';
    expect(listCommandsFor('antigravity', { aiderPrefixes: [] })[0]?.file).toBe('/x/agy');
  });
  it('gives aider one command per prefix and other agents none', () => {
    expect(listCommandsFor('aider', { aiderPrefixes: ['openai/', 'gemini/'] })).toEqual([
      { file: 'aider', args: ['--list-models', 'openai/'] },
      { file: 'aider', args: ['--list-models', 'gemini/'] },
    ]);
    expect(listCommandsFor('claude', { aiderPrefixes: [] })).toEqual([]);
  });
});
