import { describe, expect, it } from 'vitest';
import { ptydMethodNames, ptydMethods, PtydEvent, PtydRequest, PtydResponse } from './ptyd.js';

describe('PtydRequest', () => {
  it('round-trips a valid request', () => {
    const frame = { type: 'request', id: 7, method: 'list', params: {} };
    expect(PtydRequest.parse(frame)).toEqual(frame);
  });

  it('rejects an unknown method', () => {
    expect(PtydRequest.safeParse({ type: 'request', id: 1, method: 'reboot', params: {} }).success).toBe(
      false,
    );
  });

  it('rejects a missing id', () => {
    expect(PtydRequest.safeParse({ type: 'request', method: 'list', params: {} }).success).toBe(false);
  });
});

describe('PtydResponse', () => {
  it('discriminates on ok', () => {
    const success = PtydResponse.parse({ type: 'response', id: 1, ok: true, result: { a: 1 } });
    expect(success.ok).toBe(true);
    const failure = PtydResponse.parse({
      type: 'response',
      id: 1,
      ok: false,
      error: { code: 'not_found', message: 'gone' },
    });
    expect(failure.ok).toBe(false);
  });

  it('rejects a failure without an error and a success carrying an unknown error code', () => {
    expect(PtydResponse.safeParse({ type: 'response', id: 1, ok: false }).success).toBe(false);
    expect(
      PtydResponse.safeParse({ type: 'response', id: 1, ok: false, error: { code: 'boom', message: 'x' } })
        .success,
    ).toBe(false);
  });
});

describe('PtydEvent', () => {
  it('round-trips output and exit events', () => {
    const output = { type: 'event', event: 'output', sessionId: 's1', data: 'hi' };
    expect(PtydEvent.parse(output)).toEqual(output);
    const exit = { type: 'event', event: 'exit', sessionId: 's1', exitCode: 0, signal: null };
    expect(PtydEvent.parse(exit)).toEqual(exit);
  });

  it('rejects an unknown event', () => {
    expect(PtydEvent.safeParse({ type: 'event', event: 'resize', sessionId: 's1' }).success).toBe(false);
  });
});

describe('ptydMethods params', () => {
  it.each(ptydMethodNames)('%s rejects a non-object', (method) => {
    const { params } = ptydMethods[method];
    for (const bad of ['text', 42, null, [1]]) {
      expect(params.safeParse(bad).success, `${method} accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});
