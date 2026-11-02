// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Drawer } from '@heroui/react';
import { PerformanceStudentDetailV2 } from '../../../src/features/gradebook/performance/performance-student-detail-v2';
import { GradeValue } from '../../../src/features/gradebook/performance/performance-display-v2';
import userEvent from '@testing-library/user-event';
import { StudentPortalWorkspaceV1 } from '../../../src/features/student-portal/workspace/student-workspace-v1';
import { AcademicStudentReaderPostgresV1, academicToSelfV1 } from '../../../server/student-portal/academic/academic-reader-v1';
import { SYNTHETIC_SELF_V1 } from '../../../shared/student-portal-contracts/fixtures-v1';
import { selfResponseV1 } from '../../../shared/student-portal-contracts/self-v1';
import { setupOperationsDomV1 } from '../../student-portal/ui/overview/dom-v1';
import { PARALLEL_ACCOUNT_848, PARALLEL_VERSION_848, parallelFixture848, type ParallelOptions848 } from './parallel-visibility-fixture-848';

beforeEach(setupOperationsDomV1);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function drawer(options: ParallelOptions848) {
  const fixture = parallelFixture848(options);
  const view = (detail: typeof fixture.detail) => <Drawer.Backdrop isOpen onOpenChange={vi.fn()}>
    <Drawer.Content placement="right"><Drawer.Dialog>
      <PerformanceStudentDetailV2 detail={detail} focusPeriod={2} openComponent={vi.fn()} />
    </Drawer.Dialog></Drawer.Content>
  </Drawer.Backdrop>;
  return { ...render(view(fixture.detail)), fixture, view };
}
/** The student's own view: open the subject from the Boletim and read its activities. */
async function portal(options: ParallelOptions848) {
  const fixture = parallelFixture848(options);
  const reader = new AcademicStudentReaderPostgresV1({ async unsafe() { throw new Error('unexpected-query'); } });
  const source = reader.projectPreparedSourceV2(fixture.link, PARALLEL_VERSION_848, fixture.portalSource)!;
  const data = selfResponseV1.parse({ ...SYNTHETIC_SELF_V1, ...academicToSelfV1(source.student, PARALLEL_ACCOUNT_848) });
  // The workspace restores Boletim/Disciplina from history; start every case on the Boletim.
  window.history.replaceState(null, '', window.location.href);
  const view = render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('option', { name: /COMPONENTE SINTETICO/u }));
  // The fixture's PARA belongs to the 2nd trimester.
  const periods = await screen.findByRole('tablist', { name: 'Períodos de COMPONENTE SINTETICO' });
  await user.click(within(periods).getByRole('tab', { name: /2º Trimestre/u }));
  return view;
}
const partialRow = (label: HTMLElement) => label.closest('li') as HTMLElement;

it.each([null, 0, 5000])('shows only the numeric exception for a normally ineligible Banco PARA (value=%s)', async (parallel) => {
  drawer({ qualitative: 14000, parallel });
  await screen.findByText('ATIVIDADE SINTETICA');
  expect(Boolean(screen.queryByText('PARA'))).toBe(parallel !== null);
  expect(screen.queryByText('Não fez')).toBeNull();
  expect(Boolean(screen.queryByText('Tirou zero'))).toBe(parallel === 0);
  expect(screen.queryByText('Parcial')).toBeNull();
  if (parallel !== null) {
    const row = screen.getByRole('row', { name: /PARA/u });
    expect(within(row).getByText(parallel === 0 ? 'Tirou zero' : '5')).toBeTruthy();
  }
});

it.each([
  { parallel: null, observed: true, expected: 'Não fez' },
  { parallel: 0, observed: true, expected: 'Tirou zero' },
  { parallel: null, observed: false, expected: '—' },
  { parallel: 5000, observed: true, expected: '5' },
])('renders an eligible Banco PARA as $expected', async (options) => {
  drawer(options);
  await screen.findByText('PARA');
  const row = screen.getByRole('row', { name: /PARA/u });
  expect(within(row).getAllByText(options.expected).length).toBeGreaterThan(0);
  if (options.expected !== 'Não fez') expect(within(row).queryByText('Não fez')).toBeNull();
  if (options.expected !== 'Tirou zero') expect(within(row).queryByText('Tirou zero')).toBeNull();
  expect(Boolean(screen.queryByText('Parcial'))).toBe(options.parallel === null);
  expect(screen.queryByText(/Soma antes do arredondamento/u)).toBeNull();
});

it('removes the row and partial state after exemption on same-scope revalidation', async () => {
  const current = drawer({});
  await screen.findByText('Não fez');
  expect(screen.getByText('Parcial')).toBeTruthy();
  const next = parallelFixture848({ qualitative: 14000 });
  current.rerender(current.view(next.detail));
  await screen.findByText('ATIVIDADE SINTETICA');
  expect(screen.queryByText('PARA')).toBeNull();
  expect(screen.queryByText('Não fez')).toBeNull();
  expect(screen.queryByText('Parcial')).toBeNull();
});

it('renders the compact asterisk from the central state, including zero and other pending marks', () => {
  const scenarios = [
    { options: {}, partial: true },
    { options: { parallel: 0 }, partial: false },
    { options: { qualitative: 14000 }, partial: false },
    { options: { av2: null, parallel: 0 }, partial: true },
    { options: { qualitative: 14000, parallel: 0 }, partial: false },
    { options: { av2: null, qualitative: 16000, parallel: 5000 }, partial: true },
  ];
  for (const { options, partial } of scenarios) {
    const { cell } = parallelFixture848(options);
    const html = renderToStaticMarkup(createElement(GradeValue, { cell, partialAsMarker: true }));
    expect(html.includes('Resultado parcial')).toBe(partial);
    expect(html.includes('aria-hidden="true">*</span>')).toBe(partial);
    expect(html).not.toContain('arredondamento');
  }
});

it.each([null, 0, 5000])('shows only a recorded exceptional PARA in the real Portal (value=%s)', async (parallel) => {
  await portal({ qualitative: 14000, parallel });
  await screen.findByRole('list', { name: 'Avaliações publicadas' });
  expect(Boolean(screen.queryByText('PARA'))).toBe(parallel !== null);
  expect(screen.queryByText('Não fez')).toBeNull();
  expect(screen.queryAllByText('Tirou zero').length > 0).toBe(parallel === 0);
  if (parallel !== null) {
    const row = partialRow(screen.getByText('PARA'));
    expect(within(row).getAllByText(parallel === 0 ? 'Tirou zero' : '5,0').length).toBeGreaterThan(0);
  }
});

it.each([
  { parallel: null, observed: true, expected: 'Não fez' },
  { parallel: 0, observed: true, expected: 'Tirou zero' },
  { parallel: null, observed: false, expected: '—' },
])('renders the eligible Portal PARA as $expected without replacing the official total', async (options) => {
  await portal(options);
  const partial = partialRow(await screen.findByText('PARA'));
  expect(within(partial).getAllByText(options.expected).length).toBeGreaterThan(0);
  // Trimester marks read with one decimal (owner review 27/09/2026).
  expect(screen.getAllByText('26,0').length).toBeGreaterThan(0);
  if (options.expected !== 'Não fez') expect(within(partial).queryByText('Não fez')).toBeNull();
  expect(screen.queryByText(/Soma antes do arredondamento/u)).toBeNull();
});
