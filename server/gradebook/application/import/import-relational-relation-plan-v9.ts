import type { GradebookRelationImportRequestV9, GradebookRelationWarningV9 } from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { normalizeStudentNameV1 } from '../../../../shared/student-identity/reconciliation-normalization-v1';

export interface ResolvedRelationClassV9 {
  readonly id: number;
  readonly codigo: string;
}

export interface ExistingRelationBindingV9 {
  readonly turmaId: number;
  readonly numero: number;
  readonly alunoId: number;
  readonly situacao: number | null;
  readonly turmaRelacionadaId: number | null;
  readonly nome: string;
  readonly studentUid?: string;
}

export interface RelationSourceBindingV9 {
  readonly index: number;
  readonly turmaId: number;
  readonly turmaCode: string;
  readonly numero: number;
  readonly nome: string;
  readonly situacao: number | null;
  readonly relatedTurmaId: number | null;
}

export interface RelationComponentV9 {
  readonly items: readonly RelationSourceBindingV9[];
  readonly seedAlunoId: number | null;
  readonly preferred: RelationSourceBindingV9;
}

export type RelationMovementWarningV9 = GradebookRelationWarningV9;

export interface RelationPlanV9 {
  readonly source: readonly RelationSourceBindingV9[];
  readonly orderedSource: readonly RelationSourceBindingV9[];
  readonly existingByBinding: ReadonlyMap<string, ExistingRelationBindingV9>;
  readonly components: readonly RelationComponentV9[];
  readonly warnings: readonly RelationMovementWarningV9[];
}

export class RelationPlanErrorV9 extends Error {
  constructor(
    readonly state: 'blocked' | 'conflict' | 'review-required',
    readonly reason: string,
  ) {
    super(reason);
  }
}

class UnionFindV9 {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(value: number): number {
    const parent = this.parent[value]!;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent[value] = root;
    return root;
  }

  union(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent[b] = a;
  }
}

export function normalizeRelationNameV9(value: string): string {
  return normalizeStudentNameV1(value);
}

function classKeyV9(value: string): string {
  return value.trim().toUpperCase();
}

export function relationBindingKeyV9(turmaId: number, numero: number): string {
  return `${turmaId}:${numero}`;
}

function nameClassKeyV9(turmaId: number, name: string): string {
  return `${turmaId}:${normalizeRelationNameV9(name)}`;
}

function indexExistingBindingsV9(existing: readonly ExistingRelationBindingV9[]): {
  readonly byBinding: ReadonlyMap<string, ExistingRelationBindingV9>;
  readonly byNameClass: ReadonlyMap<string, readonly ExistingRelationBindingV9[]>;
} {
  const byBinding = new Map<string, ExistingRelationBindingV9>();
  const byNameClass = new Map<string, ExistingRelationBindingV9[]>();
  for (const item of existing) {
    byBinding.set(relationBindingKeyV9(item.turmaId, item.numero), item);
    const key = nameClassKeyV9(item.turmaId, item.nome);
    const values = byNameClass.get(key) ?? [];
    values.push(item);
    byNameClass.set(key, values);
  }
  return { byBinding, byNameClass };
}

function materializeSourceBindingsV9(
  request: GradebookRelationImportRequestV9,
  classes: ReadonlyMap<string, ResolvedRelationClassV9>,
): readonly RelationSourceBindingV9[] {
  const source: RelationSourceBindingV9[] = [];
  for (const turma of request.turmas) {
    const resolved = classes.get(classKeyV9(turma.codigo));
    if (!resolved) throw new Error('resolved-class-missing');
    for (const aluno of turma.alunos) {
      const related = aluno[3] === undefined ? null : classes.get(classKeyV9(aluno[3]));
      if (aluno[3] !== undefined && !related) {
        throw new RelationPlanErrorV9(
          'blocked',
          `Turma relacionada não encontrada: ${aluno[3]}.`,
        );
      }
      source.push({
        index: source.length,
        turmaId: resolved.id,
        turmaCode: resolved.codigo,
        numero: aluno[0],
        nome: aluno[1].trim(),
        situacao: aluno[2] === 0 ? null : aluno[2],
        relatedTurmaId: related?.id ?? null,
      });
    }
  }
  return source;
}

function indexSourceByNameClassV9(
  source: readonly RelationSourceBindingV9[],
): ReadonlyMap<string, readonly RelationSourceBindingV9[]> {
  const result = new Map<string, RelationSourceBindingV9[]>();
  for (const item of source) {
    const key = nameClassKeyV9(item.turmaId, item.nome);
    const values = result.get(key) ?? [];
    values.push(item);
    result.set(key, values);
  }
  return result;
}

