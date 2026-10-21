import { describe, expect, it } from 'vitest';
import { DOCKER_ENGINE_OFF_TEXT, DOCKER_ENGINE_UNREACHABLE_HINT, withHint } from './docker.js';

describe('Docker engine texts', () => {
  it('name the switch and never the old profile', () => {
    for (const text of [DOCKER_ENGINE_OFF_TEXT, DOCKER_ENGINE_UNREACHABLE_HINT]) {
      expect(text).toContain('EMBERLINE_DOCKER_ENGINE=0');
      expect(text).not.toContain('COMPOSE_PROFILES');
    }
  });

  it('withHint joins with one full stop, also when the text already ends in punctuation', () => {
    expect(withHint('boom', 'hint.')).toBe('boom. hint.');
    expect(withHint('boom. ', 'hint.')).toBe('boom. hint.');
    expect(withHint('boom...', 'hint.')).toBe('boom. hint.');
  });
});
