// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelationalCouncilPageV3 } from '../../../src/features/gradebook/council/relational-council-page-v3';
import { requestRelationalCouncilV3 } from '../../../src/features/gradebook/council/relational-council-client-v3';
import { GradebookYearProvider } from '../../../src/platform/gradebook-year-provider';
import {
  relationalCouncilTallyV3,
  type RelationalCouncilStudentV3,
  type RelationalCouncilTallyV3,
  type RelationalCouncilWorkspaceV3,
} from '../../../shared/gradebook-contracts/council/relational-council-v3';

const grade = (valueMilli: number | null, maximumMilli = 30_000, state = 'complete' as const) => ({
  valueMilli,
  maximumMilli,
  state,
});
const student: RelationalCouncilStudentV3 = {
  id: 1,
  name: 'ALUNO SINTETICO',
  number: 1,
  statusLabel: 'Em curso',
  eligibility: {
    eligible: true,
    code: 'eligible' as const,
    label: 'Elegível ao Conselho Final em 2026.',
    failedComponentCount: 1,
  },
  calculatedResult: null,
  decision: null,
  components: [
    {
      offerId: 10,
      subject: { id: 1, label: 'MATEMATICA', abbreviation: 'M' },
      terms: [grade(10_000), grade(12_000), grade(13_000, 40_000)],
      recovery: grade(40_000, 100_000),
      result: 'not-approved' as const,
    },
  ],
};
const nonEligible: RelationalCouncilStudentV3 = {
  ...student,
  id: 2,
  name: 'ALUNO APROVADO',
  number: 2,
  eligibility: {
    eligible: false,
    code: 'approved' as const,
    label: 'APROVADO DIRETO',
    failedComponentCount: 0,
  },
  calculatedResult: 'APROVADO DIRETO',
  components: [{ ...student.components[0]!, result: 'approved-direct' as const }],
};
/** The class of the journey, with its summary counted from the students. */
function workspace(
  students: readonly RelationalCouncilStudentV3[] = [student, nonEligible],
  state: RelationalCouncilWorkspaceV3['session']['state'] = 'not-opened',
): RelationalCouncilWorkspaceV3 {
  const eligible = students.filter((item) => item.eligibility.eligible);
  const decided = eligible.filter((item) => item.decision !== null);
  return {
    context: { year: 2026, minimumApprovalMilli: 60_000, maxCouncilComponents: 2 },
    classGroup: { id: 10, label: '6A', name: 'TURMA SINTETICA' },
    readAt: '2026-09-11T04:00:00.000Z',
    authority: 'calculated-eligibility-explicit-human-decision',
    session: { state },
    summary: {
      total: students.length,
      eligible: eligible.length,
      decided: decided.length,
      pending: eligible.length - decided.length,
      approved: decided.filter((item) => item.decision?.code === 1).length,
      rejected: decided.filter((item) => item.decision?.code === 2).length,
      absence: decided.filter((item) => item.decision?.code === 3).length,
      notEligible: students.length - eligible.length,
    },
    students: [...students],
  };
}
/** A class button of the list; `tally` is what the count reading brings for it, if anything. */
type ListedClass = { id: number; label: string; tally?: RelationalCouncilTallyV3 };
const RETIRED_TEXT =
  /Fechar reunião|Reabrir|Revisar fechamento|Confirmar fechamento|Versão institucional|leitura segura|Sessão (?:aberta|fechada|da turma)|Reunião (?:aberta|reaberta|fechada)\./u;

