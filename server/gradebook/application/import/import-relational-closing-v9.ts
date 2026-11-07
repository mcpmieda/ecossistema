import type {
  GradebookImportCellV9,
  GradebookImportRecoveryCellV9,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

export interface RelationalClosingStateV9 {
  readonly exists: boolean;
  readonly am: readonly [number | null, number | null, number | null];
  readonly rec: readonly [number | null, number | null, number | null];
  readonly ncMask: number;
  readonly rrMask: number;
  readonly u: number | null;
}

export interface RelationalClosingPatchV9 {
  readonly am?: readonly [GradebookImportCellV9?, GradebookImportCellV9?, GradebookImportCellV9?];
  readonly rec?: readonly [
    GradebookImportRecoveryCellV9,
    GradebookImportRecoveryCellV9,
    GradebookImportRecoveryCellV9,
  ];
  readonly u?: GradebookImportCellV9;
}

interface RelationalClosingChangeV9 {
  readonly campo: number;
  readonly oldValue: number | null;
  readonly newValue: number | null;
  readonly oldState: number;
  readonly newState: number;
}

interface RelationalClosingUpdateV9 {
  readonly next: RelationalClosingStateV9;
  readonly changes: readonly RelationalClosingChangeV9[];
  readonly empty: boolean;
}

type MutableClosingStateV9 = {
  am: [number | null, number | null, number | null];
  rec: [number | null, number | null, number | null];
  ncMask: number;
  rrMask: number;
  u: number | null;
};

const CLOSING_TERM_INDEXES_V9 = [0, 1, 2] as const;

function isUnavailable(
  value: GradebookImportCellV9 | GradebookImportRecoveryCellV9,
): value is readonly ['u'] {
  return Array.isArray(value) && value[0] === 'u';
}

function isNc(value: GradebookImportRecoveryCellV9): value is readonly ['n'] {
  return Array.isArray(value) && value[0] === 'n';
}

function isRr(value: GradebookImportRecoveryCellV9): value is readonly ['r'] {
  return Array.isArray(value) && value[0] === 'r';
}

function valueStateV9(value: number | null): number {
  return value === null ? 0 : 1;
}

function mutableClosingStateV9(current: RelationalClosingStateV9): MutableClosingStateV9 {
  return {
    am: [...current.am],
    rec: [...current.rec],
    ncMask: current.ncMask,
    rrMask: current.rrMask,
    u: current.u,
  };
}

function appendClosingChangeV9(
  changes: RelationalClosingChangeV9[],
  campo: number,
  oldValue: number | null,
  newValue: number | null,
  oldState: number,
  newState: number,
): void {
  changes.push({ campo, oldValue, newValue, oldState, newState });
}

function applyAmPatchV9(
  next: MutableClosingStateV9,
  patch: RelationalClosingPatchV9,
  changes: RelationalClosingChangeV9[],
): void {
  for (const index of CLOSING_TERM_INDEXES_V9) {
    const target = patch.am?.[index];
    if (target === undefined || isUnavailable(target)) continue;
    const oldValue = next.am[index];
    const newValue = target ?? null;
    if (oldValue === newValue) continue;
    appendClosingChangeV9(
      changes,
      index + 1,
      oldValue,
      newValue,
      valueStateV9(oldValue),
      valueStateV9(newValue),
    );
    next.am[index] = newValue;
  }
}

function recoveryStateV9(value: number | null, nc: boolean, rr: boolean): number {
  if (rr) return 3;
  if (nc) return 2;
  return valueStateV9(value);
}

function applyRecoveryTargetV9(
  next: MutableClosingStateV9,
  index: (typeof CLOSING_TERM_INDEXES_V9)[number],
  target: Exclude<GradebookImportRecoveryCellV9, readonly ['u']>,
  changes: RelationalClosingChangeV9[],
): void {
  const bit = 1 << index;
  const oldNc = (next.ncMask & bit) !== 0;
  const oldRr = (next.rrMask & bit) !== 0;
  const oldValue = next.rec[index];
  const oldState = recoveryStateV9(oldValue, oldNc, oldRr);

  let newState: number;
  let newValue: number | null;
  if (isNc(target)) {
    newState = 2;
    newValue = null;
    next.ncMask |= bit;
    next.rrMask &= ~bit;
  } else if (isRr(target)) {
    newState = 3;
    newValue = null;
    next.rrMask |= bit;
    next.ncMask &= ~bit;
  } else {
    newValue = target ?? null;
    newState = valueStateV9(newValue);
    next.ncMask &= ~bit;
    next.rrMask &= ~bit;
  }

  if (oldState === newState && oldValue === newValue) return;
  appendClosingChangeV9(changes, index + 4, oldValue, newValue, oldState, newState);
  next.rec[index] = newValue;
}

function applyRecoveryPatchV9(
  next: MutableClosingStateV9,
  patch: RelationalClosingPatchV9,
  changes: RelationalClosingChangeV9[],
): void {
  if (!patch.rec) return;
  for (const index of CLOSING_TERM_INDEXES_V9) {
    const target = patch.rec[index];
    if (isUnavailable(target)) continue;
    applyRecoveryTargetV9(next, index, target, changes);
  }
}

function applyAnnualPatchV9(
  next: MutableClosingStateV9,
  patch: RelationalClosingPatchV9,
  changes: RelationalClosingChangeV9[],
): void {
  const target = patch.u;
  if (target === undefined || isUnavailable(target)) return;
  const oldValue = next.u;
  const newValue = target ?? null;
  if (oldValue === newValue) return;
  appendClosingChangeV9(
    changes,
    7,
    oldValue,
    newValue,
    valueStateV9(oldValue),
    valueStateV9(newValue),
  );
  next.u = newValue;
}

function closingIsEmptyV9(next: MutableClosingStateV9): boolean {
  return (
    next.am.every((value) => value === null) &&
    next.rec.every((value) => value === null) &&
    next.ncMask === 0 &&
    next.rrMask === 0 &&
    next.u === null
  );
}

export function resolveRelationalClosingUpdateV9(
  current: RelationalClosingStateV9,
  patch: RelationalClosingPatchV9,
): RelationalClosingUpdateV9 {
  const mutable = mutableClosingStateV9(current);
  const changes: RelationalClosingChangeV9[] = [];

  applyAmPatchV9(mutable, patch, changes);
  applyRecoveryPatchV9(mutable, patch, changes);
  applyAnnualPatchV9(mutable, patch, changes);

  const next: RelationalClosingStateV9 = {
    exists: current.exists,
    ...mutable,
  };
  return { next, changes, empty: closingIsEmptyV9(mutable) };
}
