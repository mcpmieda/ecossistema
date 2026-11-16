// @vitest-environment node
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { PerformanceCellV2 } from '../../../shared/gradebook-contracts/performance/relational-performance-v2';
import { GradeValue } from '../../../src/features/gradebook/performance/performance-display-v2';
import { requestRelationalPerformanceV2 } from '../../../src/features/gradebook/performance/relational-performance-client-v2';

const cell: PerformanceCellV2 = {
  offerId: 844001,
  valueMilli: 19000,
  rawMilli: 19200,
  maximumMilli: 30000,
  state: 'complete',
  level: 'at-or-above',
  sourceReferenceMilli: null,
  sourceComparison: 'unavailable',
  recoveryApplicable: null,
  warningCodes: [],
};
afterEach(() => { vi.unstubAllGlobals(); });

it.each([true, false])('preserves the supplied grade without rounding commentary (prominent=%s)', (prominent) => {
  const before = structuredClone(cell);
  const html = renderToStaticMarkup(createElement(GradeValue, { cell, prominent }));
  expect(html).not.toContain('Soma antes');
  expect(html).not.toContain('arredondamento');
  expect(html).not.toContain('19,2');
  expect(html).toContain('>19</span>');
  expect(html).toContain('text-accent');
  expect(html).toContain('No limite ou acima');
  expect(cell).toEqual(before);
});

it('does not add extra labels to the matrix or invent a sum for an older response', () => {
  expect(renderToStaticMarkup(createElement(GradeValue, { cell }))).not.toContain('Soma antes');
  const legacy = { ...cell };
  delete legacy.rawMilli;
  const html = renderToStaticMarkup(createElement(GradeValue, { cell: legacy, prominent: true }));
  expect(html).not.toContain('Soma antes');
  expect(html).toContain('>19</span>');
});

it('retains the partial status in the prominent grade without the technical explanation', () => {
  const html = renderToStaticMarkup(createElement(GradeValue, {
    cell: { ...cell, state: 'partial' }, prominent: true,
  }));
  expect(html).toContain('>19</span>');
  expect(html).toContain('Parcial');
  expect(html).toContain('text-accent');
  expect(html).not.toContain('arredondamento');
  expect(html).not.toContain('19,2');
});

it('preserves the accessible compact partial marker', () => {
  const html = renderToStaticMarkup(createElement(GradeValue, {
    cell: { ...cell, state: 'partial' }, partialAsMarker: true,
  }));
  expect(html).toContain('>19</span>');
  expect(html).toContain('Resultado parcial');
  expect(html).toContain('aria-hidden="true">*</span>');
  expect(html).not.toContain('arredondamento');
});

it('preserves recorded zero and its below-minimum classification', () => {
  const html = renderToStaticMarkup(createElement(GradeValue, {
    cell: { ...cell, valueMilli: 0, rawMilli: 0, level: 'below' }, prominent: true,
  }));
  expect(html).toContain('>0</span>');
  expect(html).toContain('text-danger');
  expect(html).toContain('Abaixo do limite');
  expect(html).not.toContain('arredondamento');
});

it.each([
  ['not-recorded', '—', 'Sem nota'],
  ['unavailable', '—', 'Indisponível'],
  ['not-applicable', '—', 'Não se aplica'],
  ['recovery-pending', 'REC', 'Pendente'],
  ['no-show', 'N/C', 'N/C'],
  ['repeat-failure', 'R/R', 'R/R'],
] as const)('preserves the essential %s state', (state, value, label) => {
  const stateCell: PerformanceCellV2 = {
    ...cell, state, valueMilli: null,
    level: state === 'repeat-failure' ? 'below' : 'not-classified',
  };
  delete stateCell.rawMilli;
  const html = renderToStaticMarkup(createElement(GradeValue, { cell: stateCell, prominent: true }));
  expect(html).toContain(`>${value}</span>`);
  expect(html).toContain(label);
  expect(html).not.toContain('arredondamento');
});

it('opts into the exact sum only for cell-detail and preserves the existing auth failure', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));
  vi.stubGlobal('fetch', fetchMock);
  const response = await requestRelationalPerformanceV2({
    transportVersion: 2, operation: 'cell-detail', year: 2026,
    classId: 844001, studentId: 844001, offerId: 844001, period: 2, mode: 'regular',
  });
  expect(response.state).toBe('not-authorized');
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).includeRawSum).toBe(true);
  await requestRelationalPerformanceV2({
    transportVersion: 2, operation: 'matrix', year: 2026,
    classId: 844001, period: 2, mode: 'regular', statuses: [null],
  });
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).not.toHaveProperty('includeRawSum');
});
