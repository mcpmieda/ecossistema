// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  answerLiveCloseV1,
  failLiveSocketV1,
  liveCloseCodeClassV1,
  sendableCloseCodeV1,
} from '../../../server/student-portal/live/live-close-v1';

// Direct calls only: a physical network drop or TLS failure is not simulated here (#1207).
function socket(readyState: number) {
  const closes: unknown[][] = [];
  return { readyState, closes, close: (...args: unknown[]) => void closes.push(args) };
}

describe('live close guard (#1207 L-01)', () => {
  it.each([
    [999, false],
    [1000, true],
    [1001, true],
    [1003, true],
    [1004, false],
    [1005, false],
    [1006, false],
    [1007, true],
    [1014, true],
    [1015, false],
    [1016, false],
    [2999, false],
    [3000, true],
    [4401, true],
    [4999, true],
    [5000, false],
    [1000.5, false],
    [Number.NaN, false],
  ])('treats %s as sendable=%s', (code, sendable) => {
    expect(sendableCloseCodeV1(code)).toBe(sendable);
    const target = socket(2);
    answerLiveCloseV1(target, code, 'kept-reason', () => undefined);
    expect(target.closes).toEqual([sendable ? [code, 'kept-reason'] : [1000]]);
  });

  it('classifies codes without claiming a cause', () => {
    expect([1000, 1001, 4401, 1005, 1006, 1015, 3000, 1004].map(liveCloseCodeClassV1)).toEqual([
      'normal',
      'going-away',
      'auth-expired',
      'no-status',
      'abnormal',
      'tls-reserved',
      'other-sendable',
      'other-invalid',
    ]);
  });

  it('emits the signal before closing and never lets a failing sink stop the close', () => {
    const order: string[] = [];
    const target = { readyState: 2, close: () => void order.push('close') };
    answerLiveCloseV1(target, 1005, '', (value) => void order.push(`signal:${value.codeClass}`));
    expect(order).toEqual(['signal:no-status', 'close']);
    const quiet = socket(2);
    answerLiveCloseV1(quiet, 1006, '', () => {
      throw new Error('sink-unavailable');
    });
    expect(quiet.closes).toEqual([[1000]]);
  });

  it.each([1, 2, 3])('keeps 1011/socket-error on the error callback in state %s', (state) => {
    const target = socket(state);
    const signals: unknown[] = [];
    failLiveSocketV1(target, (value) => void signals.push(value));
    expect(target.closes).toEqual([[1011, 'socket-error']]);
    expect(signals).toEqual([
      {
        event: 'student-portal-live-close-v1',
        callback: 'error',
        codeClass: 'not-applicable',
        readyState: state,
      },
    ]);
  });
});
