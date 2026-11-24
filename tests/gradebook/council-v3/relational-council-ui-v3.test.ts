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
  relationalCouncilInformedV3,
  relationalCouncilTallyV3,
  relationalCouncilVotableV3,
  type RelationalCouncilStudentV3,
  type RelationalCouncilTallyV3,
  type RelationalCouncilWorkspaceV3,
} from '../../../shared/gradebook-contracts/council/relational-council-v3';

const COUNCIL_ROUTE = '/api/gradebook/council-workspace';
type Component = RelationalCouncilStudentV3['components'][number];
type Grade = Component['annual'];
type Code = RelationalCouncilStudentV3['eligibility']['code'];
const grade = (
  valueMilli: number | null,
  level: Grade['level'] = 'below',
  state: Grade['state'] = 'complete',
): Grade => ({ valueMilli, state, level });
/** A mark with no value: a REC that does not apply, unless another state is given. */
const none = (state: Grade['state'] = 'not-applicable'): Grade =>
  grade(null, 'not-classified', state);
const reached = (valueMilli: number) => grade(valueMilli, 'at-or-above');
// Recovered in two terms and still below the minimum of the year.
const mathematics: Component = {
  offerId: 10,
  subject: 'MATEMATICA',
  terms: [grade(10_000), reached(18_000), grade(6_750)],
  termRecoveries: [grade(12_000), none(), grade(15_000)],
  annual: grade(34_750),
  recovery: grade(45_000),
  result: 'not-approved',
};
const portuguese: Component = {
  offerId: 11,
  subject: 'PORTUGUES',
  terms: [reached(20_000), reached(25_000), reached(30_000)],
  termRecoveries: [none(), none(), none()],
  annual: reached(75_000),
  recovery: none(),
  result: 'approved-direct',
};
const student: RelationalCouncilStudentV3 = {
  id: 1,
  name: 'ALUNO SINTETICO',
  number: 1,
  eligibility: { eligible: true, code: 'eligible', failedComponentCount: 1 },
  decision: null,
  components: [mathematics, portuguese],
};
/** Another student before the Conselho, by the case of its eligibility. */
const cased = (
  id: number,
  name: string,
  code: Code,
  extra: Partial<RelationalCouncilStudentV3> = {},
): RelationalCouncilStudentV3 => ({
  ...student,
  id,
  name,
  number: id,
  eligibility: { eligible: code === 'eligible', code, failedComponentCount: 1 },
  ...extra,
});
// Missed the recovery of the first term (N/C in the sheet).
const noShow = cased(4, 'ALUNA AUSENTE', 'failed-no-show', {
  components: [
    {
      ...mathematics,
      termRecoveries: [none('no-show'), none(), grade(15_000)],
      recovery: none('no-show'),
      result: 'failed-no-show',
    },
    portuguese,
  ],
});
// Failed by the school's rules (R/R in the sheet).
const repeat = cased(5, 'ALUNO DO REGIMENTO', 'failed-repeat', {
  components: [
    {
      ...mathematics,
      termRecoveries: [grade(null, 'below', 'repeat-failure'), none(), none('recovery-pending')],
      recovery: grade(null, 'below', 'repeat-failure'),
      result: 'failed-repeat',
    },
    portuguese,
  ],
});
// Owes a recovery the sheet has not brought yet.
const recoveryPending = cased(6, 'ALUNA COM RECUPERACAO', 'recovery-pending', {
  components: [
    {
      ...mathematics,
      termRecoveries: [none('recovery-pending'), none(), none('recovery-pending')],
      recovery: none('recovery-pending'),
      result: 'recovery-pending',
    },
    portuguese,
  ],
});
// The hook keeps the classes of each year while its module lives: every test reads years of its own.
let year = 2024;
/** The class of the journey, with its summary counted from the students before the Conselho and
 * from the classmates who are not sent (approved, transferred and so on). */
function workspace(
  students: readonly RelationalCouncilStudentV3[] = [student],
  state: RelationalCouncilWorkspaceV3['session']['state'] = 'not-opened',
  classmates = 1,
): RelationalCouncilWorkspaceV3 {
  const votable = students.filter(relationalCouncilVotableV3);
  const decided = votable.filter((item) => item.decision !== null);
  return {
    context: { year },
    classGroup: { id: 10, label: '6A' },
    session: { state },
    summary: {
      total: students.length + classmates,
      decided: decided.length,
      pending: votable.length - decided.length,
      approved: decided.filter((item) => item.decision?.code === 1).length,
      rejected: decided.filter((item) => item.decision?.code === 2).length,
      absence: decided.filter((item) => item.decision?.code === 3).length,
      forInformation: students.filter(relationalCouncilInformedV3).length,
    },
    students: [...students],
  };
}
/** A class of the answer; without `tally` it is a class the server could not read. The class of
 * the journey (id 10) is always counted from its own students. */
