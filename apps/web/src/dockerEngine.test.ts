import { describe, expect, it } from 'vitest';
import {
  DOCKER_ENGINE_NOT_CONFIGURED_TEXT,
  DOCKER_ENGINE_OFF_TEXT,
  DOCKER_ENGINE_UNREACHABLE_HINT,
  type DockerEngineStatus,
} from '@emberline/protocol';
import { dockerEngineLine, dockerEngineOffState, dockerEngineTitle } from './dockerEngine';

const OFF = { enabled: false, checked: false, available: false, version: null } as const;
const SWITCHED_OFF: DockerEngineStatus = { ...OFF, reason: 'switched_off' };
const NOT_CONFIGURED: DockerEngineStatus = { ...OFF, reason: 'not_configured' };

describe('dockerEngineLine', () => {
  it('is quiet about an older core that does not report the engine', () => {
    expect(dockerEngineLine(undefined)).toBeNull();
  });

  it('says off, on with the version, or unreachable with the reason', () => {
    expect(dockerEngineLine(SWITCHED_OFF)).toBe('Docker engine: off');
    expect(dockerEngineLine({ enabled: true, checked: true, available: true, version: '29.8.2' })).toBe('Docker engine: on (29.8.2)');
    expect(dockerEngineLine({ enabled: true, checked: true, available: false, version: null, error: 'connection refused' })).toBe(
      `Docker engine: unreachable — connection refused. ${DOCKER_ENGINE_UNREACHABLE_HINT}`,
    );
    expect(dockerEngineLine({ enabled: true, checked: true, available: false, version: null })).toBe(
      `Docker engine: unreachable. ${DOCKER_ENGINE_UNREACHABLE_HINT}`,
    );
  });

  it('tells a missing engine (an old compose file) apart from one switched off', () => {
    expect(dockerEngineLine(NOT_CONFIGURED)).toBe('Docker engine: not configured');
    expect(dockerEngineLine(OFF)).toBe('Docker engine: not configured');
  });

  it('does not double the full stop after an error that ends in one', () => {
    expect(dockerEngineLine({ enabled: true, checked: true, available: false, version: null, error: 'refused.' })).toBe(
      `Docker engine: unreachable — refused. ${DOCKER_ENGINE_UNREACHABLE_HINT}`,
    );
  });

  it('says checking until the first probe answered', () => {
    expect(dockerEngineLine({ enabled: true, checked: false, available: false, version: null })).toBe('Docker engine: checking…');
  });
});

describe('dockerEngineTitle', () => {
  it('says why an engine that is not on is off, by reason', () => {
    expect(dockerEngineTitle(SWITCHED_OFF)).toBe(DOCKER_ENGINE_OFF_TEXT);
    expect(dockerEngineTitle(NOT_CONFIGURED)).toBe(DOCKER_ENGINE_NOT_CONFIGURED_TEXT);
  });

  it('describes the engine while it is on', () => {
    const title = dockerEngineTitle({ enabled: true, checked: true, available: true, version: '29.8.2' });
    expect(title).toContain('on by default');
    expect(title).toContain('EMBERLINE_DOCKER_ENGINE=0');
  });
});

describe('dockerEngineOffState (the Docker page without an engine)', () => {
  it('switched off: the turn-on text', () => {
    expect(dockerEngineOffState(SWITCHED_OFF)).toEqual({ title: 'The Docker engine is off.', text: DOCKER_ENGINE_OFF_TEXT });
  });

  it('not configured: the current compose file, never a line in .env', () => {
    const state = dockerEngineOffState(NOT_CONFIGURED);
    expect(state.title).toBe('The Docker engine is missing.');
    expect(state.text).toBe(DOCKER_ENGINE_NOT_CONFIGURED_TEXT);
    expect(state.text).not.toContain('EMBERLINE_DOCKER_ENGINE=0');
  });
});
