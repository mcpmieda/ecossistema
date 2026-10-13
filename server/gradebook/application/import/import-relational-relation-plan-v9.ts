import type { GradebookRelationImportRequestV9, GradebookRelationWarningV9,
  GradebookRelationMovementGroupV9, GradebookRelationMovementPairV9,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
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
    readonly movementGroups?: readonly GradebookRelationMovementGroupV9[],
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

interface MovementReviewGroupV9 {
  readonly origins: RelationSourceBindingV9[];
  readonly destinations: RelationSourceBindingV9[];
}

interface MovementLinksV9 {
  readonly union: UnionFindV9;
  readonly externalSeed: Map<number, number>;
  readonly warnings: RelationMovementWarningV9[];
}

function spellingWarningV9(
  origin: RelationSourceBindingV9,
  destination: RelationSourceBindingV9,
): RelationMovementWarningV9 {
  return { code: 'movement-spelling', classCode: origin.turmaCode,
    number: origin.numero, relatedClassCode: destination.turmaCode };
}

/** Movements whose two ends carry the same name are linked directly; the others still need a pair. */
function linkNamedMovementsV9(
  source: readonly RelationSourceBindingV9[],
  sourceByNameClass: ReadonlyMap<string, readonly RelationSourceBindingV9[]>,
  union: UnionFindV9,
): RelationSourceBindingV9[] {
  const unmatched: RelationSourceBindingV9[] = [];
  for (const item of source) {
    if (item.relatedTurmaId === null) continue;
    const key = nameClassKeyV9(item.relatedTurmaId, item.nome);
    const candidates = sourceByNameClass.get(key) ?? [];
    if (candidates.length > 1) {
      throw new RelationPlanErrorV9('blocked', `Movimentação ambígua para ${item.nome}.`);
    }
    if (candidates.length === 1) union.union(item.index, candidates[0]!.index);
    else unmatched.push(item);
  }
  return unmatched;
}

function isReciprocalMovementV9(item: RelationSourceBindingV9, other: RelationSourceBindingV9): boolean {
  return other.turmaId === item.relatedTurmaId && other.relatedTurmaId === item.turmaId &&
    ((item.situacao === 6 && other.situacao === 7) || (item.situacao === 7 && other.situacao === 6));
}

function isSameDirectionMovementV9(item: RelationSourceBindingV9, other: RelationSourceBindingV9): boolean {
  return other.turmaId === item.turmaId &&
    other.relatedTurmaId === item.relatedTurmaId && other.situacao === item.situacao;
}

/** An end without a counterpart in the file continues the single student already bound by name. */
function externalMovementSeedV9(
  item: RelationSourceBindingV9,
  existingByNameClass: ReadonlyMap<string, readonly ExistingRelationBindingV9[]>,
): number {
  const key = nameClassKeyV9(item.relatedTurmaId!, item.nome);
  const existing = existingByNameClass.get(key) ?? [];
  const ids = [...new Set(existing.map((value) => value.alunoId))];
  if (ids.length === 1) return ids[0]!;
  throw new RelationPlanErrorV9(
    'blocked',
    ids.length === 0
      ? `Movimentação sem vínculo de origem/destino para ${item.nome}.`
      : `Movimentação ambígua para ${item.nome}.`,
  );
}

/** The exits ("FOI PARA", 6) and the entries ("ESTAVA NO", 7) that the operator has to pair. */
function movementReviewGroupV9(
  item: RelationSourceBindingV9,
  reciprocal: RelationSourceBindingV9[],
  sameDirection: RelationSourceBindingV9[],
): MovementReviewGroupV9 {
  return {
    origins: item.situacao === 6 ? sameDirection : reciprocal,
    destinations: item.situacao === 7 ? sameDirection : reciprocal,
  };
}

function pairedSpellingWarningV9(
  item: RelationSourceBindingV9,
  other: RelationSourceBindingV9,
): RelationMovementWarningV9 {
  const origin = item.situacao === 6 ? item : other;
  const destination = item.situacao === 7 ? item : other;
  return spellingWarningV9(origin, destination);
}

/** One exit and one entry between two classes are the same student even when spelled differently;
 * more than one of either is left for the operator to pair. */
function pairUnnamedMovementsV9(
  unmatched: readonly RelationSourceBindingV9[],
  existingByNameClass: ReadonlyMap<string, readonly ExistingRelationBindingV9[]>,
  links: MovementLinksV9,
): MovementReviewGroupV9[] {
  const reviewGroups = new Map<string, MovementReviewGroupV9>();
  const paired = new Set<number>();
  for (const item of unmatched) {
    if (paired.has(item.index)) continue;
    const reciprocal = unmatched.filter((other) => isReciprocalMovementV9(item, other));
    if (reciprocal.length === 0) {
      links.externalSeed.set(item.index, externalMovementSeedV9(item, existingByNameClass));
      continue;
    }
    const sameDirection = unmatched.filter((other) => isSameDirectionMovementV9(item, other));
    if (reciprocal.length !== 1 || sameDirection.length !== 1) {
      const group = movementReviewGroupV9(item, reciprocal, sameDirection);
      reviewGroups.set(`${group.origins[0]!.turmaId}:${group.destinations[0]!.turmaId}`, group);
      continue;
    }
    const other = reciprocal[0]!;
    links.union.union(item.index, other.index);
    paired.add(item.index);
    paired.add(other.index);
    links.warnings.push(pairedSpellingWarningV9(item, other));
  }
  return [...reviewGroups.values()];
}

function movementReviewErrorV9(groups: readonly MovementReviewGroupV9[]): RelationPlanErrorV9 {
  const endpoint = (item: RelationSourceBindingV9) => ({ classCode: item.turmaCode, number: item.numero, name: item.nome });
  return new RelationPlanErrorV9('review-required',
    `Confira os pares de movimentação entre ${groups[0]!.origins[0]!.turmaCode} e ${groups[0]!.destinations[0]!.turmaCode}.`,
    groups.map((group) => ({ origins: group.origins.map(endpoint), destinations: group.destinations.map(endpoint) })));
}

function isChosenMovementPairV9(origin: RelationSourceBindingV9, destination: RelationSourceBindingV9): boolean {
  return origin.situacao === 6 && destination.situacao === 7 &&
    origin.relatedTurmaId === destination.turmaId && destination.relatedTurmaId === origin.turmaId;
}

/** The operator's pairs must be exactly the open movements of the file, each end used once. */
function applyMovementChoicesV9(
  groups: readonly MovementReviewGroupV9[],
  choices: readonly GradebookRelationMovementPairV9[],
  links: MovementLinksV9,
): void {
  const key = (code: string, number: number) => JSON.stringify([classKeyV9(code), number]);
  const origins = new Map(groups.flatMap((group) => group.origins.map((item) => [key(item.turmaCode, item.numero), item] as const)));
  const destinations = new Map(groups.flatMap((group) => group.destinations.map((item) => [key(item.turmaCode, item.numero), item] as const)));
  if (choices.length === 0 || choices.length !== origins.size || choices.length !== destinations.size)
    throw new RelationPlanErrorV9('conflict', 'Confira todos os pares de movimentação novamente.');
  for (const choice of choices) {
    const originKey = key(choice.origin.classCode, choice.origin.number);
    const destinationKey = key(choice.destination.classCode, choice.destination.number);
    const origin = origins.get(originKey);
    const destination = destinations.get(destinationKey);
    if (!origin || !destination || !isChosenMovementPairV9(origin, destination))
      throw new RelationPlanErrorV9('conflict', 'Os pares escolhidos não correspondem às movimentações do arquivo.');
    origins.delete(originKey);
    destinations.delete(destinationKey);
    links.union.union(origin.index, destination.index);
    links.warnings.push(spellingWarningV9(origin, destination));
  }
}

function linkMovementSourcesV9(
  source: readonly RelationSourceBindingV9[],
  sourceByNameClass: ReadonlyMap<string, readonly RelationSourceBindingV9[]>,
  existingByNameClass: ReadonlyMap<string, readonly ExistingRelationBindingV9[]>,
  choices: readonly GradebookRelationMovementPairV9[] | undefined,
): MovementLinksV9 {
  const links: MovementLinksV9 = {
    union: new UnionFindV9(source.length),
    externalSeed: new Map<number, number>(),
    warnings: [],
  };
  const unmatched = linkNamedMovementsV9(source, sourceByNameClass, links.union);
  const groups = pairUnnamedMovementsV9(unmatched, existingByNameClass, links);
  if (groups.length > 0 && choices === undefined) throw movementReviewErrorV9(groups);
  if (choices !== undefined) applyMovementChoicesV9(groups, choices, links);
  return links;
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
    // The operator needs the positions to correct the Relação; names stay out of this refusal.
    const positions = items.map((item) => `${item.turmaCode} nº ${item.numero}`).join(' e ');
    throw new RelationPlanErrorV9('conflict',
      `A movimentação entre ${positions} envolve identidades distintas. Confira os vínculos existentes.`);
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
  const linked = linkMovementSourcesV9(source, sourceByNameClass, indexes.byNameClass, request.movementReview?.pairs);
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
