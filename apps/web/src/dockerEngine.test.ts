import { describe, expect, it } from 'vitest';
import { DOCKER_ENGINE_UNREACHABLE_HINT } from '@emberline/protocol';
import { dockerEngineLine } from './dockerEngine';

describe('dockerEngineLine', () => {
  it('is quiet about an older core that does not report the engine', () => {
    expect(dockerEngineLine(undefined)).toBeNull();
  });

  it('says off, on with the version, or unreachable with the reason', () => {
    expect(dockerEngineLine({ enabled: false, checked: false, available: false, version: null })).toBe('Docker engine: off');
    expect(dockerEngineLine({ enabled: true, checked: true, available: true, version: '29.8.2' })).toBe('Docker engine: on (29.8.2)');
    expect(dockerEngineLine({ enabled: true, checked: true, available: false, version: null, error: 'connection refused' })).toBe(
      `Docker engine: unreachable — connection refused. ${DOCKER_ENGINE_UNREACHABLE_HINT}`,
    );
    expect(dockerEngineLine({ enabled: true, checked: true, available: false, version: null })).toBe(
      `Docker engine: unreachable. ${DOCKER_ENGINE_UNREACHABLE_HINT}`,
    );
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