let host: HTMLDivElement;
let root: Root | null;
let current = workspace();
let listed: ListedClass[];
// Each one holds its reading until released; the failure flags refuse it.
let tallyGate: Promise<void> | null;
let workspaceGate: Promise<void> | null;
let tallyFails: boolean;
let openFails: boolean;
let requests: Record<string, unknown>[];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const reply = (value: unknown, status = 200) => Response.json(value, { status });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: false,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => true,
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  // No class comes back selected from the test before.
  sessionStorage.clear();
  current = workspace();
  listed = [{ id: 10, label: '6A' }];
  tallyGate = null;
  workspaceGate = null;
  tallyFails = false;
  openFails = false;
  requests = [];
  fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (body.operation === 'bootstrap')
      return reply({
        contractVersion: 2,
        state: 'ready',
        operation: 'bootstrap',
        years: [{ year: 2026, minimumApprovalMilli: 60_000, maxCouncilComponents: 2 }],
      });
    if (body.operation === 'classes') {
      if (body.tally === true) {
        await tallyGate;
        if (tallyFails) return reply({ contractVersion: 3, state: 'unavailable' }, 503);
      }
      return reply({
        contractVersion: 3,
        state: 'ready',
        operation: 'classes',
        year: Number(body.year),
        classes: listed.map((item) => {
          const journey = item.id === current.classGroup.id;
          const tally = journey ? relationalCouncilTallyV3(current.summary) : item.tally;
          return {
            id: item.id,
            label: item.label,
            name: 'TURMA SINTETICA',
            sessionState: journey ? current.session.state : 'not-opened',
            ...(body.tally === true && tally ? { tally } : {}),
          };
        }),
        nextOffset: null,
      });
    }
    if (body.operation === 'workspace') await workspaceGate;
    if (body.operation === 'open') {
      if (openFails) return reply({ contractVersion: 3, state: 'unavailable' }, 503);
      current = workspace(current.students, 'open');
    }
    return reply({
      contractVersion: 3,
      state: 'ready',
      operation: body.operation,
      workspace: current,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = null;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await settle();
  }
  expect(predicate()).toBe(true);
}
async function mount() {
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(GradebookYearProvider, null, createElement(RelationalCouncilPageV3)),
    ),
  );
  await waitFor(() => requests.some((request) => request.operation === 'classes'));
}
const tab = (id: number) =>
  host.querySelector<HTMLElement>(
    `[role="tablist"][aria-label="Turmas do Conselho"] [data-key="${id}"]`,
  );
const tally = (id: number) => tab(id)?.querySelector('.council-tally') ?? null;
const meeting = () => host.querySelector('.council-session');
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
async function openClass(id: number) {
  await waitFor(() => tab(id) !== null);
  await act(async () => tab(id)!.click());
  await settle();
}
async function click(label: string) {
  expect(button(label)).toBeDefined();
  await act(async () => button(label)!.click());
  await settle();
}
/** Mounts the page and opens the class of the journey. */
async function openJourney() {
  await mount();
  await openClass(10);
  await waitFor(() => host.querySelector('[aria-label="Resumo do Conselho"]') !== null);
}

