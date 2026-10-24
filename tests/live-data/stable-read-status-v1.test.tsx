// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { StableReadStatusV1 } from '../../src/shared/live-data/stable-read-status-v1';

afterEach(cleanup);
it.each([250, 1200])('keeps the same text footprint and following content at width %i', (width) => {
  const View = ({ busy }: { busy: boolean }) => (
    <section style={{ width }}>
      <StableReadStatusV1 busy={busy}>Atualizando a mesma leitura…</StableReadStatusV1>
      <input aria-label="SYNTHETIC focused control" defaultValue="SYNTHETIC" />
    </section>
  );
  const view = render(<View busy={false} />);
  const text = screen.getByText('Atualizando a mesma leitura…');
  const row = text.closest('p')!;
  const input = screen.getByRole('textbox');
  input.focus();
  const contents = row.innerHTML;
  expect(screen.queryByRole('status')).toBeNull();
  for (const busy of [true, false, true, false]) {
    view.rerender(<View busy={busy} />);
    expect(text.closest('p')).toBe(row);
    expect(row.innerHTML).toBe(contents);
    expect(getComputedStyle(row).visibility).toBe(busy ? 'visible' : 'hidden');
    expect(getComputedStyle(row).display).not.toBe('none');
    expect(row.hasAttribute('hidden')).toBe(false);
    expect(row.getAttribute('aria-hidden')).toBe(String(!busy));
    expect(document.activeElement).toBe(input);
    expect(row.nextElementSibling).toBe(input);
    expect(screen.queryByRole('status')?.closest('p') ?? null).toBe(busy ? row : null);
  }
  // JSDOM proves stable DOM/CSS visibility, not browser geometry or cumulative layout shift.
});
it('uses an unconditional stable row where a background refresh is announced', () => {
  const performance = readFileSync('src/features/gradebook/performance/relational-performance-page-v2.tsx', 'utf8');
  const publication = readFileSync('src/features/student-portal-admin/publication/student-publication-v1.tsx', 'utf8');
  // Desempenho re-reads silently: what is on screen stays, with no status line.
  expect(performance).not.toContain('StableReadStatusV1');
  expect(performance).not.toContain('{state.busy.matrix || state.busy.classes ? (');
  expect(publication).toContain('<StableReadStatusV1 busy={view.refreshing}>');
  expect(publication).not.toContain('{view.refreshing ? <p');
});
