// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelationalCouncilPageV3 } from '../../../src/features/gradebook/council/relational-council-page-v3';
import { requestRelationalCouncilV3 } from '../../../src/features/gradebook/council/relational-council-client-v3';
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
async function openClass(id: number) {
  const tab = () =>
    host.querySelector<HTMLElement>(
      `[role="tablist"][aria-label="Turmas do Conselho"] [data-key="${id}"]`,
    );
  await waitFor(() => tab() !== null);
  await act(async () => tab()!.click());
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
  });

  it('renders the static Kanban-inspired queue, annual table and audit timeline without prior-year controls', async () => {
    await mount();
    await openClass(10);
    await waitFor(() => host.textContent?.includes(student.name) === true);
    expect(host.textContent).toContain('A deliberar');
    expect(host.textContent).toContain('Decididos');
    expect(host.textContent).toContain('1º tri.');
    expect(host.textContent).toContain('REC');
    expect(host.textContent).toContain('Não elegíveis');
    expect(host.textContent).toContain('Linha do tempo');
    expect(host.textContent).not.toMatch(
      /Conselho anterior|ano anterior|catálogo legado|voto de minerva|diretor/iu,
    );
    expect(host.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    // The classes are tabs: the only select left is the student's formal status.
    expect(
      host.querySelectorAll('[role="tablist"][aria-label="Turmas do Conselho"] [role="tab"]')
        .length,
    ).toBeGreaterThan(0);
    expect(host.querySelectorAll('[data-slot="select"]')).toHaveLength(1);
  });

  it('opens the meeting, records an exact formal status and keeps tied votes numerical only', async () => {
    await mount();
    await openClass(10);
    await waitFor(() => host.textContent?.includes(student.name) === true);
    await fill('#council-session-reason', 'Início da reunião sintética.');
    await click('Abrir reunião');
    const openRequest = requests.filter((request) => request.operation === 'open').at(-1);
    expect(openRequest).toMatchObject({
      operation: 'open',
      year: 2026,
      classId: 10,
      expectedVersion: 0,
      justification: 'Início da reunião sintética.',
    });
    expect(String(openRequest?.idempotencyKey)).toMatch(/^open:/u);
    await select('Situação após o Conselho', '2');
    await fill('#decision-reason-1', 'Deliberação humana sintética.');
    await click('Registrar decisão');
    expect(requests.filter((request) => request.operation === 'decision').at(-1)).toMatchObject({
      operation: 'decision',
      studentId: 1,
      decision: 2,
      expectedVersion: 1,
    });
    expect(host.textContent).toContain('REPROVADO PELO CONSELHO');
    await fill('#votes-for-1', '2');
    await fill('#votes-against-1', '2');
    await fill('#vote-reason-1', 'Contagem numérica sintética.');
    await click('Registrar contagem');
    const voteRequest = requests.filter((request) => request.operation === 'vote').at(-1);
    expect(voteRequest).toMatchObject({
      operation: 'vote',
      favoraveis: 2,
      contrarios: 2,
      expectedVersion: 2,
    });
    expect(voteRequest).not.toHaveProperty('presentes');
    expect(voteRequest).not.toHaveProperty('desempate');
    expect(host.textContent).toContain('4 presente(s)');
    expect(host.textContent).toContain('Empate · decisão fora do sistema');
  }, 15_000);

  it('keeps the active surface disconnected from legacy year and Council clients', () => {
    const surface = readFileSync('src/platform/gradebook-council-surface.tsx', 'utf8');
    expect(surface).toContain('RelationalCouncilPageV3');
    expect(surface).not.toMatch(
      /resolveLegacyAcademicYear|CouncilWorkspacePage|CouncilInstitutionalPanelV2|requestOperationalWorkspaceV1/u,
    );
  });
});
