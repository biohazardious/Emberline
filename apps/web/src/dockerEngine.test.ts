import { describe, expect, it } from 'vitest';
import { dockerEngineLine } from './dockerEngine';

describe('dockerEngineLine', () => {
  it('is quiet about an older core that does not report the engine', () => {
    expect(dockerEngineLine(undefined)).toBeNull();
  });

  it('says off, on with the version, or unreachable with the reason', () => {
    expect(dockerEngineLine({ enabled: false, available: false, version: null })).toBe('Docker engine: off');
    expect(dockerEngineLine({ enabled: true, available: true, version: '29.8.2' })).toBe('Docker engine: on (29.8.2)');
    expect(dockerEngineLine({ enabled: true, available: false, version: null, error: 'connection refused' })).toBe(
      'Docker engine: unreachable — connection refused',
    );
    expect(dockerEngineLine({ enabled: true, available: false, version: null })).toBe('Docker engine: unreachable');
  });
});