function linkMovementSourcesV9(
  source: readonly RelationSourceBindingV9[],
  sourceByNameClass: ReadonlyMap<string, readonly RelationSourceBindingV9[]>,
  existingByNameClass: ReadonlyMap<string, readonly ExistingRelationBindingV9[]>,
): {
  readonly union: UnionFindV9;
  readonly externalSeed: ReadonlyMap<number, number>;
  readonly warnings: readonly RelationMovementWarningV9[];
} {
  const union = new UnionFindV9(source.length);
  const externalSeed = new Map<number, number>();
  const unmatched: RelationSourceBindingV9[] = [];
  const warnings: RelationMovementWarningV9[] = [];

  for (const item of source) {
    if (item.relatedTurmaId === null) continue;
    const key = nameClassKeyV9(item.relatedTurmaId, item.nome);
    const candidates = sourceByNameClass.get(key) ?? [];
    if (candidates.length > 1) {
      throw new RelationPlanErrorV9('blocked', `Movimentação ambígua para ${item.nome}.`);
    }
    if (candidates.length === 1) {
      union.union(item.index, candidates[0]!.index);
      continue;
    }
    unmatched.push(item);
  }

  const paired = new Set<number>();
  for (const item of unmatched) {
    if (paired.has(item.index)) continue;
    const reciprocal = unmatched.filter((other) =>
      other.turmaId === item.relatedTurmaId && other.relatedTurmaId === item.turmaId &&
      ((item.situacao === 6 && other.situacao === 7) || (item.situacao === 7 && other.situacao === 6)),
    );
    const sameDirection = unmatched.filter((other) => other.turmaId === item.turmaId &&
      other.relatedTurmaId === item.relatedTurmaId && other.situacao === item.situacao);
    if (reciprocal.length > 0) {
      if (reciprocal.length !== 1 || sameDirection.length !== 1) {
        throw new RelationPlanErrorV9('review-required', 'Confira os pares de movimentação entre as turmas.');
      }
      const other = reciprocal[0]!;
      union.union(item.index, other.index);
      paired.add(item.index);
      paired.add(other.index);
      const origin = item.situacao === 6 ? item : other;
      const destination = item.situacao === 7 ? item : other;
      warnings.push({ code: 'movement-spelling', classCode: origin.turmaCode,
        number: origin.numero, relatedClassCode: destination.turmaCode });
      continue;
    }

    const key = nameClassKeyV9(item.relatedTurmaId!, item.nome);
    const existing = existingByNameClass.get(key) ?? [];
    const ids = [...new Set(existing.map((value) => value.alunoId))];
    if (ids.length !== 1) {
      throw new RelationPlanErrorV9(
        'blocked',
        ids.length === 0
          ? `Movimentação sem vínculo de origem/destino para ${item.nome}.`
          : `Movimentação ambígua para ${item.nome}.`,
      );
    }
    externalSeed.set(item.index, ids[0]!);
  }

  return { union, externalSeed, warnings };
}

function groupComponentsV9(
  source: readonly RelationSourceBindingV9[],
  union: UnionFindV9,
): ReadonlyMap<number, readonly RelationSourceBindingV9[]> {
  const components = new Map<number, RelationSourceBindingV9[]>();
  for (const item of source) {
    const root = union.find(item.index);
    const values = components.get(root) ?? [];
    values.push(item);
    components.set(root, values);
  }
  return components;
}

function buildComponentV9(
  items: readonly RelationSourceBindingV9[],
  existingByBinding: ReadonlyMap<string, ExistingRelationBindingV9>,
  externalSeed: ReadonlyMap<number, number>,
): RelationComponentV9 {
  const seeds = new Set<number>();
  for (const item of items) {
    const existing = existingByBinding.get(relationBindingKeyV9(item.turmaId, item.numero));
    if (existing) seeds.add(existing.alunoId);
    const external = externalSeed.get(item.index);
    if (external !== undefined) seeds.add(external);
  }
  const preferred = items.find((item) => item.situacao !== 6) ?? items[0]!;
  if (seeds.size > 1) {
    throw new RelationPlanErrorV9('conflict', 'A movimentação envolve identidades distintas. Confira os vínculos existentes.');
  }
  return {
    items,
    seedAlunoId: [...seeds][0] ?? null,
    preferred,
  };
}

export function buildRelationPlanV9(
  request: GradebookRelationImportRequestV9,
  classes: ReadonlyMap<string, ResolvedRelationClassV9>,
  existing: readonly ExistingRelationBindingV9[],
): RelationPlanV9 {
  const indexes = indexExistingBindingsV9(existing);
  const source = materializeSourceBindingsV9(request, classes);
  const sourceByNameClass = indexSourceByNameClassV9(source);
  const linked = linkMovementSourcesV9(source, sourceByNameClass, indexes.byNameClass);
  const components = [...groupComponentsV9(source, linked.union).values()].map((items) =>
    buildComponentV9(items, indexes.byBinding, linked.externalSeed),
  );
  const orderedSource = [...source].sort((left, right) => {
    const leftMoved = left.situacao === 6;
    const rightMoved = right.situacao === 6;
    if (leftMoved !== rightMoved) return leftMoved ? -1 : 1;
    return left.index - right.index;
  });
  return {
    source,
    orderedSource,
    existingByBinding: indexes.byBinding,
    components,
    warnings: linked.warnings,
  };
}