describe('relational Council V3 client and HeroUI journey', () => {
  it('validates scope and uses the same-origin no-store transport', async () => {
    const request = {
      contractVersion: 3,
      operation: 'classes',
      year: 2026,
      offset: 0,
      limit: 100,
    } as const;
    await requestRelationalCouncilV3(request);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/gradebook/council-workspace',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }),
    );
    expect(await requestRelationalCouncilV3({ ...request, year: 2025 })).toMatchObject({
      contractVersion: 3,
      state: 'ready',
      operation: 'classes',
      year: 2025,
    });
    // A command of the earlier version never leaves the browser.
    const sent = fetchMock.mock.calls.length;
    expect(
      await requestRelationalCouncilV3({
        contractVersion: 3,
        operation: 'close',
        year: 2026,
        classId: 10,
      } as never),
    ).toEqual({ contractVersion: 3, state: 'invalid-request' });
    expect(fetchMock.mock.calls).toHaveLength(sent);
  });

  it('renders the static Kanban-inspired queue and annual table without timeline, snapshots or prior-year controls', async () => {
    const second: RelationalCouncilStudentV3 = {
      ...student,
      id: 3,
      name: 'ALUNA SINTETICA',
      number: 3,
      eligibility: { ...student.eligibility, failedComponentCount: 2 },
    };
    current = workspace([student, second, nonEligible]);
    const reading = deferred();
    workspaceGate = reading.promise;
    await mount();
    await openClass(10);
    // While the class is read the page says only that it is loading.
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('Carregando…');
    await act(async () => reading.resolve());
    await waitFor(() => host.textContent?.includes(student.name) === true);
    expect(host.textContent).not.toContain('Carregando');
    expect(host.textContent).toContain('A deliberar');
    expect(host.textContent).toContain('1º tri.');
    expect(host.textContent).toContain('REC');
    // Each card says how many components are below the minimum; nobody is decided, so no group.
    expect(
      [...host.querySelectorAll('.council-queue-card')].map((card) => card.textContent),
    ).toEqual([`1${student.name}1 componente abaixo`, `3${second.name}2 componentes abaixo`]);
    expect(host.textContent).not.toContain('Decididos');
    // The student in discussion is marked eligible by the chip alone, with no alert above the table.
    expect(host.textContent).toContain('Elegível');
    expect(host.textContent).not.toContain(student.eligibility.label);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(host.textContent).not.toMatch(/Não elegíveis|Decisão humana|Contagem opcional/u);
    expect(host.textContent).not.toMatch(/Linha do tempo|Fechamentos preservados|snapshot/iu);
    expect(host.textContent).not.toMatch(
      /Conselho anterior|ano anterior|catálogo legado|voto de minerva|diretor/iu,
    );
    expect(host.textContent).not.toMatch(RETIRED_TEXT);
    expect(host.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    // The class button says where the class stands, with counts and no words.
    expect(tally(10)?.getAttribute('aria-label')).toBe('2 pendentes');
    expect(tally(10)?.textContent).toBe('2');
    // The classes are tabs, and no form is left on the page.
    expect(
      host.querySelectorAll('[role="tablist"][aria-label="Turmas do Conselho"] [role="tab"]')
        .length,
    ).toBeGreaterThan(0);
    expect(
      host.querySelectorAll('[data-slot="select"], textarea, input[type="number"]'),
    ).toHaveLength(0);
  }, 15_000);

  it('opens the meeting once, with only the class scope, and then shows it open', async () => {
    await openJourney();
    expect(meeting()?.textContent).toContain('Ainda não iniciada');
    await click('Abrir reunião');
    expect(requests.filter((request) => request.operation === 'open')).toEqual([
      { contractVersion: 3, operation: 'open', year: 2026, classId: 10 },
    ]);
    // The open meeting has no button left, and nothing announces the command.
    await waitFor(() => meeting()?.textContent?.includes('Aberta') === true);
    expect(meeting()?.textContent).not.toContain('Ainda não iniciada');
    expect(button('Abrir reunião')).toBeUndefined();
    expect(host.textContent).toContain(student.name);
    expect(host.textContent).not.toMatch(RETIRED_TEXT);
    // Recording a decision or a count is being redone: the open meeting offers neither form.
    expect(host.textContent).not.toMatch(/Decisão humana|Contagem opcional|Não elegíveis/u);
    expect(
      host.querySelectorAll('[data-slot="select"], textarea, input[type="number"]'),
    ).toHaveLength(0);
  }, 15_000);

  it('keeps the button and shows the failure when the meeting could not be opened', async () => {
    openFails = true;
    await openJourney();
    await click('Abrir reunião');
    await waitFor(() => host.textContent?.includes('Operação não concluída') === true);
    expect(meeting()?.textContent).toContain('Ainda não iniciada');
    expect(button('Abrir reunião')).toBeDefined();
    expect(host.textContent).toContain(student.name);
  }, 15_000);

  it('shows an open meeting with nobody pending as concluded, with the decided students', async () => {
    const decided: RelationalCouncilStudentV3 = {
      ...student,
      decision: {
        code: 1,
        label: 'APROVADO PELO CONSELHO',
        justification: 'Deliberação sintética.',
        updatedAt: '2026-11-20T12:00:00.000Z',
      },
    };
    current = workspace([decided, nonEligible], 'open');
    await openJourney();
    expect(meeting()?.textContent).toContain('Concluída');
    expect(button('Abrir reunião')).toBeUndefined();
    expect(host.textContent).toContain('Fila concluída');
    expect(host.textContent).toContain('Decididos');
    expect(host.querySelector('.council-queue-card')?.textContent).toBe(
      `1${decided.name}APROVADO PELO CONSELHO`,
    );
    expect(tally(10)?.getAttribute('aria-label')).toBe('1 aprovado');
  }, 15_000);

  it('offers no meeting to a class without eligible students', async () => {
    current = workspace([nonEligible]);
    await openJourney();
    expect(host.textContent).toContain('Nenhum aluno elegível nesta turma');
    expect(meeting()).toBeNull();
    expect(button('Abrir reunião')).toBeUndefined();
    expect(host.querySelector('[aria-label="Fluxo dos alunos elegíveis"]')).toBeNull();
  }, 15_000);

  it('holds the place of each class count while it is read, then reads the counts aloud', async () => {
    listed = [
      { id: 31, label: '7A', tally: { approved: 2, rejected: 1, pending: 3 } },
      { id: 32, label: '7B', tally: { approved: 1, rejected: 0, pending: 0 } },
      { id: 33, label: '7C', tally: { approved: 0, rejected: 2, pending: 1 } },
      { id: 34, label: '7D', tally: { approved: 0, rejected: 0, pending: 0 } },
      // The reading of this class failed: the list comes without its count.
      { id: 35, label: '7E' },
    ];
    const reading = deferred();
    tallyGate = reading.promise;
    await mount();
    await waitFor(() => tally(35) !== null);
    for (const item of listed) {
      expect(tally(item.id)?.hasAttribute('data-reading')).toBe(true);
      expect(tally(item.id)?.getAttribute('aria-hidden')).toBe('true');
      expect(tally(item.id)?.textContent).toBe('');
    }
    await act(async () => reading.resolve());
    await waitFor(() => tally(31)?.hasAttribute('data-reading') === false);
    const read = (id: number) => ({
      label: tally(id)?.getAttribute('aria-label'),
      marks: [...(tally(id)?.querySelectorAll('[data-kind]') ?? [])].map(
        (mark) => `${mark.getAttribute('data-kind')}:${mark.textContent}`,
      ),
    });
    expect(read(31)).toEqual({
      label: '2 aprovados, 1 reprovado, 3 pendentes',
      marks: ['approved:2', 'rejected:1', 'pending:3'],
    });
    expect(read(32)).toEqual({ label: '1 aprovado', marks: ['approved:1'] });
    expect(read(33)).toEqual({
      label: '2 reprovados, 1 pendente',
      marks: ['rejected:2', 'pending:1'],
    });
    for (const id of [31, 32, 33, 34, 35]) expect(tally(id)?.getAttribute('role')).toBe('img');
    // A class with nobody eligible keeps the place with a dash; a failed reading says so.
    expect(tally(34)?.hasAttribute('data-none')).toBe(true);
    expect(read(34)).toEqual({ label: 'Nenhum elegível', marks: [] });
    expect(tally(35)?.hasAttribute('data-unavailable')).toBe(true);
    expect(read(35)).toEqual({ label: 'Contagem indisponível', marks: [] });
  }, 15_000);

  it('marks the classes never counted as unavailable when the counts do not come', async () => {
    listed = [
      { id: 41, label: '8A' },
      { id: 42, label: '8B' },
    ];
    tallyFails = true;
    await mount();
    await waitFor(() => tally(41)?.hasAttribute('data-unavailable') === true);
    for (const id of [41, 42]) {
      expect(tally(id)?.getAttribute('role')).toBe('img');
      expect(tally(id)?.getAttribute('aria-label')).toBe('Contagem indisponível');
    }
  }, 15_000);

  it('keeps the active surface disconnected from legacy year and Council clients', () => {
    const surface = readFileSync('src/platform/gradebook-council-surface.tsx', 'utf8');
    expect(surface).toContain('RelationalCouncilPageV3');
    expect(surface).not.toMatch(
      /resolveLegacyAcademicYear|CouncilWorkspacePage|CouncilInstitutionalPanelV2|requestOperationalWorkspaceV1/u,
    );
  });
});
