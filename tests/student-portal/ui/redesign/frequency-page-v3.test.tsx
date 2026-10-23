// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FrequencySummaryV2,
  FrequencyYearSummaryV2,
} from '../../../../shared/attendance-contracts/frequency-v2';
import {
  FrequencyClientErrorV2,
  type StudentFrequencyClientV2,
} from '../../../../src/features/student-portal/frequency/client-v2';
import { FrequencyPageV3 } from '../../../../src/features/student-portal/redesign/frequency-page-v3';
import { officialBells2026V1 } from '../../../../shared/student-portal-contracts/school-bells-v1';

/*
 * The redesigned Frequência page (PR 1317), fed through a client with answers shaped like the
 * real API's (portalFrequencyYearV2): the whole year so far in one answer, read once, with the
 * school's today and the year's counts worked out by the server. Changing months asks nothing.
 */
type DayV2 = NonNullable<FrequencySummaryV2['days']>[number];
type MarkInput = { date: string; slot: number; mark: 'X' | 'J'; shift?: string };
type YearV2 = FrequencySummaryV2['year'];

const lessonDay = (date: string, lessons = 5, complete = true, shift = 'MATUTINO'): DayV2 => ({
  date,
  shift,
  slots: Array.from({ length: lessons }, (_, index) => index + 1),
  complete,
});
const summary = (month: string, days: DayV2[], marks: MarkInput[] = []): FrequencySummaryV2 => ({
  contractVersion: 2,
  state: 'ready',
  month,
  absences: null,
  justified: null,
  denominator: null,
  percentage: null,
  coverage: days.length ? 'reliable' : marks.length ? 'incomplete' : 'unavailable',
  observedAt: null,
  receivedAt: null,
  marks: marks.map((mark) => ({ shift: 'MATUTINO', classLabels: ['TURMA'], ...mark })),
  conflicts: 0,
  days,
});
/** A client answering like the server: the whole year so far in one answer. */
const clientOf = (
  months: Record<string, FrequencySummaryV2> = {},
  {
    today = '2026-10-21',
    year = { lessons: 100, absences: 0 } as YearV2,
    extra = {} as Partial<FrequencyYearSummaryV2>,
  } = {},
) => {
  const count = today > '2026-12-31' ? 12 : Number(today.slice(5, 7));
  const readYear = vi.fn(
    async (): Promise<FrequencyYearSummaryV2> => ({
      contractVersion: 2,
      state: 'ready',
      academicYear: 2026,
      today,
      year: year ?? null,
      lastReadAt: `${today}T10:10:00Z`,
      months: Array.from({ length: count }, (_, index) => {
        const key = `2026-${String(index + 1).padStart(2, '0')}`;
        return months[key] ?? summary(key, []);
      }),
      ...extra,
    }),
  );
  const read = vi.fn(async (month: string) => summary(month, []));
  return { read, readYear } satisfies StudentFrequencyClientV2;
};

const dayButton = (day: number) =>
  screen.getAllByRole('button').find((button) => button.querySelector('.pa3-day-number')?.textContent === String(day))!;
