// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrequencyPageV3 } from '../../../../src/features/student-portal/redesign/frequency-page-v3';
import { IncidentsPageV3 } from '../../../../src/features/student-portal/redesign/incidents-page-v3';
import { PortalPagesV3 } from '../../../../src/features/student-portal/redesign/portal-pages-v3';
import { FrequencyClientErrorV2, createStudentFrequencyClientV2 } from '../../../../src/features/student-portal/frequency/client-v2';
import { createStudentScheduleClientV1 } from '../../../../src/features/student-portal/schedule/client-v1';
import { createStudentIncidentsClientV1 } from '../../../../src/features/student-portal/incidents/client-v1';
import { requestSignalV1 } from '../../../../src/features/student-portal/shared/request-signal-v1';
import { portalFrequencyYearV2 } from '../../../../server/attendance/service-v2';
import { setupOperationsDomV1 } from '../overview/dom-v1';

const setVisibility = (value: 'hidden' | 'visible') =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
const incident = (id: string, description = 'Texto') => ({
  id,
  kind: 'ADVERTENCIA',
  date: '2026-10-20',
  leave: null,
  description,
  acknowledgedAt: null,
});
const ID = '66666666-6666-4666-8666-666666666666';
const pages = (client: unknown) => (
  <PortalPagesV3 schoolName="Escola" hero={<div />} grades={<div>notas</div>} incidents={<IncidentsPageV3 client={client as never} />} />
);

beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setVisibility('visible');
  window.history.replaceState(null, '');
});

describe('an older phone, without AbortSignal.any', () => {
  it('still asks the server on the three pages', async () => {
    const original = AbortSignal.any;
    // @ts-expect-error an older browser
    AbortSignal.any = undefined;
    try {
      const fetcher = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
      const signal = new AbortController().signal;
      await Promise.allSettled([
        createStudentFrequencyClientV2(fetcher as never).readYear(signal),
        createStudentScheduleClientV1(fetcher as never).read(signal),
        createStudentIncidentsClientV1(fetcher as never).read(signal),
      ]);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      AbortSignal.any = original;
    }
  });

  it('ends a read with its caller or after the time limit', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const followed = requestSignalV1(parent.signal);
    expect(followed.aborted).toBe(false);
    parent.abort();
    expect(followed.aborted).toBe(true);
    const timed = requestSignalV1(new AbortController().signal, 1000);
    vi.advanceTimersByTime(1000);
    expect(timed.aborted).toBe(true);
    const late = new AbortController();
    late.abort();
    expect(requestSignalV1(late.signal).aborted).toBe(true);
  });
});

describe('an absence under an open conflict', () => {
  it('leaves its day as an incomplete reading, never "nenhuma falta"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-21T12:00:00-03:00'));
    const year = portalFrequencyYearV2({
      today: '2026-10-21',
      lastReadAt: '2026-10-21T10:00:00Z',
      days: [
        { date: '2026-10-20', shift: 'MATUTINO', slots_json: [1, 2, 3, 4, 5], complete: true },
        { date: '2026-10-19', shift: 'MATUTINO', slots_json: [1, 2, 3, 4, 5], complete: true },
      ],
      origins: [
        {
          occurrence_id: '11111111-1111-4111-8111-111111111111',
          date: '2026-10-20',
          slot: 1,
          shift: 'MATUTINO',
          mark: 'X',
          conflict_id: '22222222-2222-4222-8222-222222222222',
          source_class_label: 'TURMA',
          observed_at: '2026-10-21T10:00:00Z',
          received_at: '2026-10-21T10:00:00Z',
          mapping_valid: true,
        },
      ],
    } as never);
    render(<FrequencyPageV3 client={{ readYear: async () => year }} />);
    const disputed = await screen.findByRole('button', { name: /20 de outubro/u });
    expect(disputed.getAttribute('aria-label')).toMatch(/leitura incompleta/u);
    // The other day of the same month keeps its answer.
    expect(screen.getByRole('button', { name: /19 de outubro/u }).getAttribute('aria-label')).toMatch(/nenhuma falta registrada/u);
  });
});

