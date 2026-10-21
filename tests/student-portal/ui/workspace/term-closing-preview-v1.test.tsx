// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTermClosingNewV1 } from '../../../../src/features/student-portal/workspace/term-closing-v1';

/*
 * PR 1317 review: the neighbour discipline drawn beside a drag mounts its closing card, and that
 * card used to record the "Novo" notice as seen although the student never opened it.
 */
describe('term closing "Novo" notice and the drag preview', () => {
  beforeEach(() => globalThis.localStorage.clear());
  afterEach(cleanup);

  const stored = () => Object.values({ ...globalThis.localStorage }).join('');

  it('a preview shows the notice as new and records nothing', () => {
    const preview = renderHook(() => useTermClosingNewV1('conta|disciplina|T1|closed', false));
    expect(preview.result.current).toBe(true);
    expect(stored()).not.toContain('conta|disciplina|T1|closed');
  });

  it('opening the discipline records it, and it is no longer new afterwards', () => {
    renderHook(() => useTermClosingNewV1('conta|disciplina|T1|closed'));
    expect(stored()).toContain('conta|disciplina|T1|closed');
    const again = renderHook(() => useTermClosingNewV1('conta|disciplina|T1|closed'));
    expect(again.result.current).toBe(false);
  });
});