const ready = () => screen.findByRole('heading', { level: 3, name: /de 2026$/u });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-21T12:00:00-03:00'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Frequência page', () => {
  it('shows no ruler and no limit: the limit only appears in a warning (owner decision 22/10/2026)', async () => {
    render(<FrequencyPageV3 client={clientOf({}, { year: { lessons: 250, absences: 60 } })} />);
    await ready();
    expect(document.querySelector('.pa3-ruler')).toBeNull();
    expect(screen.queryByText(/limite/u)).toBeNull();
  });

  it("keeps today's colour on the calendar, while the ring counts no day yet", async () => {
    const months = {
      '2026-10': summary('2026-10', [lessonDay('2026-10-21')], [1, 2, 3, 4, 5].map((slot) => ({ date: '2026-10-21', slot, mark: 'X' as const }))),
    };
    render(<FrequencyPageV3 client={clientOf(months)} />);
    await ready();
    expect(dayButton(21).className).toContain('pa3-day--missed');
    expect(document.querySelector('.pa3-guide-ring')?.getAttribute('aria-label')).toMatch(/^Ano letivo 2026, 0 dias de aula contados/u);
  });

  it('shows a past day not read in full as "leitura incompleta", never as a coloured total', async () => {
    const months = {
      '2026-10': summary(
        '2026-10',
        [{ date: '2026-10-20', shift: 'MATUTINO', slots: [1, 2], complete: false }],
        [
          { date: '2026-10-20', slot: 1, mark: 'X' },
          { date: '2026-10-20', slot: 2, mark: 'X' },
        ],
      ),
    };
    render(<FrequencyPageV3 client={clientOf(months, { year: null })} />);
    await ready();
    const button = dayButton(20);
    expect(button.className).toContain('pa3-day--pending');
    expect(button.className).not.toContain('pa3-day--missed');
    expect(button.getAttribute('aria-label')).toContain('leitura incompleta');
    // Chosen at first, it explains itself and does not claim "todas as aulas".
    expect(screen.getByText('Leitura incompleta · conta quando o diário for lido')).toBeTruthy();
    expect(screen.getByText('2 faltas registradas até agora.')).toBeTruthy();
  });

  it('opens a day without absence too, every lesson "Sem falta" (owner request 22/10/2026)', async () => {
    render(<FrequencyPageV3 client={clientOf({ '2026-10': summary('2026-10', [lessonDay('2026-10-19'), lessonDay('2026-10-20')], [{ date: '2026-10-19', slot: 2, mark: 'X' }]) })} />);
    await ready();
    // At first, the day with an absence; a day without one is never chosen first.
    expect(dayButton(19).getAttribute('aria-pressed')).toBe('true');
    const clear = dayButton(20) as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    expect(clear.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Nenhuma falta neste dia.')).toBeTruthy();
    expect(document.querySelectorAll('.pa3-day-detail .pa3-lesson--clear')).toHaveLength(5);
  });

  it('never says "sem aula" for today before its first reading', async () => {
    render(<FrequencyPageV3 client={clientOf({ '2026-10': summary('2026-10', [lessonDay('2026-10-20')]) })} />);
    await ready();
    const label = dayButton(21).getAttribute('aria-label')!;
    expect(label).toContain('nenhuma aula lida até agora');
    expect(label).not.toContain('sem aula');
  });

  it('shows the marks of a day the server sent without its lesson day', async () => {
    const months = { '2026-10': summary('2026-10', [lessonDay('2026-10-14')], [{ date: '2026-10-15', slot: 3, mark: 'X' }]) };
    render(<FrequencyPageV3 client={clientOf(months)} />);
    await ready();
    const button = dayButton(15);
    expect(button.className).toContain('pa3-day--pending');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('1 falta registrada até agora.')).toBeTruthy();
    expect(screen.getByText('3ª aula')).toBeTruthy();
  });

  it("follows the school's today from the server, not the phone's clock", async () => {
    // The phone says 21/10; the school's clock says 20/10.
    render(<FrequencyPageV3 client={clientOf({}, { today: '2026-10-20' })} />);
    await ready();
    expect(dayButton(20).className).toContain('is-today');
    expect(dayButton(21).className).not.toContain('is-today');
  });

  it('stays on December after the school year ends', async () => {
    const client = clientOf({}, { today: '2027-01-10' });
    render(<FrequencyPageV3 client={client} />);
    expect(await screen.findByRole('heading', { level: 3, name: 'Dezembro de 2026' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Próximo mês' }) as HTMLButtonElement).disabled).toBe(true);
    expect(client.read).not.toHaveBeenCalled();
  });

  it('says the ring in correct Portuguese for one day', async () => {
    render(<FrequencyPageV3 client={clientOf({ '2026-10': summary('2026-10', [lessonDay('2026-10-20')]) })} />);
    await ready();
    expect(document.querySelector('.pa3-guide-ring')?.getAttribute('aria-label')).toBe(
      'Ano letivo 2026, 1 dia de aula contado: 1 dia frequentado, 0 faltas totais, 0 faltas parciais, 0 justificadas',
    );
  });

  it('counts the whole year in the ring, whatever month the calendar shows (owner request 22/10/2026)', async () => {
    const months = {
      '2026-09': summary('2026-09', [lessonDay('2026-09-29'), lessonDay('2026-09-30')], [{ date: '2026-09-30', slot: 1, mark: 'X' }]),
      '2026-10': summary('2026-10', [lessonDay('2026-10-20')]),
    };
    render(<FrequencyPageV3 client={clientOf(months)} />);
    await ready();
    const ring = () => document.querySelector('.pa3-guide-ring')?.getAttribute('aria-label');
    expect(ring()).toMatch(/^Ano letivo 2026, 3 dias de aula contados: 2 dias frequentados, 0 faltas totais, 1 falta parcial/u);
    fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }));
    expect(screen.getByRole('heading', { level: 3, name: 'Setembro de 2026' })).toBeTruthy();
    expect(ring()).toMatch(/^Ano letivo 2026, 3 dias de aula contados/u);
  });

  it("shows the class's last reading as \"Atualizado em\"", async () => {
    render(<FrequencyPageV3 client={clientOf()} />);
    await ready();
    expect(screen.getByText(/^Atualizado em 21\/10\/2026, 07:10$/u)).toBeTruthy();
  });
});

