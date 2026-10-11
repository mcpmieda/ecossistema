import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentReconciliationV1 } from '../../src/features/student-portal-admin/accounts/student-reconciliation-v1';
import { ReportValidationErrorsV1 } from '../../src/features/gradebook/import/student-report-import-v1';
import {
  createReconciliationActivationV1,
  createReconciliationClientV1,
  type PreparedReconciliationV1,
  type ReconciliationClientV1,
} from '../../src/features/student-portal-admin/shared/reconciliation-client-v1';
import type {
  ReconciliationRequestV1,
  ReconciliationResponseV1,
} from '../../shared/student-identity/reconciliation-v1';

const uid = '12690000-0000-4000-8000-000000000001';
const sourceId = '12690000-0000-4000-8000-000000000002';
const batchId = '12690000-0000-4000-8000-000000000003';
const context = {
  generation: '12690000-0000-4000-8000-000000000004',
  revision: 1,
  nameSource: 'report' as const,
  relationAvailable: true,
};
const prepare: PreparedReconciliationV1 = {
  contractVersion: 1,
  state: 'ready',
  operation: 'prepare',
  context,
  batchId,
  batchState: 'preparing',
  expiresAt: '2099-01-01T00:00:00Z',
  differences: [],
  counts: { rows: 1, linked: 1, pending: 0 },
  credentialsReady: false,
};
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Relatório e aba Alunos', () => {
  it('mostra pessoa sem conta e pendência sem UID, carregando histórico somente ao abrir', async () => {
    const request = vi.fn(
      async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
        if (input.operation === 'catalog')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'catalog',
            context,
            classes: [],
            reportClasses: [],
          };
        if (input.operation === 'detail')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'detail',
            context,
            selectedObservationId: null,
            sources: [],
            candidates: [],
            history: [],
          };
        return {
          contractVersion: 1,
          state: 'ready',
          operation: 'list',
          context,
          nextCursor: null,
          items: [
            {
              kind: 'person',
              studentUid: uid,
              academicStudentId: 1,
              academicYear: 2026,
              name: 'Pessoa Sem Conta',
              relationName: 'Pessoa Sem Conta',
              classId: 7,
              classLabel: '7A',
              version: 1,
              reconciliation: 'without-report',
              portal: 'without-portal',
              accountId: null,
              possibleSamePerson: false,
            },
            {
              kind: 'external',
              id: 'synthetic-pending',
              sourceId,
              batchId,
              name: 'Pessoa Externa',
              classLabel: '7A',
              reason: 'no_match',
              expiresAt: null,
              warning: false,
              sourceRow: 2,
            },
          ],
        };
      },
    );
    render(
      <StudentReconciliationV1
        client={{ request }}
        scope={{ kind: 'school', academicYear: 2026 }}
        canWrite
      />,
    );
    await screen.findByText('Pessoa Sem Conta');
    expect(screen.getByText('Pessoa Externa')).toBeTruthy();
    expect(screen.getByText('Sem Portal')).toBeTruthy();
    expect(request.mock.calls.some(([input]) => input.operation === 'detail')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Pessoa Sem Conta' }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([input]) => input.operation === 'detail' && input.studentUid === uid,
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole('button', { name: 'Acesso ao Portal' })).toBeNull();
  });
  it('lista todos os erros de nascimento como texto, com aluno e turma destacados', () => {
    render(
      <ReportValidationErrorsV1
        errors={[
          {
            sourceRow: 2,
            name: '<img src=x onerror=alert(1)>',
            classLabel: '7A',
            field: 'birthDate',
            reason: 'nascimento ausente.',
          },
          {
            sourceRow: 9,
            name: 'Pessoa Sintética com Nome Longo',
            classLabel: '8B',
            field: 'birthDate',
            reason: 'nascimento inválido.',
          },
        ]}
      />,
    );
    expect(screen.getByText('<img src=x onerror=alert(1)> — 7A').tagName).toBe('STRONG');
    expect(screen.getByText('Pessoa Sintética com Nome Longo — 8B').tagName).toBe('STRONG');
    expect(screen.getByText('Linha 9')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
  it.each(['reconciled', 'review-required'] as const)(
    'permite escolher dados de uma única matrícula em estado %s sem preparar outro relatório',
    async (reconciliation) => {
      const request = vi.fn(
        async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
          if (input.operation === 'catalog')
            return {
              contractVersion: 1,
              state: 'ready',
              operation: 'catalog',
              context,
              classes: [],
              reportClasses: [],
            };
          if (input.operation === 'list')
            return {
              contractVersion: 1,
              state: 'ready',
              operation: 'list',
              context,
              nextCursor: null,
              items: [
                {
                  kind: 'person',
                  studentUid: uid,
                  academicStudentId: 1,
                  academicYear: 2026,
                  name: 'Nome Sintético do Relatório',
                  relationName: 'Nome Sintético da Relação',
                  classId: 7,
                  classLabel: '7A',
                  version: 2,
                  reconciliation,
                  portal: 'without-portal',
                  accountId: null,
                  possibleSamePerson: false,
                },
              ],
            };
          if (input.operation === 'detail')
            return {
              contractVersion: 1,
              state: 'ready',
              operation: 'detail',
              context,
              selectedObservationId: reconciliation === 'review-required' ? batchId : uid,
              sources: [
                {
                  id: sourceId,
                  observationId: batchId,
                  name: 'Nome Sintético Corrigido',
                  classLabel: '7A',
                  birthDate: '2013-03-22',
                  filiation1: null,
                  inep: '00123',
                  studentUid: uid,
                  version: 2,
                  decisionId: sourceId,
                  reviewRequired: false,
                },
              ],
              candidates: [],
              history: [],
            };
          if (input.operation === 'select-observation') return prepare;
          if (input.operation === 'stage')
            return {
              contractVersion: 1,
              state: 'ready',
              operation: 'stage',
              remaining: 0,
              ready: true,
            };
          return { contractVersion: 1, state: 'committed', context, operationId: batchId };
        },
      );
      render(
        <StudentReconciliationV1
          client={{ request }}
          scope={{ kind: 'school', academicYear: 2026 }}
          canWrite
        />,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Nome Sintético do Relatório' }));
      expect(await screen.findByText('Relação: Nome Sintético da Relação')).toBeTruthy();
      fireEvent.click(await screen.findByRole('button', { name: 'Usar estes dados' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Confirmar decisão' }));
      await waitFor(() =>
        expect(request.mock.calls.some(([input]) => input.operation === 'apply')).toBe(true),
      );
      const mutations = request.mock.calls
        .map(([input]) => input)
        .filter((input) => !['catalog', 'list', 'detail'].includes(input.operation));
      expect(mutations.map((input) => input.operation)).toEqual([
        'select-observation',
        'stage',
        'apply',
      ]);
      expect(mutations[0]).toMatchObject({ studentUid: uid, observationId: batchId });
    },
  );
  it('prepara todas as credenciais antes da única ativação e repete a mesma chave após resposta perdida', async () => {
    let stages = 0;
    let applies = 0;
    const request = vi.fn(
      async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
        if (input.operation === 'stage')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'stage',
            ready: ++stages === 2,
            remaining: stages === 1 ? 1 : 0,
          };
        if (input.operation === 'apply' && ++applies === 1) throw new Error('Resposta perdida');
        return {
          contractVersion: 1,
          state: 'committed',
          context,
          operationId: 'synthetic-operation',
        };
      },
    );
    const activate = createReconciliationActivationV1(prepare, false);
    await expect(activate({ request }, vi.fn())).rejects.toThrow('Resposta perdida');
    await expect(activate({ request }, vi.fn())).resolves.toMatchObject({ state: 'committed' });
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual([
      'stage',
      'stage',
      'apply',
      'apply',
    ]);
    expect(request.mock.calls[2]![0]).toEqual(request.mock.calls[3]![0]);
  });
  it('preparação incompleta ou expirada nunca chama apply', async () => {
    const request = vi.fn(async (): Promise<ReconciliationResponseV1> => ({
      contractVersion: 1,
      state: 'expired',
    }));
    const activate = createReconciliationActivationV1(prepare, true);
    expect(await activate({ request } satisfies ReconciliationClientV1, vi.fn())).toMatchObject({
      state: 'expired',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('transporte mantém bytes e chave idempotente na repetição técnica e exige no-store', async () => {
    const bodies: string[] = [];
    const fetcher = vi.fn(async (_path: string, init: RequestInit) => {
      bodies.push(String(init.body));
      if (bodies.length === 1) throw new Error('Resposta perdida');
      return new Response(
        JSON.stringify({ contractVersion: 1, state: 'committed', context, operationId: batchId }),
        { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
      );
    });
    const client = createReconciliationClientV1({ fetch: fetcher });
    await client.request({
      contractVersion: 1,
      academicYear: 2026,
      operation: 'apply',
      generation: context.generation,
      expectedRevision: 1,
      batchId,
      idempotencyKey: uid,
      confirmDifferences: true,
    });
    expect(bodies[0]).toBe(bodies[1]);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      credentials: 'same-origin',
      cache: 'no-store',
    });
  });
});
