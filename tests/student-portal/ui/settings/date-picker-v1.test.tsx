import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateInputV1 } from '../../../../src/features/student-portal-admin/settings/settings-editors-v1';
import { useState } from 'react';
import { setupOperationsDomV1 } from '../overview/dom-v1';
beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Demo({ initial = '' }: { initial?: string }) {
  const [value, set] = useState(initial);
  return (
    <>
      <DateInputV1 label="Teste" value={value} onChange={set} disabled={false} />
      <output>{value}</output>
    </>
  );
}
it('accepts a pt-BR segmented date and time with the native HeroUI composition', async () => {
  render(<Demo />);
  const user = userEvent.setup();
  for (const [part, value] of [
    ['dia', '02'],
    ['mês', '12'],
    ['ano', '2026'],
    ['hora', '08'],
    ['minuto', '00'],
  ]) {
    const el = screen.getByRole('spinbutton', { name: new RegExp(`^${part},`, 'i') });
    act(() => el.focus());
    await user.keyboard(value! + '{Tab}');
  }
  expect(document.querySelector('output')?.textContent).toBe('2026-12-02T08:00:00');
});

it('opens the real calendar by clicking the date, chooses a day and preserves the entered time', async () => {
  render(<Demo initial="2026-12-02T08:30:00" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('spinbutton', { name: 'dia, Teste' }));
  const cell = await screen.findByRole('button', { name: /10 de dezembro de 2026/i });
  await user.click(cell);
  expect(document.querySelector('output')?.textContent).toBe('2026-12-10T08:30:00');
});

it('keeps time editing and clear separate from opening the date calendar', async () => {
  render(<Demo initial="2026-12-02T08:30:00" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('spinbutton', { name: 'hora, Teste' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.keyboard('09{Tab}');
  expect(document.querySelector('output')?.textContent).toBe('2026-12-02T09:30:00');
  await user.click(screen.getByRole('button', { name: 'Limpar Teste' }));
  expect(document.querySelector('output')?.textContent).toBe('');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('an end-of-day bound picked from the calendar covers the whole day', async () => {
  function EndDemo() {
    const [value, set] = useState('');
    return (
      <>
        <DateInputV1 label="Até" value={value} onChange={set} disabled={false} endOfDay />
        <output>{value}</output>
      </>
    );
  }
  render(<EndDemo />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('spinbutton', { name: 'dia, Até' }));
  const cell = (await screen.findAllByRole('button', { name: /\b15 de /i }))[0]!;
  await user.click(cell);
  expect(document.querySelector('output')?.textContent).toMatch(/-15T23:59:00$/);
});
