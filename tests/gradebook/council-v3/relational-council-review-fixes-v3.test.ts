// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelationalCouncilPageV3 } from '../../../src/features/gradebook/council/relational-council-page-v3';
import { GradebookYearProvider } from '../../../src/platform/gradebook-year-provider';
import type {
  RelationalCouncilStudentV3,
  RelationalCouncilWorkspaceV3,
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
  vote: null,
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
function workspace(
  extra: Partial<RelationalCouncilWorkspaceV3> = {},
): RelationalCouncilWorkspaceV3 {
  return {
    context: { year: 2026, minimumApprovalMilli: 60_000, maxCouncilComponents: 2 },
    classGroup: { id: 10, label: '6A', name: 'TURMA SINTETICA' },
    readAt: '2026-09-11T04:00:00.000Z',
    authority: 'calculated-eligibility-explicit-human-decision',
    session: {
      state: 'not-opened',
      version: 0,
      reviewReference: 'council-review:2026:10:0',
      closedAt: null,
      snapshotCount: 0,
    },
    summary: {
      total: 2,
      eligible: 1,
      decided: 0,
      pending: 1,
      approved: 0,
      rejected: 0,
      absence: 0,
      notEligible: 1,
    },
    students: [student, nonEligible],
    timeline: [],
    closures: [],
    ...extra,
  };
}

let host: HTMLDivElement;
let root: Root | null;
let current = workspace();
let requests: Record<string, unknown>[];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const reply = (value: unknown, status = 200) => Response.json(value, { status });

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
  current = workspace();
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
    if (body.operation === 'classes')
      return reply({
        contractVersion: 3,
        state: 'ready',
        operation: 'classes',
        year: Number(body.year),
        classes: [
          {
            id: 10,
            label: '6A',
            name: 'TURMA SINTETICA',
            sessionState: current.session.state,
            sessionVersion: current.session.version,
          },
        ],
        nextOffset: null,
      });
    if (body.operation === 'workspace')
      return reply({
        contractVersion: 3,
        state: 'ready',
        operation: 'workspace',
        workspace: current,
      });
    if (body.operation === 'open')
      current = workspace({
        ...current,
        session: {
          ...current.session,
          state: 'open',
          version: 1,
          reviewReference: 'council-review:2026:10:1',
        },
        timeline: [
          {
            id: 's:1',
            action: 'opened',
            version: 1,
            studentId: null,
            studentLabel: null,
            justification: String(body.justification),
            occurredAt: '2026-09-11T04:01:00.000Z',
          },
        ],
      });
    if (body.operation === 'decision')
      current = workspace({
        ...current,
        session: {
          ...current.session,
          state: 'open',
          version: 2,
          reviewReference: 'council-review:2026:10:2',
        },
        summary: { ...current.summary, decided: 1, pending: 0, rejected: 1 },
        students: [
          {
            ...student,
            decision: {
              code: 2,
              label: 'REPROVADO PELO CONSELHO',
              justification: String(body.justification),
              version: 2,
              updatedAt: '2026-09-11T04:02:00.000Z',
            },
          },
          nonEligible,
        ],
        timeline: [
          {
            id: 'd:1',
            action: 'decision-recorded',
            version: 2,
            studentId: 1,
            studentLabel: student.name,
            justification: String(body.justification),
            occurredAt: '2026-09-11T04:02:00.000Z',
          },
          ...current.timeline,
        ],
      });
    if (body.operation === 'vote')
      current = workspace({
        ...current,
        session: {
          ...current.session,
          state: 'open',
          version: 3,
          reviewReference: 'council-review:2026:10:3',
        },
        students: [
          {
            ...current.students[0]!,
            vote: {
              favoraveis: Number(body.favoraveis),
              contrarios: Number(body.contrarios),
              presentes: Number(body.favoraveis) + Number(body.contrarios),
              comparison: 'empate',
              justification: String(body.justification),
              version: 3,
              updatedAt: '2026-09-11T04:03:00.000Z',
            },
          },
          nonEligible,
        ],
      });
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
async function select(label: string, value: string) {
  const root = [...host.querySelectorAll<HTMLElement>('[data-slot="select"]')].find(
    (element) => element.querySelector('[data-slot="label"]')?.textContent === label,
  );
  const control = root?.querySelector('select') as HTMLSelectElement | null;
  expect(control).not.toBeNull();
  await act(async () => {
    control!.value = value;
    control!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await settle();
}
async function fill(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  expect(input).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

function button(label: string) {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
  expect(found).toBeDefined();
  return found!;
}
const isDisabled = (element: Element) =>
  element.hasAttribute('disabled') || element.getAttribute('data-disabled') === 'true';
const nativeDecision = () => {
  const container = [...host.querySelectorAll<HTMLElement>('[data-slot="select"]')].find(
    (element) => element.querySelector('[data-slot="label"]')?.textContent === 'Situação após o Conselho',
  );
  return container?.querySelector('select') ?? null;
};

async function openMeeting() {
  await mount();
  await select('Turma do Conselho', '10');
  await waitFor(() => host.textContent?.includes(student.name) === true);
  await fill('#council-session-reason', 'Início da reunião sintética.');
  await click('Abrir reunião');
  await waitFor(() => host.querySelector('#decision-reason-1') !== null);
}

describe('Council decision chosen explicitly (A3)', () => {
  it('starts empty for a student without decision and records only after a choice', async () => {
    await openMeeting();
    expect(nativeDecision()?.value ?? '').toBe('');
    const trigger = nativeDecision()?.closest('[data-slot="select"]')?.querySelector('button');
    expect(trigger?.textContent).toContain('Escolha a situação');
    expect(trigger?.textContent).not.toContain('APROVADO PELO CONSELHO');
    await fill('#decision-reason-1', 'Reprovado pela maioria.');
    expect(isDisabled(button('Registrar decisão'))).toBe(true);
    await click('Registrar decisão');
    expect(requests.some((request) => request.operation === 'decision')).toBe(false);
    await select('Situação após o Conselho', '2');
    expect(isDisabled(button('Registrar decisão'))).toBe(false);
    await click('Registrar decisão');
    expect(requests.filter((request) => request.operation === 'decision').at(-1)).toMatchObject({
      decision: 2,
      justification: 'Reprovado pela maioria.',
    });
    // One's own save is not someone else's change.
    await waitFor(() => host.textContent?.includes('Decisão humana registrada') === true);
    expect(host.textContent).not.toContain('Outra pessoa alterou este aluno');
  }, 15_000);
});

describe('Council refusal after another save (A12)', () => {
  it('keeps the conflict warning and the typed draft after the reread', async () => {
    let conflict = false;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (conflict && body.operation === 'decision') {
        requests.push(body);
        return reply({ contractVersion: 3, state: 'version-conflict' }, 409);
      }
      return fetchMock(url, init);
    }));
    await openMeeting();
    await select('Situação após o Conselho', '3');
    await fill('#decision-reason-1', 'Rascunho que não pode sumir.');
    conflict = true;
    const before = requests.length;
    await click('Registrar decisão');
    await waitFor(() => requests.slice(before).some((request) => request.operation === 'workspace'));
    await settle();
    expect(host.textContent).toContain('Outra alteração foi salva antes desta.');
    expect(host.querySelector<HTMLTextAreaElement>('#decision-reason-1')?.value).toBe('Rascunho que não pode sumir.');
    expect(nativeDecision()?.value).toBe('3');
  }, 15_000);

  /** Another person records a decision for the same student, as the server would keep it. */
  function decidedElsewhere() {
    current = workspace({
      ...current,
      session: { ...current.session, version: 2, reviewReference: 'council-review:2026:10:2' },
      summary: { ...current.summary, decided: 1, pending: 0, rejected: 1 },
      students: [
        {
          ...current.students[0]!,
          decision: {
            code: 2,
            label: 'REPROVADO PELO CONSELHO',
            justification: 'Decisão gravada por outra pessoa.',
            version: 2,
            updatedAt: '2026-09-11T04:02:00.000Z',
          },
        },
        nonEligible,
      ],
    });
  }

  it('keeps the draft and warns when the conflict is on the same student', async () => {
    let conflict = false;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (conflict && body.operation === 'decision') {
        requests.push(body);
        return reply({ contractVersion: 3, state: 'version-conflict' }, 409);
      }
      return fetchMock(url, init);
    }));
    await openMeeting();
    await select('Situação após o Conselho', '3');
    await fill('#decision-reason-1', 'Meu rascunho do mesmo aluno.');
    decidedElsewhere();
    conflict = true;
    const before = requests.length;
    await click('Registrar decisão');
    await waitFor(() => requests.slice(before).some((request) => request.operation === 'workspace'));
    await settle();
    expect(host.textContent).toContain('Outra alteração foi salva antes desta.');
    expect(host.textContent).toContain('Outra pessoa alterou este aluno');
    expect(host.textContent).toContain('REPROVADO PELO CONSELHO (Decisão gravada por outra pessoa.)');
    expect(host.querySelector<HTMLTextAreaElement>('#decision-reason-1')?.value).toBe('Meu rascunho do mesmo aluno.');
    expect(nativeDecision()?.value).toBe('3');
    // Recording the draft afterwards is a choice made knowing the current record.
    conflict = false;
    await click('Atualizar decisão');
    await waitFor(() => host.textContent?.includes('Decisão humana registrada') === true);
    expect(requests.filter((request) => request.operation === 'decision').at(-1)).toMatchObject({
      decision: 3,
      justification: 'Meu rascunho do mesmo aluno.',
    });
  }, 15_000);

  it('shows the new decision without a warning when only the count had a draft', async () => {
    let conflict = false;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (conflict && body.operation === 'vote') {
        requests.push(body);
        return reply({ contractVersion: 3, state: 'version-conflict' }, 409);
      }
      return fetchMock(url, init);
    }));
    await openMeeting();
    await fill('#votes-for-1', '4');
    await fill('#votes-against-1', '2');
    await fill('#vote-reason-1', 'Contagem ainda não gravada.');
    decidedElsewhere();
    conflict = true;
    const before = requests.length;
    await click('Registrar contagem');
    await waitFor(() => requests.slice(before).some((request) => request.operation === 'workspace'));
    await settle();
    expect(host.textContent).toContain('Outra alteração foi salva antes desta.');
    expect(host.textContent).not.toContain('Outra pessoa alterou este aluno');
    // Nothing typed in the decision: it now shows the record of the other person.
    expect(nativeDecision()?.value).toBe('2');
    expect(host.querySelector<HTMLTextAreaElement>('#decision-reason-1')?.value).toBe('Decisão gravada por outra pessoa.');
    // The count, whose record did not change, keeps what was typed.
    expect(host.querySelector<HTMLInputElement>('#votes-for-1')?.value).toBe('4');
    expect(host.querySelector<HTMLTextAreaElement>('#vote-reason-1')?.value).toBe('Contagem ainda não gravada.');
  }, 15_000);
});
