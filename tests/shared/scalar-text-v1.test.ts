import { expect, it } from 'vitest';
import { scalarTextV1 } from '../../shared/scalar-text-v1';

// scalarTextV1 is String() for everything but a plain object (Sonar S6551).
it('matches String() except for a plain object', () => {
  const date = new Date('2026-10-24T10:00:00Z');
  const url = new URL('https://example.invalid/a?b=1');
  for (const value of [
    'texto',
    1.5,
    0,
    -0,
    NaN,
    10n,
    true,
    null,
    undefined,
    date,
    url,
    [1, 'a'],
    Symbol('s'),
  ])
    expect(scalarTextV1(value)).toBe(String(value));
  expect(scalarTextV1({ a: 1 })).toBe('{"a":1}');
});
