// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RelationalBulletinModelV2,
  RelationalBulletinSnapshotV2,
} from '../../../shared/gradebook-contracts/bulletins/relational-bulletin-v2';
import {
  CLASSIFICATION_COLOR_V2,
  RelationalBulletinPageV2,
} from '../../../src/features/gradebook/bulletins/relational-bulletin-page-v2';
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

function reply(value: unknown): Response {
  return Response.json(value);
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
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (body.operation === 'bootstrap') {
        return reply({
          contractVersion: 2,
          operation: 'bootstrap',
          state: 'ready',
          years: [{ year: 2026, minimumApprovalMilli: 60_000, maxCouncilComponents: 2 }],
        });
      }
      if (body.operation === 'catalog') {
        return reply({
          contractVersion: 2,
          operation: 'catalog',
          state: 'ready',
          year: 2026,
          classes: [{ id: 10, code: '6A', name: '6º ANO A', label: '6º ANO A', studentCount: 1 }],
        });
      }
      if (body.operation === 'students') {
        return reply({
          contractVersion: 2,
          operation: 'students',
          state: 'ready',
          classGroup: { id: 10, code: '6A', name: '6º ANO A', label: '6º ANO A' },
          students: [
            {
              id: 20,
              number: 1,
              name: 'ALUNO SINTÉTICO',
              statusCode: null,
              statusLabel: 'REGULAR',
            },
          ],
        });
      }
      if (body.operation === 'preview') {
        return reply({ contractVersion: 2, operation: 'preview', state: 'ready', model });
      }
      if (body.operation === 'emit') {
        return reply({ contractVersion: 2, operation: 'emit', state: 'ready', snapshot });
      }
      throw new Error(`unexpected-operation:${String(body.operation)}`);
    }),
  );
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

describe('relational bulletin V2 HeroUI journey', () => {
  it('colours the annual result green only when approved', () => {
    expect(CLASSIFICATION_COLOR_V2['not-approved']).toBe('danger');
    expect(CLASSIFICATION_COLOR_V2['failed-no-show']).toBe('danger');
    expect(CLASSIFICATION_COLOR_V2['failed-repeat']).toBe('danger');
    expect(CLASSIFICATION_COLOR_V2['approved-direct']).toBe('success');
    expect(CLASSIFICATION_COLOR_V2['approved-after-recovery']).toBe('success');
    expect(CLASSIFICATION_COLOR_V2['in-progress']).toBe('default');
    expect(CLASSIFICATION_COLOR_V2['recovery-pending']).toBe('default');
  });

  it('keeps filters stable, uses full class names and previews official versus calculated values', async () => {
    await mount();
    await select('Turma', '10');
    await waitFor(() => host.textContent?.includes('ALUNO SINTÉTICO') === true);
    await select('Aluno da prévia', '20');
    expect(host.textContent).toContain('0 selecionado(s)');
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    const batch = [...host.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('Emitir lote (0)'),
    );
    expect(batch).toBeDefined();
    expect(batch?.hasAttribute('disabled')).toBe(true);
    await click('Gerar prévia');
    expect(requests.at(-1)).toMatchObject({
      operation: 'preview',
      selection: { year: 2026, classId: 10, studentId: 20 },
    });
    expect(host.textContent).toContain('6º ANO A');
    expect(host.textContent).toContain('AM oficial');
    expect(host.textContent).toContain('25');
    expect(host.textContent).toContain('Diverge');
    expect(host.querySelectorAll('[data-slot="select"]')).toHaveLength(4);
    expect(host.querySelectorAll('[draggable="true"]')).toHaveLength(0);
  });

  it('shows official PDF actions only after an immutable emission', async () => {
    await mount();
    await select('Turma', '10');
    await waitFor(() => host.textContent?.includes('ALUNO SINTÉTICO') === true);
    await select('Aluno da prévia', '20');
    await click('Emitir individual');
    expect(host.textContent).toContain('Emitido · v1');
    expect(host.textContent).toContain('Baixar PDF oficial');
    expect(host.textContent).toContain('Imprimir PDF oficial');
  });

  it('contains no year creation, cross-year comparison, native select markup or drag contract', () => {
    const source = readFileSync(
      'src/features/gradebook/bulletins/relational-bulletin-page-v2.tsx',
      'utf8',
    );
    expect(source).not.toContain('<select');
    expect(source).not.toMatch(/ano anterior|comparação entre anos|criar ano|draggable=/iu);
    expect(source).toContain('year: year!');
    expect(source).toContain('useGradebookYear');
    expect(source).toContain("runPdf('download')");
    expect(source).toContain("runPdf('print')");
  });
});
