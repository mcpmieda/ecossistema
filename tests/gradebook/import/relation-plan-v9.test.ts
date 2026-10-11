// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { GradebookRelationImportRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import {
  buildRelationPlanV9,
  RelationPlanErrorV9,
  type ExistingRelationBindingV9,
  type ResolvedRelationClassV9,
} from '../../../server/gradebook/application/import/import-relational-relation-plan-v9';

const manifest = {
  fileName: 'relation-plan-v9.xlsb',
  sha256: 'a'.repeat(64),
  parserVersion: 'synthetic-relation-plan-v9',
} as const;

const classes = new Map<string, ResolvedRelationClassV9>([
  ['6A', { id: 10, codigo: '6A' }],
  ['6B', { id: 20, codigo: '6B' }],
]);

function request(
  classA: GradebookRelationImportRequestV9['turmas'][number]['alunos'],
  classB: GradebookRelationImportRequestV9['turmas'][number]['alunos'] = [],
): GradebookRelationImportRequestV9 {
  return {
    transportVersion: 9,
    operation: 'persist-relacao',
    manifest,
    ano: 2026,
    turmas: [
      { codigo: '6A', nome: '6A', etapa: 6, turno: 'M', alunos: classA },
      { codigo: '6B', nome: '6B', etapa: 6, turno: 'M', alunos: classB },
    ],
  };
}

describe('relation movement planner V9', () => {
  it('groups source movements into one component and prefers the non-moved row', () => {
    const plan = buildRelationPlanV9(
      request(
        [[1, 'ALUNO TESTE', 6, '6B']],
        [[3, 'ALUNO TESTE', 0]],
      ),
      classes,
      [],
    );

    expect(plan.components).toHaveLength(1);
    expect(plan.components[0]).toMatchObject({
      seedAlunoId: null,
      preferred: {
        turmaId: 20,
        numero: 3,
        nome: 'ALUNO TESTE',
        situacao: null,
      },
    });
    expect(plan.components[0]!.items.map((item) => item.index)).toEqual([0, 1]);
    expect(plan.orderedSource.map((item) => item.index)).toEqual([0, 1]);
  });

  it('uses one existing related binding as the external student seed', () => {
    const existing: ExistingRelationBindingV9[] = [
      {
        turmaId: 20,
        numero: 8,
        alunoId: 900,
        situacao: null,
        turmaRelacionadaId: null,
        nome: 'ALUNO TESTE',
      },
    ];
    const plan = buildRelationPlanV9(
      request([[1, 'ALUNO TESTE', 6, '6B']]),
      classes,
      existing,
    );
    expect(plan.components[0]?.seedAlunoId).toBe(900);
  });

  it('fails closed when a related class is missing', () => {
    expect(() =>
      buildRelationPlanV9(
        request([[1, 'ALUNO TESTE', 6, '7X']]),
        classes,
        [],
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RelationPlanErrorV9>>({
        state: 'blocked',
        reason: 'Turma relacionada não encontrada: 7X.',
      }),
    );
  });

  it('blocks ambiguous source movement candidates', () => {
    expect(() =>
      buildRelationPlanV9(
        request(
          [[1, 'ALUNO TESTE', 6, '6B']],
          [
            [2, 'ALUNO TESTE', 0],
            [3, 'ALUNO TESTE', 0],
          ],
        ),
        classes,
        [],
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RelationPlanErrorV9>>({
        state: 'blocked',
        reason: 'Movimentação ambígua para ALUNO TESTE.',
      }),
    );
  });

  it('blocks movement without one source/destination binding', () => {
    expect(() =>
      buildRelationPlanV9(
        request([[1, 'ALUNO TESTE', 6, '6B']]),
        classes,
        [],
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RelationPlanErrorV9>>({
        state: 'blocked',
        reason: 'Movimentação sem vínculo de origem/destino para ALUNO TESTE.',
      }),
    );
  });

  it('never merges the identities of two existing reciprocal positions', () => {
    const existing: ExistingRelationBindingV9[] = [
      {
        turmaId: 10,
        numero: 1,
        alunoId: 100,
        situacao: null,
        turmaRelacionadaId: null,
        nome: 'ALUNO TESTE',
      },
      {
        turmaId: 20,
        numero: 3,
        alunoId: 200,
        situacao: null,
        turmaRelacionadaId: null,
        nome: 'ALUNO TÉSTE',
      },
    ];
    expect(() => buildRelationPlanV9(
      request(
        [[1, 'ALUNO TESTE', 6, '6B']],
        [[3, 'ALUNO TESTE', 7, '6A']],
      ),
      classes,
      existing,
    )).toThrowError(expect.objectContaining({ state: 'conflict' }));
  });

  it('reports conflict when one component is already linked to different students', () => {
    const existing: ExistingRelationBindingV9[] = [
      {
        turmaId: 10,
        numero: 1,
        alunoId: 100,
        situacao: 6,
        turmaRelacionadaId: 20,
        nome: 'ALUNO TESTE',
      },
      {
        turmaId: 20,
        numero: 3,
        alunoId: 200,
        situacao: null,
        turmaRelacionadaId: null,
        nome: 'ALUNO TESTE',
      },
    ];
    expect(() =>
      buildRelationPlanV9(
        request(
          [[1, 'ALUNO TESTE', 6, '6B']],
          [[3, 'ALUNO TESTE', 0]],
        ),
        classes,
        existing,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RelationPlanErrorV9>>({
        state: 'conflict',
        reason: 'A movimentação entre 6A nº 1 e 6B nº 3 envolve identidades distintas. Confira os vínculos existentes.',
      }),
    );
  });

  it('links a unique reciprocal pair with different spelling and returns a warning without personal names', () => {
    const plan = buildRelationPlanV9(request(
      [[1, 'ESTUDANTE SINTETICO ORIGEM', 6, '6B']],
      [[3, 'ESTUDANTE SINTETICO CORRIGIDO', 7, '6A']],
    ), classes, [{ turmaId: 10, numero: 1, alunoId: 100, situacao: null,
      turmaRelacionadaId: null, nome: 'ESTUDANTE SINTETICO ORIGEM', studentUid: '11111111-1111-4111-8111-111111111111' }]);
    expect(plan.components).toHaveLength(1);
    expect(plan.components[0]).toMatchObject({ seedAlunoId: 100, preferred: { turmaId: 20, numero: 3 } });
    expect(plan.warnings).toEqual([{ code: 'movement-spelling', classCode: '6A', number: 1, relatedClassCode: '6B' }]);
  });

  it('requests review rather than guessing when there are multiple unmatched reciprocal pairs', () => {
    expect(() => buildRelationPlanV9(request(
      [[1, 'SINTETICO UM', 6, '6B'], [2, 'SINTETICO DOIS', 6, '6B']],
      [[3, 'SINTETICO CORRIGIDO UM', 7, '6A'], [4, 'SINTETICO CORRIGIDO DOIS', 7, '6A']],
    ), classes, [])).toThrowError(expect.objectContaining({
      state: 'review-required',
      reason: 'Confira os pares de movimentação entre 6A e 6B.',
    }));
  });

  it('never treats a nonreciprocal unmatched pair as evidence of movement', () => {
    expect(() => buildRelationPlanV9(request(
      [[1, 'SINTETICO ORIGEM', 6, '6B']], [[3, 'SINTETICO OUTRO', 0]],
    ), classes, [])).toThrowError(expect.objectContaining({ state: 'blocked' }));
  });
});