describe('a page behind the menu', () => {
  it('is read when the phone comes back, if the portal opened in the background', async () => {
    setVisibility('hidden');
    const client = { read: vi.fn(async () => ({ incidents: [incident(ID)] })), acknowledge: vi.fn() };
    render(pages(client));
    expect(client.read).not.toHaveBeenCalled();
    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(document.querySelector('.pa3-nav-badge')?.textContent).toContain('1'));
  });

  it('is read again when the phone comes back to old data, so its badge is right', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-21T12:00:00-03:00'));
    const client = {
      read: vi.fn(async () => ({ incidents: client.read.mock.calls.length === 1 ? [] : [incident(ID)] })),
      acknowledge: vi.fn(),
    };
    render(pages(client));
    await waitFor(() => expect(client.read).toHaveBeenCalledOnce());
    await act(async () => {
      vi.setSystemTime(new Date('2026-10-22T12:00:00-03:00'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(client.read).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.querySelector('.pa3-nav-badge')?.textContent).toContain('1'));
  });

  it('is not read again while its data is recent', async () => {
    const client = { read: vi.fn(async () => ({ incidents: [] })), acknowledge: vi.fn() };
    render(pages(client));
    await waitFor(() => expect(client.read).toHaveBeenCalledOnce());
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(client.read).toHaveBeenCalledOnce();
  });
});

describe('"Vamos tentar de novo em instantes"', () => {
  it('does try again, waiting longer each time up to 5 minutes, and never gives up while it fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const readYear = vi.fn(async () => {
      throw new FrequencyClientErrorV2('unavailable');
    });
    render(<FrequencyPageV3 client={{ readYear }} />);
    expect(await screen.findByText(/Vamos tentar de novo em instantes/u)).toBeTruthy();
    // 30 s, 1, 2, 4 min, then every 5 min.
    for (const [wait, calls] of [[30_000, 2], [60_000, 3], [120_000, 4], [240_000, 5], [300_000, 6], [300_000, 7]] as const) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(wait - 1_000);
      });
      expect(readYear).toHaveBeenCalledTimes(calls - 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(readYear).toHaveBeenCalledTimes(calls);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000_000);
    });
    expect(readYear).toHaveBeenCalledTimes(17);
  });

  it('leaves the error by itself when the server is back, even after many failed tries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let down = true;
    const year = portalFrequencyYearV2({
      today: '2026-10-21',
      lastReadAt: '2026-10-21T10:00:00Z',
      days: [{ date: '2026-10-20', shift: 'MATUTINO', slots_json: [1, 2, 3, 4, 5], complete: true }],
      origins: [],
    } as never);
    const readYear = vi.fn(async () => {
      if (down) throw new FrequencyClientErrorV2('unavailable');
      return year;
    });
    render(<FrequencyPageV3 client={{ readYear }} />);
    expect(await screen.findByText(/Vamos tentar de novo em instantes/u)).toBeTruthy();
    // Past the five tries the page used to stop at (about 2,5 minutes).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * 60_000);
    });
    expect(readYear.mock.calls.length).toBeGreaterThan(6);
    down = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(screen.queryByText(/Vamos tentar de novo em instantes/u)).toBeNull();
  });

  it('does not try again after a policy turned off', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const readYear = vi.fn(async () => {
      throw new FrequencyClientErrorV2('forbidden');
    });
    render(<FrequencyPageV3 client={{ readYear }} />);
    await screen.findByText(/não está disponível no momento/u);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(readYear).toHaveBeenCalledOnce();
  });
});

describe('"A escola alterou uma ocorrência"', () => {
  it('leaves once the new version is confirmed', async () => {
    const first = incident(ID);
    const edited = incident('77777777-7777-4777-8777-777777777777', 'Corrigido');
    const client = {
      read: vi.fn(async () => ({ incidents: client.read.mock.calls.length === 1 ? [first] : [edited] })),
      acknowledge: vi.fn(async (id: string) => {
        if (id === first.id) throw new FrequencyClientErrorV2('changed');
        return { acknowledgedAt: '2026-10-29T12:40:00Z' };
      }),
    };
    render(<IncidentsPageV3 client={client} />);
    const confirmOne = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Toque aqui para confirmar que leu' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Sim, li' }));
    };
    await confirmOne();
    await screen.findByText('Corrigido');
    expect(screen.getByText(/A escola alterou uma ocorrência/u)).toBeTruthy();
    await confirmOne();
    await screen.findByText(/Você confirmou a leitura/u);
    expect(screen.queryByText(/A escola alterou uma ocorrência/u)).toBeNull();
  });
});
