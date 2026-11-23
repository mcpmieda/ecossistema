// @vitest-environment jsdom
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelationalCouncilPageV3 } from '../../../src/features/gradebook/council/relational-council-page-v3';
import { requestRelationalCouncilV3 } from '../../../src/features/gradebook/council/relational-council-client-v3';
import { useGradebookYear } from '../../../src/platform/gradebook-year-context';
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
// The hook keeps the classes of each year while its module lives: every test reads years of its own.
let year = 2024;
/** The class of the journey, with its summary counted from the students. */
function workspace(
  students: readonly RelationalCouncilStudentV3[] = [student, nonEligible],
  state: RelationalCouncilWorkspaceV3['session']['state'] = 'not-opened',
): RelationalCouncilWorkspaceV3 {
  const eligible = students.filter((item) => item.eligibility.eligible);
  const decided = eligible.filter((item) => item.decision !== null);
  return {
    context: { year, minimumApprovalMilli: 60_000, maxCouncilComponents: 2 },
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
/** A class of the answer; without `tally` it is a class the server could not read. The class of
 * the journey (id 10) is always counted from its own students. */
type ListedClass = { id: number; label: string; tally?: RelationalCouncilTallyV3 };
const RETIRED_TEXT =
  /Fechar reunião|Reabrir|Revisar fechamento|Confirmar fechamento|Versão institucional|leitura segura|Sessão (?:aberta|fechada|da turma)|Reunião (?:aberta|reaberta|fechada)\.|Nenhum aluno elegível nesta turma/u;

let host: HTMLDivElement;
let root: Root | null;
let current = workspace();
let listed: ListedClass[];
let years: number[];
// Each one holds its reading until released; the failure flags refuse it.
let classesGate: Promise<void> | null;
let workspaceGate: Promise<void> | null;
let classesFail: boolean;
let workspaceFails: boolean;
let openFails: boolean;
let requests: Record<string, unknown>[];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const reply = (value: unknown, status = 200) => Response.json(value, { status });
const unavailable = () => reply({ contractVersion: 3, state: 'unavailable' }, 503);
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
  // Two years for each test: the one in use and one to change to.
  year += 2;
  years = [year];
  current = workspace();
  listed = [{ id: 10, label: '6A' }];
  classesGate = null;
  workspaceGate = null;
  classesFail = false;
  workspaceFails = false;
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
        years: years.map((item) => ({
          year: item,
          minimumApprovalMilli: 60_000,
          maxCouncilComponents: 2,
        })),
      });
    if (body.operation === 'classes') {
      await classesGate;
      if (classesFail) return unavailable();
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
            ...(tally ? { tally } : {}),
          };
        }),
        nextOffset: null,
      });
    }
    if (body.operation === 'workspace') {
      await workspaceGate;
      if (workspaceFails) return unavailable();
    }
    if (body.operation === 'open') {
      if (openFails) return unavailable();
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
async function unmount() {
  if (root) await act(async () => root!.unmount());
  root = null;
}
afterEach(async () => {
  await unmount();
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
const sent = (operation: string) => requests.filter((request) => request.operation === operation);
/** Mounts the tab and waits until it asks for the classes. */
async function mount(beside: ReactNode = null) {
  const before = sent('classes').length;
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(GradebookYearProvider, null, beside, createElement(RelationalCouncilPageV3)),
    ),
  );
  await waitFor(() => sent('classes').length > before);
}
const group = () => host.querySelector('[role="group"][aria-label="Turmas do Conselho"]');
const classButtons = () => [...host.querySelectorAll<HTMLButtonElement>('button.council-class')];
// The label is the first thing in the button; the tally comes after it.
const labelOf = (item: HTMLButtonElement) => item.firstChild?.textContent;
const classButton = (label: string) => classButtons().find((item) => labelOf(item) === label);
const tally = (label: string) => classButton(label)?.querySelector('.council-tally') ?? null;
const meeting = () => host.querySelector('.council-session');
const summary = () => host.querySelector('[aria-label="Resumo do Conselho"]');
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
async function openClass(label: string) {
  await waitFor(() => classButton(label) !== undefined);
  await act(async () => classButton(label)!.click());
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
  await openClass('6A');
  await waitFor(() => summary() !== null);
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
    // Neither a command of the earlier version nor the retired tally flag leaves the browser.
    const calls = fetchMock.mock.calls.length;
    for (const retired of [
      { contractVersion: 3, operation: 'close', year: 2026, classId: 10 },
      { ...request, tally: true },
    ])
      expect(await requestRelationalCouncilV3(retired as never)).toEqual({
        contractVersion: 3,
        state: 'invalid-request',
      });
    expect(fetchMock.mock.calls).toHaveLength(calls);
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
    await waitFor(() => classButton('6A') !== undefined);
    expect(classButton('6A')?.getAttribute('aria-pressed')).toBe('false');
    expect(classButton('6A')?.hasAttribute('data-selected')).toBe(false);
    await openClass('6A');
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
    expect(tally('6A')?.getAttribute('aria-label')).toBe('2 pendentes');
    expect(tally('6A')?.textContent).toBe('2');
    // The classes are independent buttons, not tabs, and the open one is the pressed one.
    expect(group()?.contains(classButton('6A')!)).toBe(true);
    expect(classButton('6A')?.type).toBe('button');
    expect(classButton('6A')?.getAttribute('aria-pressed')).toBe('true');
    expect(classButton('6A')?.getAttribute('data-selected')).toBe('true');
    expect(
      host.querySelectorAll('[role="tab"], [role="tablist"], .school-class-tabs'),
    ).toHaveLength(0);
    // No form is left on the page.
    expect(
      host.querySelectorAll('[data-slot="select"], textarea, input[type="number"]'),
    ).toHaveLength(0);
  }, 15_000);

  it('asks for the classes once on entering the tab, with no flag, and then only for the class', async () => {
    await openJourney();
    // Pressing the class already open reads nothing again.
    await openClass('6A');
    expect(requests.filter((request) => request.contractVersion === 3)).toEqual([
      { contractVersion: 3, operation: 'classes', year, offset: 0, limit: 100 },
      { contractVersion: 3, operation: 'workspace', year, classId: 10 },
    ]);
  }, 15_000);

  it('opens the meeting once, with only the class scope, and then shows it open', async () => {
    await openJourney();
    expect(meeting()?.textContent).toContain('Ainda não iniciada');
    await click('Abrir reunião');
    expect(sent('open')).toEqual([{ contractVersion: 3, operation: 'open', year, classId: 10 }]);
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
    expect(tally('6A')?.getAttribute('aria-label')).toBe('1 aprovado');
  }, 15_000);

  it('gives a button only to the classes with eligible students, and reads the counts aloud', async () => {
    listed = [
      { id: 31, label: '7A', tally: { approved: 2, rejected: 1, pending: 3 } },
      { id: 32, label: '7B', tally: { approved: 1, rejected: 0, pending: 0 } },
      { id: 33, label: '7C', tally: { approved: 0, rejected: 2, pending: 1 } },
      // Nobody eligible: no button.
      { id: 34, label: '7D', tally: { approved: 0, rejected: 0, pending: 0 } },
      // The reading of this class failed: it comes without its count and stays listed.
      { id: 35, label: '7E' },
    ];
    await mount();
    await waitFor(() => classButtons().length > 0);
    expect(classButtons().map(labelOf)).toEqual(['7A', '7B', '7C', '7E']);
    const read = (label: string) => ({
      label: tally(label)?.getAttribute('aria-label'),
      marks: [...(tally(label)?.querySelectorAll('[data-kind]') ?? [])].map(
        (mark) => `${mark.getAttribute('data-kind')}:${mark.textContent}`,
      ),
    });
    expect(read('7A')).toEqual({
      label: '2 aprovados, 1 reprovado, 3 pendentes',
      marks: ['approved:2', 'rejected:1', 'pending:3'],
    });
    expect(read('7B')).toEqual({ label: '1 aprovado', marks: ['approved:1'] });
    expect(read('7C')).toEqual({
      label: '2 reprovados, 1 pendente',
      marks: ['rejected:2', 'pending:1'],
    });
    expect(tally('7E')?.hasAttribute('data-unavailable')).toBe(true);
    expect(read('7E')).toEqual({ label: 'Contagem indisponível', marks: [] });
    for (const item of classButtons()) {
      expect(item.querySelector('.council-tally')?.getAttribute('role')).toBe('img');
      expect(item.getAttribute('aria-pressed')).toBe('false');
    }
    // Nothing holds the place of a count or marks a class with nobody eligible.
    expect(
      host.querySelectorAll(
        '[data-reading], [data-none], [aria-label="Nenhum elegível"], [role="tab"]',
      ),
    ).toHaveLength(0);
    expect(host.textContent).not.toMatch(RETIRED_TEXT);
    // With classes listed and none open, the page asks for one.
    expect(host.textContent).toContain('Escolha uma turma para abrir a pauta');
    expect(host.textContent).not.toContain('Nenhuma turma com alunos elegíveis');
    expect(sent('classes')).toHaveLength(1);
  }, 15_000);

  it('says so when the year has no class with eligible students', async () => {
    listed = [{ id: 34, label: '7D', tally: { approved: 0, rejected: 0, pending: 0 } }];
    await mount();
    await waitFor(() => host.textContent?.includes('Nenhuma turma com alunos elegíveis') === true);
    expect(group()).toBeNull();
    expect(classButtons()).toHaveLength(0);
    expect(host.textContent).not.toContain('Escolha uma turma para abrir a pauta');
    expect(host.textContent).not.toContain('Operação não concluída');
    expect(button('Tentar novamente')).toBeUndefined();
  }, 15_000);

  it('takes the open class off the list when its reading comes back with nobody eligible', async () => {
    listed = [
      { id: 10, label: '6A' },
      { id: 31, label: '7A', tally: { approved: 0, rejected: 0, pending: 1 } },
    ];
    await mount();
    await waitFor(() => classButton('6A') !== undefined);
    // A grade was corrected after the classes were read.
    current = workspace([nonEligible]);
    await openClass('6A');
    await waitFor(() => classButton('6A') === undefined);
    expect(classButtons().map(labelOf)).toEqual(['7A']);
    expect(classButton('7A')?.getAttribute('aria-pressed')).toBe('false');
    expect(summary()).toBeNull();
    expect(meeting()).toBeNull();
    expect(host.querySelector('[aria-label="Fluxo dos alunos elegíveis"]')).toBeNull();
    expect(host.textContent).toContain('Escolha uma turma para abrir a pauta');
    expect(host.textContent).not.toMatch(RETIRED_TEXT);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
    // The class left without the classes being asked for again.
    expect(sent('classes')).toHaveLength(1);
  }, 15_000);

  it('offers to try again when the classes could not be read, and reads them again', async () => {
    classesFail = true;
    await mount();
    await waitFor(() => host.textContent?.includes('Operação não concluída') === true);
    expect(classButtons()).toHaveLength(0);
    // A failed reading is not a year without classes.
    expect(host.textContent).not.toContain('Nenhuma turma com alunos elegíveis');
    classesFail = false;
    await click('Tentar novamente');
    await waitFor(() => classButton('6A') !== undefined);
    expect(host.textContent).not.toContain('Operação não concluída');
    expect(button('Tentar novamente')).toBeUndefined();
    expect(sent('classes')).toHaveLength(2);
  }, 15_000);

  it('reads the open class again, and not the classes, when its reading failed', async () => {
    workspaceFails = true;
    await mount();
    await openClass('6A');
    await waitFor(() => host.textContent?.includes('Operação não concluída') === true);
    expect(classButton('6A')?.getAttribute('aria-pressed')).toBe('true');
    expect(summary()).toBeNull();
    workspaceFails = false;
    await click('Tentar novamente');
    await waitFor(() => meeting() !== null);
    expect(host.textContent).not.toContain('Operação não concluída');
    expect(sent('workspace')).toHaveLength(2);
    expect(sent('classes')).toHaveLength(1);
  }, 15_000);

  it('shows the classes read before at once on coming back to the tab, then replaces them', async () => {
    await mount();
    await waitFor(() => classButton('6A') !== undefined);
    await unmount();
    listed = [...listed, { id: 61, label: '9B', tally: { approved: 0, rejected: 0, pending: 2 } }];
    const reading = deferred();
    classesGate = reading.promise;
    await mount();
    // The new reading is still on its way.
    expect(classButtons().map(labelOf)).toEqual(['6A']);
    expect(tally('6A')?.getAttribute('aria-label')).toBe('1 pendente');
    await act(async () => reading.resolve());
    await waitFor(() => classButton('9B') !== undefined);
    expect(classButtons().map(labelOf)).toEqual(['6A', '9B']);
    expect(sent('classes')).toHaveLength(2);
  }, 15_000);

  it('closes the class of another year when the year changes', async () => {
    // The catalogue lists the years from the newest; the first one is the year in use.
    years = [year, year - 1];
    let selectYear: (next: number) => void = () => {};
    const Probe = () => {
      const scope = useGradebookYear();
      useEffect(() => {
        if (scope) selectYear = scope.selectYear;
      }, [scope]);
      return null;
    };
    await mount(createElement(Probe));
    await openClass('6A');
    await waitFor(() => meeting() !== null);
    listed = [{ id: 51, label: '9A', tally: { approved: 1, rejected: 0, pending: 1 } }];
    await act(async () => selectYear(year - 1));
    await waitFor(() => classButton('9A') !== undefined);
    expect(classButtons().map(labelOf)).toEqual(['9A']);
    expect(classButton('9A')?.getAttribute('aria-pressed')).toBe('false');
    expect(summary()).toBeNull();
    expect(meeting()).toBeNull();
    expect(host.textContent).toContain('Escolha uma turma para abrir a pauta');
    // The other year was asked only for its classes.
    expect(requests.filter((request) => request.year === year - 1)).toEqual([
      { contractVersion: 3, operation: 'classes', year: year - 1, offset: 0, limit: 100 },
    ]);
  }, 15_000);

  it('keeps the active surface disconnected from legacy year and Council clients', () => {
    const surface = readFileSync('src/platform/gradebook-council-surface.tsx', 'utf8');
    expect(surface).toContain('RelationalCouncilPageV3');
    expect(surface).not.toMatch(
      /resolveLegacyAcademicYear|CouncilWorkspacePage|CouncilInstitutionalPanelV2|requestOperationalWorkspaceV1/u,
    );
  });
});
