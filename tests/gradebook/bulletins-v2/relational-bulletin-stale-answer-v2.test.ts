// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RelationalBulletinModelV2,
  RelationalBulletinSnapshotV2,
} from '../../../shared/gradebook-contracts/bulletins/relational-bulletin-v2';
import { RelationalBulletinPageV2 } from '../../../src/features/gradebook/bulletins/relational-bulletin-page-v2';
import { GradebookYearProvider } from '../../../src/platform/gradebook-year-provider';

const model: RelationalBulletinModelV2 = {
  contractVersion: 2,
  modelVersion: 2,
  year: 2026,
  period: { kind: 'term', term: 1 },
  detail: 'summary',
  authority: {
    officialValues: 'imported-source',
    calculatedValues: 'descriptive-comparison',
    formalDecision: 'human-recorded-only',
  },
  readAt: '2026-09-11T12:00:00.000Z',
  classGroup: { id: 10, code: '6A', name: '6º ANO A' },
  student: { id: 20, number: 1, name: 'ALUNO SINTÉTICO', statusCode: null, statusLabel: 'REGULAR' },
  subjects: [
    {
      offerId: 30,
      subject: { id: 40, label: 'PORTUGUÊS', abbreviation: 'P' },
      teacher: { id: 50, label: 'DOCENTE UM' },
      terms: [
        {
          term: 1,
          maximumMilli: 30_000,
          sourceAmMilli: 25_000,
          calculatedAmMilli: 24_000,
          comparison: 'mismatch',
          quantitative: {
            originalMilli: 18_000,
            parallelMilli: 20_000,
            parallelApplicable: true,
            consideredMilli: 20_000,
          },
          qualitativeMilli: 4_000,
          coverage: {
            complete: true,
            requiredSlots: [1, 2, 11],
            resolvedSlots: [1, 2, 11],
            missingSlots: [],
            reasons: [],
          },
          warningCodes: [],
          instruments: [],
        },
      ],
      annual: null,
    },
  ],
  overall: { calculatedResult: 'EM CURSO', formalCouncilDecision: null, visibleResult: 'EM CURSO' },
  emissionReadiness: { ready: true, reasons: [] },
};

const snapshot: RelationalBulletinSnapshotV2 = {
  snapshotId: '11111111-1111-4111-8111-111111111111',
  snapshotVersion: 1,
  dataVersion: 'data-v1',
  emittedAt: '2026-09-11T12:01:00.000Z',
  presentation: { locale: 'pt-BR', dateStyle: 'long' },
  model,
};

let host: HTMLDivElement;
let root: Root | null;
let requests: Record<string, unknown>[];
/** Answers held back by operation (and class), released by the test. */
let held: Map<string, () => void>;
let holding: Set<string>;
/** Operations answered with a refusal (state and reasons) instead of their ready answer. */
let refusing: Map<string, { state: string; reasons: string[] }>;
/** The model the preview answers with. */
let previewModel: RelationalBulletinModelV2;

function reply(value: unknown): Response {
  return Response.json(value);
}

const classOf = (id: number) => ({ id, code: `C${id}`, name: `TURMA ${id}`, label: `TURMA ${id}` });

function answer(body: Record<string, unknown>): unknown {
  if (body.operation === 'bootstrap')
    return {
      contractVersion: 2,
      operation: 'bootstrap',
      state: 'ready',
      years: [{ year: 2026, minimumApprovalMilli: 60_000, maxCouncilComponents: 2 }],
    };
  if (body.operation === 'catalog')
    return {
      contractVersion: 2,
      operation: 'catalog',
      state: 'ready',
      year: 2026,
      classes: [10, 11].map((id) => ({ ...classOf(id), studentCount: 1 })),
    };
  if (body.operation === 'students')
    return {
      contractVersion: 2,
      operation: 'students',
      state: 'ready',
      classGroup: classOf(Number(body.classId)),
      students: [
        { id: 20, number: 1, name: 'ALUNO SINTÉTICO', statusCode: null, statusLabel: 'REGULAR' },
      ],
    };
  if (body.operation === 'history')
    return { contractVersion: 2, operation: 'history', state: 'ready', items: [] };
  if (body.operation === 'preview')
    return { contractVersion: 2, operation: 'preview', state: 'ready', model: previewModel };
  if (body.operation === 'emit')
    return { contractVersion: 2, operation: 'emit', state: 'ready', snapshot };
  throw new Error(`unexpected-operation:${String(body.operation)}`);
}

