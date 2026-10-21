import { describe, expect, it } from 'vitest';
import {
  DOCKER_ENGINE_NOT_ANSWERED_TEXT,
  DOCKER_ENGINE_NOT_CONFIGURED_TEXT,
  DOCKER_ENGINE_OFF_TEXT,
  DOCKER_ENGINE_UNREACHABLE_HINT,
  dockerEngineOffText,
  withHint,
} from './docker.js';

describe('Docker engine texts', () => {
  it('name the switch and never the old profile', () => {
    for (const text of [DOCKER_ENGINE_OFF_TEXT, DOCKER_ENGINE_UNREACHABLE_HINT]) {
      expect(text).toContain('EMBERLINE_DOCKER_ENGINE=0');
      expect(text).not.toContain('COMPOSE_PROFILES');
    }
  });

  it('a missing engine points at the current compose file, not at a switch nobody set', () => {
    expect(DOCKER_ENGINE_NOT_CONFIGURED_TEXT).toContain('deploy/compose.yaml');
    expect(DOCKER_ENGINE_NOT_CONFIGURED_TEXT).not.toContain('EMBERLINE_DOCKER_ENGINE=0');
    expect(DOCKER_ENGINE_NOT_ANSWERED_TEXT).not.toContain('turned off');
  });

  it('are plain text', () => {
    for (const text of [DOCKER_ENGINE_OFF_TEXT, DOCKER_ENGINE_NOT_CONFIGURED_TEXT, DOCKER_ENGINE_NOT_ANSWERED_TEXT, DOCKER_ENGINE_UNREACHABLE_HINT]) {
      expect(text).not.toContain('`');
    }
  });

  it('dockerEngineOffText picks the text by why the engine is off', () => {
    const off = { enabled: false, checked: false, available: false, version: null } as const;
    expect(dockerEngineOffText({ ...off, reason: 'switched_off' })).toBe(DOCKER_ENGINE_OFF_TEXT);
    expect(dockerEngineOffText({ ...off, reason: 'not_configured' })).toBe(DOCKER_ENGINE_NOT_CONFIGURED_TEXT);
    // An older core that does not say why: never claim a line the user did not write.
    expect(dockerEngineOffText(off)).toBe(DOCKER_ENGINE_NOT_CONFIGURED_TEXT);
  });

  it('withHint joins with one full stop, also when the text already ends in punctuation', () => {
    expect(withHint('boom', 'hint.')).toBe('boom. hint.');
    expect(withHint('boom. ', 'hint.')).toBe('boom. hint.');
    expect(withHint('boom...', 'hint.')).toBe('boom. hint.');
  });
});