type ListedClass = { id: number; label: string; tally?: RelationalCouncilTallyV3 };
const counts = (
  approvedCount: number,
  rejected: number,
  pending: number,
  forInformation = 0,
): RelationalCouncilTallyV3 => ({ approved: approvedCount, rejected, pending, forInformation });
const RETIRED_TEXT =
  /Fechar reunião|Reabrir|Revisar fechamento|Confirmar fechamento|Versão institucional|leitura segura|Sessão (?:aberta|fechada|da turma)|Reunião (?:aberta|reaberta|fechada)\.|Nenhum aluno elegível nesta turma|Nenhuma turma com alunos elegíveis|Não elegíveis|Decisão humana|Contagem opcional|Em curso|Elegível ao Conselho|decisão explícita/u;

let host: HTMLDivElement;
let root: Root | null;
let current = workspace();
let listed: ListedClass[];
let years: number[];
// Each one holds its reading until released; the failure flags refuse it.
let classesGate: Promise<void> | null;
let workspaceGate: Promise<void> | null;
let classesFail: false | 'unavailable' | 'scope-too-large';
let workspaceFails: boolean;
let openFails: boolean;
/** What was asked of the Conselho, in order. */
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
/** The answer of the Conselho to one request. */
async function council(body: Record<string, unknown>) {
  if (body.operation === 'classes') {
    await classesGate;
    if (classesFail === 'scope-too-large')
      return reply({ contractVersion: 3, state: 'scope-too-large' }, 422);
    if (classesFail) return unavailable();
    return reply({
      contractVersion: 3,
      state: 'ready',
      operation: 'classes',
      year: Number(body.year),
      classes: listed.map((item) => {
        const journey = item.id === current.classGroup.id;
        const tally = journey ? relationalCouncilTallyV3(current.summary) : item.tally;
        return { id: item.id, label: item.label, ...(tally ? { tally } : {}) };
      }),
    });
  }
  if (body.operation === 'workspace') {
    await workspaceGate;
    if (workspaceFails) return unavailable();
  }
  if (body.operation === 'open') {
    if (openFails) return unavailable();
    current = workspace(current.students, 'open', current.summary.total - current.students.length);
  }
  return reply({
    contractVersion: 3,
    state: 'ready',
    operation: body.operation,
    workspace: current,
  });
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
  fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
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
    // The photos of the cards and anything else the page asks for: nothing there.
    if (url !== COUNCIL_ROUTE) return new Response(null, { status: 404 });
    requests.push(body);
    return council(body);
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
/** What the tab kept of the Conselho before a reload. */
const keepView = (view: { year: number; classId: number }) =>
  sessionStorage.setItem('ecossistema-view-v1:gradebook-council-view', JSON.stringify(view));
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
const all = <T extends Element = HTMLElement>(selector: string) => [
  ...host.querySelectorAll<T>(selector),
];
const group = () => host.querySelector('[role="group"][aria-label="Turmas do Conselho"]');
const classButtons = () => all<HTMLButtonElement>('button.council-class');
// The label is the first thing in the button; the tally comes after it.
const labelOf = (item: HTMLButtonElement) => item.firstChild?.textContent;
const classButton = (label: string) => classButtons().find((item) => labelOf(item) === label);
const tally = (label: string) => classButton(label)?.querySelector('.council-tally') ?? null;
const meeting = () => host.querySelector('.council-session');
const summary = () => host.querySelector('[aria-label="Resumo do Conselho"]');
const kpis = () => all('.council-kpi').map((item) => item.textContent);
/** The groups of the queue: title, count and what each card says. */
const board = () =>
  all('.council-board__column').map((column) => ({
    title: column.querySelector('header strong')?.textContent,
    count: column.querySelector('header strong + span')?.textContent,
    cards: [...column.querySelectorAll('.council-queue-card')].map((card) => card.textContent),
  }));
const queueCard = (name: string) =>
  all<HTMLButtonElement>('.council-queue-card').find((card) => card.textContent?.includes(name));
/** The card on top of the pile. */
const card = () => host.querySelector<HTMLElement>('.council-card[data-offset="0"]');
/** The year's end on the card on top: the seal and, when there is one, the reason under it. */
const situation = () =>
  [...(card()?.querySelector('.council-card__status')?.children ?? [])].map(
    (item) => `${item.tagName.toLowerCase()}:${item.textContent}`,
  );
/** What is drawn of an element: its text without the words kept for who cannot see it. */
function drawn(item: Element) {
  const copy = item.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('.sr-only')) hidden.remove();
  return copy.textContent;
}
/** The report card on top, row by row, as it is drawn. */
const report = () =>
  [...(card()?.querySelectorAll('.council-report tr') ?? [])].map((row) =>
    [...row.children].map(drawn),
  );
/** Every mark of the report card on top, with the background it gets. */
const marks = () =>
  [...(card()?.querySelectorAll('.council-report td > span') ?? [])].map(
    (item) => `${item.getAttribute('data-level')}:${drawn(item)}`,
  );
/** The report card on top as it is read aloud, cell by cell, for the cells that say more. */
const spoken = () =>
  [...(card()?.querySelectorAll('.council-report :is(th, td)') ?? [])]
    .filter((cell) => cell.querySelector('.sr-only') !== null)
    .map((cell) => cell.textContent);