const keyOf = (body: Record<string, unknown>) =>
  body.operation === 'students' ? `students:${String(body.classId)}` : String(body.operation);

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
  requests = [];
  held = new Map();
  holding = new Set();
  refusing = new Map();
  previewModel = model;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      const key = keyOf(body);
      if (holding.has(key)) {
        holding.delete(key);
        await new Promise<void>((resolve) => held.set(key, resolve));
      }
      const refusal = refusing.get(key);
      if (refusal) return reply({ contractVersion: 2, operation: body.operation, ...refusal });
      return reply(answer(body));
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = null;
});

async function release(key: string): Promise<void> {
  await waitFor(() => held.has(key));
  await act(async () => held.get(key)!());
  await settle();
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  expect(predicate()).toBe(true);
}

async function mount(): Promise<void> {
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(GradebookYearProvider, null, createElement(RelationalBulletinPageV2)),
    ),
  );
  await waitFor(() => requests.some((request) => request.operation === 'catalog'));
}

async function select(label: string, value: string): Promise<void> {
  const container = [...host.querySelectorAll<HTMLElement>('[data-slot="select"]')].find(
    (element) => element.querySelector('[data-slot="label"]')?.textContent === label,
  );
  const control = container?.querySelector('select') as HTMLSelectElement | null;
  expect(control).not.toBeNull();
  await act(async () => {
    control!.value = value;
    control!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

const selectControl = (label: string) =>
  [...host.querySelectorAll<HTMLElement>('[data-slot="select"]')]
    .find((element) => element.querySelector('[data-slot="label"]')?.textContent === label)
    ?.querySelector<HTMLElement>('select') ?? null;
const buttonOf = (label: string) =>
  [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
const isDisabled = (element: HTMLElement | null | undefined) =>
  element?.hasAttribute('disabled') === true || element?.getAttribute('data-disabled') === 'true';

/** The phone's back button bringing back a view of the bulletins (another detail, here). */
async function backTo(view: { classId: number; term: 1 | 2 | 3 | 'annual'; detail: string }) {
  await act(async () => {
    window.history.replaceState(
      { 'step-v1:gradebook-bulletins-view:2026': { year: 2026, ...view } },
      '',
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await settle();
}

async function click(label: string): Promise<void> {
  const button = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await settle();
}

describe('a preview or emission answered after the choice changed (A13)', () => {
  async function readyToPreview(): Promise<void> {
    await mount();
    await select('Turma', '10');
    await waitFor(() => host.textContent?.includes('ALUNO SINTÉTICO') === true);
    await select('Aluno da prévia', '20');
  }

  it('drops a preview whose period was changed before it arrived', async () => {
    await readyToPreview();
    holding.add('preview');
    await click('Gerar prévia');
    await select('Período', 'annual');
    await release('preview');
    expect(host.textContent).not.toContain('AM oficial');
    expect(host.textContent).not.toContain('Prévia atualizada');
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Gerar prévia'));
    expect(button?.hasAttribute('disabled')).toBe(false);
  });

  it('locks the filters and both emit buttons while an emission is on its way', async () => {
    await readyToPreview();
    holding.add('emit');
    await click('Emitir individual');
    for (const label of ['Turma', 'Período', 'Detalhamento', 'Aluno da prévia'])
      expect(isDisabled(selectControl(label)), label).toBe(true);
    expect(isDisabled(buttonOf('Emitir individual'))).toBe(true);
    expect(isDisabled(buttonOf('Emitir lote'))).toBe(true);
    await release('emit');
    expect(host.textContent).toContain('Emissão preservada no snapshot');
    expect(isDisabled(selectControl('Detalhamento'))).toBe(false);
  });

  it('tells about an emission answered after the back button changed the detail', async () => {
    await readyToPreview();
    holding.add('emit');
    await click('Emitir individual');
    const historyReads = requests.filter((request) => request.operation === 'history').length;
    await backTo({ classId: 10, term: 1, detail: 'detailed' });
    // The emission is still running: emitting again stays locked.
    expect(isDisabled(buttonOf('Emitir individual'))).toBe(true);
    await release('emit');
    expect(host.textContent).not.toContain('Baixar PDF oficial');
    expect(host.textContent).toContain('Emissão preservada no snapshot');
    expect(host.textContent).toContain('não aparece nesta seleção');
    await waitFor(
      () => requests.filter((request) => request.operation === 'history').length > historyReads,
    );
    expect(isDisabled(buttonOf('Emitir individual'))).toBe(false);
  });

  it('hides the refusal of a preview whose period was changed before it arrived', async () => {
    await readyToPreview();
    holding.add('preview');
    refusing.set('preview', { state: 'insufficient-data', reasons: ['council-decision-pending'] });
    await click('Gerar prévia');
    await select('Período', 'annual');
    await release('preview');
    expect(host.textContent).not.toContain('Operação não concluída');
    expect(host.textContent).not.toContain('Decisão de Conselho pendente');
  });

  it('still shows the refusal of a preview for the choice on screen', async () => {
    await readyToPreview();
    refusing.set('preview', { state: 'insufficient-data', reasons: ['council-decision-pending'] });
    await click('Gerar prévia');
    await waitFor(() => host.textContent?.includes('Operação não concluída') === true);
    expect(host.textContent).toContain('Decisão de Conselho pendente');
  });

  it('keeps the new class loading when an old preview arrives', async () => {
    await readyToPreview();
    holding.add('preview');
    holding.add('students:11');
    await click('Gerar prévia');
    await select('Turma', '11');
    await release('preview');
    expect(host.textContent).not.toContain('AM oficial');
    expect(host.textContent).toContain('Carregando alunos…');
    await release('students:11');
    expect(host.textContent).not.toContain('Carregando alunos…');
  });
});

describe('the detailed preview on screen (A23)', () => {
  it('shows "Sem registro" for an instrument without the student row, apart from "Não fez" and zero', async () => {
    const base = { term: 1 as const, maximumMilli: 5_000 };
    const subject = model.subjects[0]!;
    previewModel = {
      ...model,
      detail: 'detailed',
      subjects: [
        {
          ...subject,
          terms: [
            {
              ...subject.terms[0]!,
              instruments: [
                { ...base, id: 61, slot: 2, label: 'AV2', valueMilli: null },
                { ...base, id: 62, slot: 3, label: 'AV3', valueMilli: null, notDone: true },
                { ...base, id: 63, slot: 4, label: 'AV4', valueMilli: 0 },
                { ...base, id: 64, slot: 5, label: 'AV5', valueMilli: 4_000 },
              ],
            },
          ],
        },
      ],
    };
    await mount();
    await select('Turma', '10');
    await waitFor(() => host.textContent?.includes('ALUNO SINTÉTICO') === true);
    await select('Detalhamento', 'detailed');
    await select('Aluno da prévia', '20');
    await click('Gerar prévia');
    await waitFor(() => host.textContent?.includes('Composição detalhada') === true);
    const cards = [...host.querySelectorAll('strong')]
      .filter((item) => /^AV\d$/u.test(item.textContent ?? ''))
      .map((item) => `${item.textContent}: ${item.nextElementSibling?.textContent ?? ''}`);
    expect(cards).toEqual([
      'AV2: Sem registro / 5',
      'AV3: Não fez / 5',
      'AV4: Tirou zero / 5',
      'AV5: Nota 4 / 5',
    ]);
    expect(host.textContent).not.toContain('Nota —');
  });
});
