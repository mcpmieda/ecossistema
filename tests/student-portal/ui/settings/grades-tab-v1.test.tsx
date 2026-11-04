import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GradeShowV1 } from '../../../../src/features/student-portal-admin/settings/grades-tab-v1';
import { settingsFixtureV1 } from './fixtures-v1';

const SHOW = '2026-10-20T13:00:00.000Z'; // 10:00 in São Paulo
const HIDE = '2026-10-20T21:00:00.000Z'; // 18:00
const empty = { enabled: false, schedule: [] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-10-20T12:58:00Z'));
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup() {
  const settings = settingsFixtureV1();
  settings.value.calendar.disclosure = {
    mode: 'agenda',
    periods: {
      T1: {
        enabled: false,
        schedule: [
          { at: SHOW, action: 'open' },
          { at: HIDE, action: 'close' },
        ],
      },
      T2: empty,
      T3: empty,
      REC1: empty,
      REC2: empty,
      REC3: empty,
    },
  };
  const review = vi.fn();
  render(
    <GradeShowV1
      settings={settings}
      gradeKey="T1"
      canWrite
      disabled={false}
      review={review}
      onDirtyChange={() => {}}
    />,
  );
  return review;
}

describe('Aba Notas schedule rows', () => {
  it('drops a saved action once it happens while the page is open', () => {
    setup();
    expect(screen.getAllByRole('button', { name: /Remover agendamento/ })).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(7 * 60_000);
    });
    expect(screen.getAllByRole('button', { name: /Remover agendamento/ })).toHaveLength(1);
  });

  it('saves the other rows when a saved action already happened', () => {
    const review = setup();
    // Edited before 10:00: the Ocultar is removed and the Mostrar 10:00 stays as it was.
    fireEvent.click(screen.getByRole('button', { name: 'Remover agendamento 2' }));
    act(() => {
      vi.advanceTimersByTime(7 * 60_000);
    });
    fireEvent.click(screen.getByRole('button', { name: /Salvar agendamentos/ }));
    expect(screen.queryByText('Cada agendamento precisa estar no futuro.')).toBeNull();
    expect(review).toHaveBeenCalledTimes(1);
    const calendar = review.mock.calls[0]![0].value.calendar;
    expect(calendar.disclosure.periods.T1).toEqual({ enabled: true, schedule: [] });
  });
});