const pile = () =>
  all('.council-deck > article.council-card').map((item) => ({
    name: item.getAttribute('aria-label'),
    offset: item.dataset.offset,
    inert: item.hasAttribute('inert'),
    filled: item.querySelector('.council-card__header') !== null,
  }));
const arrow = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button.council-deck__arrow[aria-label="${label}"]`);
const dots = () => all<HTMLButtonElement>('.council-pager button');
/** Where the dot of the student on top is, among the dots. */
const currentDot = () =>
  dots().flatMap((dot, index) => (dot.hasAttribute('data-current') ? [index] : []));
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
async function press(target: HTMLElement | null | undefined) {
  expect(target).toBeTruthy();
  await act(async () => target!.click());
  await settle();
}
async function openClass(label: string) {
  await waitFor(() => classButton(label) !== undefined);
  await press(classButton(label));
}
const click = (label: string) => press(button(label));
/** Mounts the page and opens the class of the journey. */
async function openJourney() {
  await mount();
  await openClass('6A');
  await waitFor(() => summary() !== null);
}

describe('relational Council V3 client and HeroUI journey', () => {
  it('validates scope and uses the same-origin no-store transport', async () => {
    const request = { contractVersion: 3, operation: 'classes', year: 2026 } as const;
    await requestRelationalCouncilV3(request);
    expect(fetchMock).toHaveBeenCalledWith(
      COUNCIL_ROUTE,
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }),
    );
    expect(await requestRelationalCouncilV3({ ...request, year: 2025 })).toMatchObject({
      contractVersion: 3,
      state: 'ready',
      operation: 'classes',
      year: 2025,
    });
    // Neither a command of the earlier version nor the retired page and tally flag leave the browser.
    const calls = fetchMock.mock.calls.length;
    for (const retired of [
      { contractVersion: 3, operation: 'close', year: 2026, classId: 10 },
      { ...request, tally: true },
      { ...request, offset: 0, limit: 100 },
    ])
      expect(await requestRelationalCouncilV3(retired as never)).toEqual({
        contractVersion: 3,
        state: 'invalid-request',
      });
    expect(fetchMock.mock.calls).toHaveLength(calls);
  });

  it('answers unavailable to a reading of another class, of another year or in an earlier shape', async () => {
    const request = { contractVersion: 3, operation: 'workspace', year, classId: 10 } as const;
    expect(await requestRelationalCouncilV3(request)).toMatchObject({ state: 'ready' });
    for (const answer of [
      { ...current, classGroup: { id: 11, label: '6B' } },
      { ...current, context: { year: year - 1 } },
      { ...current, readAt: '2026-09-11T04:00:00.000Z' },
      { ...current, summary: { ...current.summary, pending: 0 } },
      // A classmate who is not before the Conselho is never part of the answer.
      {
        ...current,
        students: [
          ...current.students,
          { ...student, id: 2, eligibility: { ...student.eligibility, code: 'approved' } },
        ],
      },
      { ...current, summary: { ...current.summary, total: 0 } },
    ]) {
      fetchMock.mockResolvedValueOnce(
        reply({ contractVersion: 3, state: 'ready', operation: 'workspace', workspace: answer }),
      );
      expect(await requestRelationalCouncilV3(request)).toEqual({
        contractVersion: 3,
        state: 'unavailable',
      });
    }
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect(await requestRelationalCouncilV3(request)).toEqual({
      contractVersion: 3,
      state: 'not-authorized',
    });
  });

  it('lists the queue and shows the student under discussion as a report card', async () => {
    const second = cased(3, 'ALUNA SINTETICA', 'eligible', {
      eligibility: { eligible: true, code: 'eligible', failedComponentCount: 2 },
    });
    current = workspace([student, second]);
    const reading = deferred();
    workspaceGate = reading.promise;
    await mount();
    await waitFor(() => classButton('6A') !== undefined);
    expect(classButton('6A')?.getAttribute('aria-pressed')).toBe('false');
    expect(classButton('6A')?.hasAttribute('data-selected')).toBe(false);
    await openClass('6A');
    // While the class is read the page says only that it is loading.
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('Carregando…');
    expect(host.querySelector('[aria-live="polite"] output')).toBeNull();
    await act(async () => reading.resolve());
    await waitFor(() => host.textContent?.includes(student.name) === true);
    expect(host.textContent).not.toContain('Carregando');
    expect(kpis()).toEqual(['3alunos', '2elegíveis', '2a deliberar', '0decididos']);
    // The class counts its three students; only the two before the Conselho came and are shown.
    // Each card says how many components are below the minimum; nobody is decided or only for
    // information, so neither group is there.
    expect(host.querySelector('.council-board')?.getAttribute('aria-label')).toBe(
      'Fila do Conselho',
    );
    expect(board()).toEqual([
      {
        title: 'A deliberar',
        count: '2',
        cards: [`1${student.name}1 componente abaixo`, `3${second.name}2 componentes abaixo`],
      },
    ]);
    expect(queueCard(student.name)?.getAttribute('aria-pressed')).toBe('true');
    expect(queueCard(second.name)?.getAttribute('aria-pressed')).toBe('false');
    // The card on top: who it is and the year's end, not approved until the Conselho decides.
    expect(card()?.getAttribute('aria-label')).toBe(student.name);
    expect(card()?.getAttribute('data-tone')).toBe('danger');
    expect(card()?.querySelector('h3')?.textContent).toBe(student.name);
    expect(card()?.querySelector('.council-card__name p')?.textContent).toBe('Nº 1');
    expect(situation()).toEqual(['strong:Reprovado']);
    // The report card: a column for each component, the mark and the REC of each term, and the
    // total of the year, with the recovery only where it is complete.
    expect(card()?.querySelector('.council-report')?.getAttribute('aria-label')).toBe(
      `Notas do ano de ${student.name}`,
    );
    expect(report()).toEqual([
      ['', 'MATEMATICA', 'PORTUGUES'],
      ['1º tri.', 'Nota', '10,0', '20,0'],
      ['REC', '12,0', ''],
      ['2º tri.', 'Nota', '18,0', '25,0'],
      ['REC', '', ''],
      ['3º tri.', 'Nota', '6,75', '30,0'],
      ['REC', '15,0', ''],
      ['Nota final', '45,0', '75,0'],
    ]);
    expect(marks()).toEqual([
      'below:10,0',
      'at-or-above:20,0',
      'below:12,0',
      'at-or-above:18,0',
      'at-or-above:25,0',
      'below:6,75',
      'at-or-above:30,0',
      'below:15,0',
      'below:45,0',
      'at-or-above:75,0',
    ]);
    // Only the column of the component the student did not pass is tinted, header included.
    const tinted = [...(card()?.querySelectorAll('.council-report [data-failed]') ?? [])];
    expect(tinted.filter((cell) => cell.tagName === 'TH').map(drawn)).toEqual(['MATEMATICA']);
    expect(tinted.filter((cell) => cell.tagName === 'TD')).toHaveLength(7);
    // What the colours say is also said in words, for who does not see them.
    expect(spoken()).toEqual([
      'MATEMATICA (não aprovado)',
      '10,0 (abaixo do mínimo)',
      '12,0 (abaixo do mínimo)',
      '6,75 (abaixo do mínimo)',
      '15,0 (abaixo do mínimo)',
      '45,0 (abaixo do mínimo)',
    ]);
    // Each term is a group of rows of its own, named by the term.
    const terms = [...(card()?.querySelectorAll('.council-report tbody') ?? [])];
    expect(
      terms.map((term) => [
        term.querySelectorAll('tr').length,
        term.querySelector('th[scope="rowgroup"]')?.getAttribute('rowspan'),
        term.querySelector('th[scope="rowgroup"]')?.textContent,
      ]),
    ).toEqual([
      [2, '2', '1º tri.'],
      [2, '2', '2º tri.'],
      [2, '2', '3º tri.'],
    ]);
    expect(host.textContent).not.toContain('Operação não concluída');
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

  it('names the page and its parts for who navigates by landmarks and groups', async () => {
    await openJourney();
    // The page is named by its own heading, and brings no landmark of its own inside the Centro's.
    const page = host.querySelector('section[aria-labelledby]');
    const heading = host.querySelector(`#${page?.getAttribute('aria-labelledby')}`);
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent).toBe('Conselho de Classe');
    expect(page?.hasAttribute('aria-label')).toBe(false);
    expect(host.querySelectorAll('main')).toHaveLength(0);
    expect(host.querySelector('.council-layout__student > .council-stage')).not.toBeNull();
    // A name is only read on something with a role.
    expect(
      all('[aria-label]:is(div, span)')
        .filter((item) => !item.hasAttribute('role'))
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual([]);
    expect(all('[role="group"]').map((item) => item.getAttribute('aria-label'))).toEqual([
      'Turmas do Conselho',
      'Resumo do Conselho',
      'Reunião da turma',
      'Fila do Conselho',
    ]);
  }, 15_000);

  it('asks for the classes once on entering the tab, with no flag, and then only for the class', async () => {
    await openJourney();
    // Pressing the class already open reads nothing again.
    await openClass('6A');
    expect(requests).toEqual([
      { contractVersion: 3, operation: 'classes', year },
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
    expect(
      host.querySelectorAll('[data-slot="select"], textarea, input[type="number"]'),
    ).toHaveLength(0);
    // Opening answered with the class: nothing was read again.
    expect(sent('workspace')).toHaveLength(1);
    expect(sent('classes')).toHaveLength(1);
  }, 15_000);

  it('keeps the button and shows the failure when the meeting could not be opened', async () => {
    openFails = true;
    await openJourney();
    await click('Abrir reunião');
    await waitFor(() => host.textContent?.includes('Operação não concluída') === true);
    expect(host.textContent).toContain('O Conselho está temporariamente indisponível');
    expect(meeting()?.textContent).toContain('Ainda não iniciada');
    expect(button('Abrir reunião')).toBeDefined();
    expect(host.textContent).toContain(student.name);
  }, 15_000);

  it('shows an open meeting with nobody pending as concluded, with what the Conselho decided', async () => {
    const passed = cased(1, 'ALUNO APROVADO NO CONSELHO', 'eligible', { decision: { code: 1 } });
    const failed = cased(3, 'ALUNA REPROVADA NO CONSELHO', 'eligible', { decision: { code: 2 } });
    const absent = cased(7, 'ALUNO REPROVADO POR FALTA', 'eligible', { decision: { code: 3 } });
    current = workspace([passed, failed, absent], 'open');
    await openJourney();
    expect(meeting()?.textContent).toContain('Concluída');
    expect(button('Abrir reunião')).toBeUndefined();
    expect(kpis()).toEqual(['4alunos', '3elegíveis', '0a deliberar', '3decididos']);
    expect(board()).toEqual([
      { title: 'A deliberar', count: '0', cards: [] },
      {
        title: 'Decididos',
        count: '3',
        cards: [
          `1${passed.name}Aprovado pelo Conselho`,
          `3${failed.name}Reprovado pelo Conselho`,
          `7${absent.name}Reprovado por falta`,
        ],
      },
    ]);
    expect(host.querySelector('.council-board__empty')?.textContent).toBe('Fila concluída');
    // The card says what was decided, in the colour of the decision.
    expect(situation()).toEqual(['strong:Aprovado pelo Conselho']);
    expect(card()?.getAttribute('data-tone')).toBe('success');
    await press(queueCard(failed.name));
    expect(situation()).toEqual(['strong:Reprovado pelo Conselho']);
    expect(card()?.getAttribute('data-tone')).toBe('danger');
    await press(queueCard(absent.name));
    expect(situation()).toEqual(['strong:Reprovado por falta']);
    expect(card()?.getAttribute('data-tone')).toBe('danger');
    // The absence is one of the rejected in the count of the class.
    expect(tally('6A')?.getAttribute('aria-label')).toBe('1 aprovado, 2 reprovados');
  }, 15_000);

  it('counts one student in the singular and draws no arrows or dots for a queue of one', async () => {
    const alone = cased(1, 'ALUNO SINTETICO', 'eligible', { decision: { code: 1 } });
    current = workspace([alone], 'not-opened', 0);
    await openJourney();
    expect(kpis()).toEqual(['1aluno', '1elegível', '0a deliberar', '1decidido']);
    expect(pile()).toEqual([{ name: 'ALUNO SINTETICO', offset: '0', inert: false, filled: true }]);
    expect(all('.council-deck__arrow')).toHaveLength(0);
    expect(host.querySelector('.council-pager')).toBeNull();
    // Decided before the meeting was opened: it is still to be opened, not concluded.
    expect(meeting()?.textContent).toContain('Ainda não iniciada');
    expect(button('Abrir reunião')).toBeDefined();
  }, 15_000);

  it('shows for information the students the sheet already fails, and deliberates on a recovery still to be recorded', async () => {
    // Even a decision that came with a student the sheet fails would not show.
    const repeated = { ...repeat, decision: { code: 1 as const } };
    current = workspace([student, noShow, repeated, recoveryPending]);
    await openJourney();
    // Who is deliberated on: the eligible student and the one with the recovery to be recorded.
    expect(kpis()).toEqual(['5alunos', '2elegíveis', '2a deliberar', '0decididos']);
    expect(tally('6A')?.getAttribute('aria-label')).toBe('2 pendentes');
    expect(meeting()?.textContent).toContain('Ainda não iniciada');
    expect(board()).toEqual([
      {
        title: 'A deliberar',
        count: '2',
        cards: [
          `1${student.name}1 componente abaixo`,
          `6${recoveryPending.name}Recuperação ainda não lançada`,
        ],
      },
      {
        title: 'Para conhecimento',
        count: '2',
        cards: [
          `4${noShow.name}Não compareceu à recuperação`,
          `5${repeated.name}Reprovado pelo regimento`,
        ],
      },
    ]);
    expect(dots().map((dot) => dot.getAttribute('data-kind'))).toEqual([
      'pending',
      'pending',
      'informed',
      'informed',
    ]);

    await press(queueCard(noShow.name));
    expect(card()?.getAttribute('aria-label')).toBe(noShow.name);
    expect(situation()).toEqual(['strong:Reprovado', 'span:Não compareceu']);
    expect(card()?.getAttribute('data-tone')).toBe('danger');
    // N/C stands for the mark; with no recovery total, the year's total is the one of the terms.
    expect(report().slice(1, 3)).toEqual([
      ['1º tri.', 'Nota', '10,0', '20,0'],
      ['REC', 'N/C', ''],
    ]);
    expect(report().at(-1)).toEqual(['Nota final', '34,75', '75,0']);
    expect(marks()).toContain('not-classified:N/C');
    expect(card()?.querySelector('.council-report th[data-failed]')?.textContent).toBe(
      'MATEMATICA (não aprovado)',
    );
    // N/C is not a mark below the minimum: it says so by itself.
    expect(spoken()).not.toContain('N/C (abaixo do mínimo)');

    await press(queueCard(repeated.name));
    expect(situation()).toEqual(['strong:Reprovado', 'span:Pelo regimento']);
    expect(card()?.getAttribute('data-tone')).toBe('danger');
    expect(report()[2]).toEqual(['REC', 'R/R', '']);
    expect(marks()).toContain('below:R/R');
    // Nor is R/R: only a number is said to be below the minimum.
    expect(spoken()).not.toContain('R/R (abaixo do mínimo)');
    expect(card()?.querySelector('.council-report th[data-failed]')?.textContent).toBe(
      'MATEMATICA (não aprovado)',
    );
    expect(host.textContent).not.toContain('Aprovado pelo Conselho');

    await press(queueCard(recoveryPending.name));
    expect(situation()).toEqual(['strong:Recuperação pendente']);
    expect(card()?.getAttribute('data-tone')).toBe('warning');
    // The REC the student owes has a mark of its own and no number; no column is tinted.
    const owed = [...(card()?.querySelectorAll('.council-report [data-level="pending"]') ?? [])];
    expect(
      owed.map((item) => [item.getAttribute('role'), item.getAttribute('aria-label')]),
    ).toEqual([
      ['img', 'Recuperação ainda não lançada'],
      ['img', 'Recuperação ainda não lançada'],
    ]);
    expect(report()[2]).toEqual(['REC', '', '']);
    expect(report().at(-1)).toEqual(['Nota final', '34,75', '75,0']);
    expect(card()?.querySelectorAll('.council-report [data-failed]')).toHaveLength(0);
    expect(spoken().filter((cell) => cell?.includes('não aprovado'))).toEqual([]);
  }, 15_000);

  it('lists a class with students only for information, with no count and no meeting', async () => {
    current = workspace([noShow]);
    await openJourney();
    // Nothing to count in the button, and nobody to deliberate on.
    expect(classButtons().map(labelOf)).toEqual(['6A']);
    expect(tally('6A')).toBeNull();
    expect(meeting()).toBeNull();
    expect(button('Abrir reunião')).toBeUndefined();
    expect(kpis()).toEqual(['2alunos', '0elegíveis', '0a deliberar', '0decididos']);
    expect(board()).toEqual([
      {
        title: 'Para conhecimento',
        count: '1',
        cards: [`4${noShow.name}Não compareceu à recuperação`],
      },
    ]);
    expect(host.textContent).not.toContain('Fila concluída');
    expect(situation()).toEqual(['strong:Reprovado', 'span:Não compareceu']);
  }, 15_000);

  it('moves through the pile with the arrows and the dots, with only the card on top reachable', async () => {
    const names = ['PRIMEIRO', 'SEGUNDO', 'TERCEIRO', 'QUARTO', 'QUINTO', 'SEXTO'].map(
      (name) => `ALUNO ${name}`,
    );
    // Given out of order: the pile follows the queue, pending, decided and for information.
    current = workspace([
      cased(5, names[4]!, 'failed-no-show'),
      cased(4, names[3]!, 'eligible', { decision: { code: 2 } }),
      cased(1, names[0]!, 'eligible'),
      cased(6, names[5]!, 'failed-repeat'),
      cased(2, names[1]!, 'eligible'),
      cased(3, names[2]!, 'recovery-pending'),
    ]);
    await openJourney();
    const behind = (name: string, offset: string, filled: boolean) => ({
      name,
      offset,
      inert: true,
      filled,
    });
    const top = (name: string) => ({ name, offset: '0', inert: false, filled: true });
    const ended = (label: string) => arrow(label)?.getAttribute('aria-disabled');
    // The two students after the one on top wait behind it; the farther one is an empty card.
    expect(pile()).toEqual([
      top(names[0]!),
      behind(names[1]!, '1', true),
      behind(names[2]!, '2', false),
    ]);
    expect(card()?.hasAttribute('aria-hidden')).toBe(false);
    expect(host.querySelector('.council-card[data-offset="1"]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    // At an end the arrow says so and stays where it is, focus included; pressing it does nothing.
    expect([ended('Aluno anterior'), ended('Próximo aluno')]).toEqual(['true', 'false']);
    expect(arrow('Aluno anterior')?.disabled).toBe(false);
    await press(arrow('Aluno anterior'));
    expect(card()?.getAttribute('aria-label')).toBe(names[0]);
    // The dots are a shortcut for the mouse: out of the reading and of the keyboard's way.
    const pager = host.querySelector('.council-pager');
    expect(pager?.getAttribute('aria-hidden')).toBe('true');
    expect(pager?.hasAttribute('role') || pager?.hasAttribute('aria-label')).toBe(false);
    expect(dots()).toHaveLength(names.length);
    for (const dot of dots()) {
      expect(dot.tabIndex).toBe(-1);
      expect(dot.hasAttribute('aria-label') || dot.hasAttribute('aria-current')).toBe(false);
    }
    expect(dots().map((dot) => dot.getAttribute('data-kind'))).toEqual([
      'pending',
      'pending',
      'pending',
      'decided',
      'informed',
      'informed',
    ]);
    expect(currentDot()).toEqual([0]);

    await press(arrow('Próximo aluno'));
    expect(pile()).toEqual([
      behind(names[0]!, '-1', true),
      top(names[1]!),
      behind(names[2]!, '1', true),
      behind(names[3]!, '2', false),
    ]);
    expect([ended('Aluno anterior'), ended('Próximo aluno')]).toEqual(['false', 'false']);
    expect(currentDot()).toEqual([1]);
    // The queue marks the same student.
    expect(queueCard(names[1]!)?.getAttribute('aria-pressed')).toBe('true');
    expect(queueCard(names[0]!)?.getAttribute('aria-pressed')).toBe('false');

    // A dot leads straight to its student: here, the last of the queue.
    await press(dots().at(-1));
    expect(pile()).toEqual([
      behind(names[3]!, '-2', false),
      behind(names[4]!, '-1', true),
      top(names[5]!),
    ]);
    expect([ended('Aluno anterior'), ended('Próximo aluno')]).toEqual(['false', 'true']);
    expect(currentDot()).toEqual([5]);
    expect(situation()).toEqual(['strong:Reprovado', 'span:Pelo regimento']);
    await press(arrow('Próximo aluno'));
    expect(card()?.getAttribute('aria-label')).toBe(names[5]);

    await press(arrow('Aluno anterior'));
    expect(card()?.getAttribute('aria-label')).toBe(names[4]);
    expect(currentDot()).toEqual([4]);
    // Choosing in the queue moves the pile too.
    await press(queueCard(names[3]!));
    expect(card()?.getAttribute('aria-label')).toBe(names[3]);
    expect(situation()).toEqual(['strong:Reprovado pelo Conselho']);
    // Moving through the students reads nothing again.
    expect(sent('workspace')).toHaveLength(1);
  }, 15_000);

  it('gives a button only to the classes with somebody for the Conselho, and reads the counts aloud', async () => {
    listed = [
      { id: 31, label: '7A', tally: counts(2, 1, 3) },
      { id: 32, label: '7B', tally: counts(1, 0, 0) },
      { id: 33, label: '7C', tally: counts(0, 2, 1, 4) },
      // Nobody for the Conselho: no button.
      { id: 34, label: '7D', tally: counts(0, 0, 0) },
      // The reading of this class failed: it comes without its count and stays listed.
      { id: 35, label: '7E' },
      // Only students for information: listed, with nothing to count.
      { id: 36, label: '7F', tally: counts(0, 0, 0, 2) },
    ];
    await mount();
    await waitFor(() => classButtons().length > 0);
    expect(classButtons().map(labelOf)).toEqual(['7A', '7B', '7C', '7E', '7F']);
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
    // The students only for information are not counted in the button.
    expect(read('7C')).toEqual({
      label: '2 reprovados, 1 pendente',
      marks: ['rejected:2', 'pending:1'],
    });
    expect(tally('7E')?.hasAttribute('data-unavailable')).toBe(true);
    expect(read('7E')).toEqual({ label: 'Contagem indisponível', marks: [] });
    expect(tally('7F')).toBeNull();
    expect(classButton('7F')?.textContent).toBe('7F');
    for (const item of classButtons()) {
      expect(item.querySelector('.council-tally')?.getAttribute('role') ?? 'img').toBe('img');
      expect(item.getAttribute('aria-pressed')).toBe('false');
    }
    // Nothing holds the place of a count or marks a class with nobody for the Conselho.
    expect(
      host.querySelectorAll(
        '[data-reading], [data-none], [aria-label="Nenhum elegível"], [role="tab"]',
      ),
    ).toHaveLength(0);
    expect(host.textContent).not.toMatch(RETIRED_TEXT);
    // With classes listed and none open, the page asks for one.
    expect(host.textContent).toContain('Escolha uma turma para abrir a pauta');
    expect(host.textContent).not.toContain('Nenhuma turma com alunos para o Conselho');
    expect(sent('classes')).toHaveLength(1);
  }, 15_000);

  it('says so when the year has no class with students for the Conselho', async () => {
    listed = [{ id: 34, label: '7D', tally: counts(0, 0, 0) }];
    await mount();
    await waitFor(
      () => host.textContent?.includes('Nenhuma turma com alunos para o Conselho') === true,
    );
    expect(group()).toBeNull();
    expect(classButtons()).toHaveLength(0);
    expect(host.textContent).not.toContain('Escolha uma turma para abrir a pauta');
    expect(host.textContent).not.toContain('Operação não concluída');
    expect(button('Tentar novamente')).toBeUndefined();
  }, 15_000);

  it('takes the open class off the list when its reading comes back with nobody for the Conselho', async () => {
    listed = [
      { id: 10, label: '6A' },
      { id: 31, label: '7A', tally: counts(0, 0, 1) },
    ];
    await mount();
    await waitFor(() => classButton('6A') !== undefined);
    // A grade was corrected after the classes were read.
    current = workspace([]);
    await openClass('6A');
    await waitFor(() => classButton('6A') === undefined);
    expect(classButtons().map(labelOf)).toEqual(['7A']);
    expect(classButton('7A')?.getAttribute('aria-pressed')).toBe('false');
    expect(summary()).toBeNull();
    expect(meeting()).toBeNull();
    expect(host.querySelector('.council-board')).toBeNull();
    expect(host.querySelector('.council-stage')).toBeNull();
    expect(host.textContent).toContain('Escolha uma turma para abrir a pauta');
    expect(host.textContent).not.toMatch(RETIRED_TEXT);
    expect(host.textContent).not.toContain('Operação não concluída');
    // The class left without the classes being asked for again.
    expect(sent('classes')).toHaveLength(1);
  }, 15_000);

  it('offers to try again when the classes could not be read, and reads them again', async () => {
    classesFail = 'unavailable';
    await mount();
    await waitFor(() => host.textContent?.includes('Operação não concluída') === true);
    expect(host.textContent).toContain('O Conselho está temporariamente indisponível');
    expect(classButtons()).toHaveLength(0);
    // A failed reading is not a year without classes.
    expect(host.textContent).not.toContain('Nenhuma turma com alunos para o Conselho');
    classesFail = false;
    await click('Tentar novamente');
    await waitFor(() => classButton('6A') !== undefined);
    expect(host.textContent).not.toContain('Operação não concluída');
    expect(button('Tentar novamente')).toBeUndefined();
    expect(sent('classes')).toHaveLength(2);
  }, 15_000);

  it('says that there is too much to read at once when the year or the class is too large', async () => {
    classesFail = 'scope-too-large';
    await mount();
    await waitFor(() => host.textContent?.includes('Operação não concluída') === true);
    expect(host.textContent).toContain('Há turmas ou alunos demais para ler de uma vez.');
    expect(host.textContent).not.toContain('A turma é grande demais');
    expect(button('Tentar novamente')).toBeDefined();
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
    listed = [...listed, { id: 61, label: '9B', tally: counts(0, 0, 2) }];
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

  it('reopens after a reload the class that was open in the tab', async () => {
    keepView({ year, classId: 10 });
    await mount();
    await waitFor(() => summary() !== null);
    expect(classButton('6A')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).toContain(student.name);
    // The class was read once the classes said it is still one of them.
    expect(requests).toEqual([
      { contractVersion: 3, operation: 'classes', year },
      { contractVersion: 3, operation: 'workspace', year, classId: 10 },
    ]);
  }, 15_000);

  it('does not reopen a class kept for another year or one that is no longer listed', async () => {
    for (const kept of [
      { year: year - 1, classId: 10 },
      { year, classId: 99 },
    ]) {
      keepView(kept);
      await mount();
      await waitFor(() => host.textContent?.includes('Escolha uma turma') === true);
      await settle();
      expect(classButton('6A')?.getAttribute('aria-pressed')).toBe('false');
      expect(summary()).toBeNull();
      await unmount();
    }
    expect(sent('workspace')).toHaveLength(0);
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
    listed = [{ id: 51, label: '9A', tally: counts(1, 0, 1) }];
    await act(async () => selectYear(year - 1));
    await waitFor(() => classButton('9A') !== undefined);
    expect(classButtons().map(labelOf)).toEqual(['9A']);
    expect(classButton('9A')?.getAttribute('aria-pressed')).toBe('false');
    expect(summary()).toBeNull();
    expect(meeting()).toBeNull();
    expect(host.textContent).toContain('Escolha uma turma para abrir a pauta');
    // The other year was asked only for its classes.
    expect(requests.filter((request) => request.year === year - 1)).toEqual([
      { contractVersion: 3, operation: 'classes', year: year - 1 },
    ]);
  }, 15_000);

  it('keeps the active surface disconnected from legacy year and Council clients', () => {
    const surface = readFileSync('src/platform/gradebook-council-surface.tsx', 'utf8');
    expect(surface).toContain('RelationalCouncilPageV3');
    expect(surface).not.toMatch(
      /resolveLegacyAcademicYear|CouncilWorkspacePage|CouncilInstitutionalPanelV2|requestOperationalWorkspaceV1/u,
    );
  });

  it('styles the page from its own stylesheet, with no rule left for what the page no longer draws', () => {
    const folder = 'src/features/gradebook/council/';
    const page = readFileSync(`${folder}relational-council-page-v3.tsx`, 'utf8');
    const drawn = new Set(page.match(/council-[a-z0-9_-]+/gu));
    const styled = new Set(
      readFileSync(`${folder}council-v3.css`, 'utf8').match(/\.council-[a-z0-9_-]+/gu),
    );
    expect(styled.size).toBeGreaterThan(20);
    // The page completes `council-kpi--` with the tone of each number.
    expect(
      [...styled]
        .map((rule) => rule.slice(1))
        .filter((name) => !drawn.has(name) && !drawn.has(name.replace(/--[a-z]+$/u, '--'))),
    ).toEqual([]);
    expect(readFileSync('src/styles.css', 'utf8')).not.toContain('.council-');
  });
});