describe('Frequência page: calendar and bells (owner decision 23/10/2026)', () => {
  const daysOff = [{ date: '2026-10-12', kind: 'feriado' as const, note: 'Nossa Senhora Aparecida' }];
  const bells = officialBells2026V1();
  // The Smecel's name; the tile shows the official one (owner decision 23/10/2026).
  const grid = [{ shift: 'matutino' as const, lessons: [{ weekday: 4, slot: 3, subject: 'MATEMATICA' }] }];

  it('marks a holiday on the calendar and says why when it is opened', async () => {
    const months = { '2026-10': summary('2026-10', [lessonDay('2026-10-13')]) };
    render(<FrequencyPageV3 client={clientOf(months, { extra: { daysOff } })} />);
    await ready();
    const holiday = dayButton(12);
    expect(holiday.className).toContain('pa3-day--holiday');
    expect(holiday.getAttribute('aria-label')).toBe('Segunda-feira, 12 de outubro: sem aula, Feriado · Nossa Senhora Aparecida');
    expect(screen.getByText('Feriado ou recesso')).toBeTruthy();
    fireEvent.click(holiday);
    expect(screen.getByText(/Feriado · Nossa Senhora Aparecida/u)).toBeTruthy();
  });

  it("shows each lesson's time and subject inside its tile, from 22/06 on only", async () => {
    const months = {
      '2026-06': summary('2026-06', [lessonDay('2026-06-18', 6)], [{ date: '2026-06-18', slot: 3, mark: 'X' }]),
      '2026-10': summary('2026-10', [lessonDay('2026-10-15', 6)], [
        { date: '2026-10-15', slot: 3, mark: 'X' },
        { date: '2026-10-15', slot: 5, mark: 'J' },
      ]),
    };
    render(<FrequencyPageV3 client={clientOf(months, { extra: { bells, grid } })} />);
    await ready();
    fireEvent.click(dayButton(15));
    const tiles = () => [...document.querySelectorAll('.pa3-day-detail .pa3-lesson')].map((tile) => tile.textContent);
    expect(tiles()[2]).toBe('3ª aula08:30–09:15MATEMÁTICAFaltou');
    expect(tiles()[4]).toBe('5ª aula10:15–11:00Justificada');
    expect(tiles()[0]).toBe('1ª aula07:00–07:45Sem falta');
    // 18/06, before the bells of 22/06: no time, no subject.
    for (let step = 0; step < 4; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }));
    await screen.findByRole('heading', { level: 3, name: 'Junho de 2026' });
    fireEvent.click(dayButton(18));
    expect(tiles()[2]).toBe('3ª aulaFaltou');
  });
});

describe('Frequência page: reading', () => {
  it('says it is loading only until the year comes, then changes months without asking again', async () => {
    let finish!: (value: FrequencyYearSummaryV2) => void;
    const client = {
      read: vi.fn(async (month: string) => summary(month, [])),
      readYear: vi.fn(() => new Promise<FrequencyYearSummaryV2>((resolve) => (finish = resolve))),
    };
    render(<FrequencyPageV3 client={client} />);
    expect(await screen.findByText('Carregando frequência…')).toBeTruthy();
    const answer = await clientOf().readYear();
    await act(async () => finish(answer));
    expect(await screen.findByRole('heading', { level: 3, name: 'Outubro de 2026' })).toBeTruthy();
    for (let step = 0; step < 3; step++) fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }));
    // Every month shows at once: no "Carregando", no request.
    expect(screen.getByRole('heading', { level: 3, name: 'Julho de 2026' })).toBeTruthy();
    expect(screen.queryByText('Carregando frequência…')).toBeNull();
    expect(client.readYear).toHaveBeenCalledOnce();
    expect(client.read).not.toHaveBeenCalled();
  });

  it('hides everything and offers to sign in again when the session expires', async () => {
    const client = { read: vi.fn(), readYear: vi.fn(async () => Promise.reject(new FrequencyClientErrorV2('unauthenticated'))) };
    const onLogin = vi.fn();
    const onAuthenticationLost = vi.fn();
    render(<FrequencyPageV3 client={client} onLogin={onLogin} onAuthenticationLost={onAuthenticationLost} />);
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para ver a frequência.')).toBeTruthy();
    expect(onAuthenticationLost).toHaveBeenCalledOnce();
    expect(document.querySelector('.pa3-calendar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(onLogin).toHaveBeenCalledOnce();
  });

  it('says so when the policy was turned off meanwhile, and retries other failures', async () => {
    const forbidden = { read: vi.fn(), readYear: vi.fn(async () => Promise.reject(new FrequencyClientErrorV2('forbidden'))) };
    const view = render(<FrequencyPageV3 client={forbidden} />);
    expect(await screen.findByText('A frequência não está disponível no momento.')).toBeTruthy();
    view.unmount();
    const failing = { read: vi.fn(), readYear: vi.fn(async () => Promise.reject(new FrequencyClientErrorV2('unavailable'))) };
    render(<FrequencyPageV3 client={failing} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar agora' }));
    await waitFor(() => expect(failing.readYear).toHaveBeenCalledTimes(2));
  });

  it('reads again in the background only when the page comes back after ten minutes', async () => {
    const client = clientOf();
    render(<FrequencyPageV3 client={client} />);
    await ready();
    expect(client.readYear).toHaveBeenCalledOnce();
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(client.readYear).toHaveBeenCalledOnce();
    await act(async () => {
      vi.setSystemTime(new Date('2026-10-21T12:11:00-03:00'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(client.readYear).toHaveBeenCalledTimes(2));
    // The month stays on screen while it is read again.
    expect(screen.getByRole('heading', { level: 3, name: 'Outubro de 2026' })).toBeTruthy();
  });
});
