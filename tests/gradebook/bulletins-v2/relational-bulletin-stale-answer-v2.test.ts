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
    return { contractVersion: 2, operation: 'preview', state: 'ready', model };
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

  it('drops an emission whose detail was changed before it arrived', async () => {
    await readyToPreview();
    holding.add('emit');
    await click('Emitir individual');
    await select('Detalhamento', 'detailed');
    await release('emit');
    expect(host.textContent).not.toContain('Emitido · v1');
    expect(host.textContent).not.toContain('Baixar PDF oficial');
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
