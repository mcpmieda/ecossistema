import type {
  GradebookImportCellV9,
  GradebookImportInstrumentV9,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

export interface RelationalInstrumentMetadataV9 {
  readonly maximo: number | null;
  readonly descricao: string | null;
}

type RelationalNoteMutationV9 =
  | { readonly kind: 'preserve' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'insert' | 'update'; readonly value: number | null };

function isUnavailableCellV9(value: GradebookImportCellV9): value is readonly ['u'] {
  return Array.isArray(value) && value[0] === 'u';
}

export function parseRelationalInstrumentKeyV9(
  key: string,
): { readonly term: number; readonly slot: number } {
  const [termText, slotText] = key.split(':');
  const term = Number(termText);
  const slot = Number(slotText);
  if (!Number.isInteger(term) || !Number.isInteger(slot))
    throw new Error('invalid-existing-instrument-key');
  return { term, slot };
}

export function shouldRetireQualitativeInstrumentV9(input: {
  readonly currentTerm: number;
  readonly currentSlot: number;
  readonly incomingTerm: number;
  readonly incomingSlots: ReadonlySet<GradebookImportInstrumentV9[0]>;
  readonly unavailableMaximum: ReadonlySet<GradebookImportInstrumentV9[0]>;
  readonly unavailableDescription: ReadonlySet<GradebookImportInstrumentV9[0]>;
  readonly unavailableValues: ReadonlySet<GradebookImportInstrumentV9[0]>;
}): boolean {
  if (
    input.currentTerm !== input.incomingTerm ||
    input.currentSlot < 11 ||
    input.currentSlot > 20
  )
    return false;
  const slot = input.currentSlot as GradebookImportInstrumentV9[0];
  return (
    !input.incomingSlots.has(slot) &&
    !input.unavailableMaximum.has(slot) &&
    !input.unavailableDescription.has(slot) &&
    !input.unavailableValues.has(slot)
  );
}

export function resolveRelationalInstrumentMetadataV9(input: {
  readonly current: RelationalInstrumentMetadataV9 | null;
  readonly sourceMaximum: number | null;
  readonly sourceDescription: string | undefined;
  readonly authoritativeDefinitions: boolean;
  readonly maximumUnavailable: boolean;
  readonly descriptionUnavailable: boolean;
}): RelationalInstrumentMetadataV9 {
  if (input.current === null) {
    return {
      maximo: input.maximumUnavailable ? null : input.sourceMaximum,
      descricao: input.descriptionUnavailable ? null : (input.sourceDescription ?? null),
    };
  }
  if (input.authoritativeDefinitions) {
    return {
      maximo: input.maximumUnavailable ? input.current.maximo : input.sourceMaximum,
      descricao: input.descriptionUnavailable
        ? input.current.descricao
        : (input.sourceDescription ?? null),
    };
  }
  return {
    maximo: input.sourceMaximum ?? input.current.maximo,
    descricao: input.sourceDescription ?? input.current.descricao,
  };
}

export function isRelationalInstrumentMeaningfulV9(input: {
  readonly sourceMaximum: number | null;
  readonly sourceDescription: string | undefined;
  readonly hasValue: boolean;
  readonly exists: boolean;
  readonly granularObservationVersion: 1 | undefined;
  readonly slot: GradebookImportInstrumentV9[0];
}): boolean {
  return (
    input.sourceMaximum !== null ||
    input.sourceDescription !== undefined ||
    input.hasValue ||
    input.exists ||
    (input.granularObservationVersion === 1 && input.slot === 3)
  );
}

function isNumericPlaceholderV9(slot: number, description: string | null): boolean {
  if (slot < 11) return false;
  return new RegExp(`^${slot - 10}([.,]0+)?$`, 'u').test(description?.trim() ?? '');
}

export function isRelationalInstrumentActiveV9(input: {
  readonly slot: GradebookImportInstrumentV9[0];
  readonly metadata: RelationalInstrumentMetadataV9;
  readonly hasValue: boolean;
  readonly observed: boolean;
}): boolean {
  return (
    input.slot < 11 ||
    input.metadata.maximo !== null ||
    input.hasValue ||
    (Boolean(input.metadata.descricao?.trim()) &&
      !isNumericPlaceholderV9(input.slot, input.metadata.descricao)) ||
    input.observed
  );
}

export function resolveRelationalNoteMutationV9(input: {
  readonly target: GradebookImportCellV9;
  readonly previous: number | null;
  readonly observed: boolean;
  readonly retainBlank: boolean;
}): RelationalNoteMutationV9 {
  if (isUnavailableCellV9(input.target)) return { kind: 'preserve' };
  const next = input.target ?? null;
  if (
    input.previous === next &&
    (next !== null || (input.retainBlank ? input.observed : !input.observed))
  )
    return { kind: 'preserve' };
  if (next === null && !input.retainBlank) return { kind: 'delete' };
  if (!input.observed) return { kind: 'insert', value: next };
  return { kind: 'update', value: next };
}
