import type {
  GradebookImportOfferV9,
  GradebookImportTermV9,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { ImportInstrumentStateV11 } from '../../persistence/postgres/relational-import-read-set-v11';
import {
  isRelationalInstrumentMeaningfulV9,
  parseRelationalInstrumentKeyV9,
  resolveRelationalInstrumentMetadataV9,
  shouldRetireQualitativeInstrumentV9,
  type RelationalInstrumentMetadataV9,
} from './import-relational-instrument-decisions-v9';

interface InstrumentSourceV11 {
  readonly key: string;
  readonly ofertaId: number;
  readonly term: GradebookImportTermV9;
  readonly column: number;
  readonly hasValue: boolean;
  readonly metadata: RelationalInstrumentMetadataV9;
}
export type ImportInstrumentPlanEntryV11 =
  | (InstrumentSourceV11 & { readonly action: 'create' })
  | (InstrumentSourceV11 & { readonly action: 'update' | 'preserve'; readonly existingId: number });
export interface ImportInstrumentRetirementV11 {
  readonly key: string;
  readonly id: number;
  readonly ofertaId: number;
}
export interface ImportInstrumentPlanV11 {
  readonly entries: readonly ImportInstrumentPlanEntryV11[];
  readonly retirements: readonly ImportInstrumentRetirementV11[];
}

type PlanInputV11 = Parameters<typeof buildRelationalImportInstrumentPlanV11>[0];
type PlanTermV11 = GradebookImportOfferV9['trimestres'][number];
type PlanSlotSetV11 = ReadonlySet<NonNullable<PlanTermV11['unavailableMaximumSlots']>[number]>;

/** Qualitative instruments of this term that the file no longer has (definitions are authoritative). */
function termRetirementsV11(
  input: PlanInputV11,
  term: PlanTermV11,
  unavailable: {
    unavailableMaximum: PlanSlotSetV11;
    unavailableDescription: PlanSlotSetV11;
    unavailableValues: PlanSlotSetV11;
  },
) {
  const { unavailableMaximum, unavailableDescription, unavailableValues } = unavailable;
  const incomingSlots = new Set(term.instrumentos.map(([slot]) => slot));
  const out: ImportInstrumentRetirementV11[] = [];
  for (const [key, current] of input.instruments) {
    const parsed = parseRelationalInstrumentKeyV9(key);
    if (
      shouldRetireQualitativeInstrumentV9({
        currentTerm: parsed.term,
        currentSlot: parsed.slot,
        incomingTerm: term.trimestre,
        incomingSlots,
        unavailableMaximum,
        unavailableDescription,
        unavailableValues,
      })
    )
      out.push({ key, id: current.id, ofertaId: input.ofertaId });
  }
  return out;
}

/** The term's meaningful instruments: created, updated when their metadata changed, or preserved. */
function termEntriesV11(
  input: PlanInputV11,
  term: PlanTermV11,
  plannedKeys: Set<string>,
  definitions: {
    authoritativeDefinitions: boolean;
    unavailableMaximum: PlanSlotSetV11;
    unavailableDescription: PlanSlotSetV11;
  },
) {
  const { authoritativeDefinitions, unavailableMaximum, unavailableDescription } = definitions;
  const out: ImportInstrumentPlanEntryV11[] = [];
  for (const [column, [slot, sourceMaximum, sourceDescription]] of term.instrumentos.entries()) {
    const key = `${term.trimestre}:${slot}`;
    if (plannedKeys.has(key)) throw new Error('gradebook-import-instrument-plan-duplicate-key');
    plannedKeys.add(key);
    const current = input.instruments.get(key);
    const hasValue = term.alunos.some(([, values]) => typeof values[column] === 'number');
    if (
      !isRelationalInstrumentMeaningfulV9({
        sourceMaximum,
        sourceDescription,
        hasValue,
        exists: current !== undefined,
        granularObservationVersion: input.granularObservationVersion,
        slot,
      })
    )
      continue;
    const metadata = resolveRelationalInstrumentMetadataV9({
      current: current ?? null,
      sourceMaximum,
      sourceDescription,
      authoritativeDefinitions,
      maximumUnavailable: authoritativeDefinitions && unavailableMaximum.has(slot),
      descriptionUnavailable: authoritativeDefinitions && unavailableDescription.has(slot),
    });
    const source: InstrumentSourceV11 = {
      key,
      ofertaId: input.ofertaId,
      term,
      column,
      hasValue,
      metadata,
    };
    if (!current) out.push({ ...source, action: 'create' });
    else
      out.push({
        ...source,
        existingId: current.id,
        action:
          metadata.maximo !== current.maximo || metadata.descricao !== current.descricao
            ? 'update'
            : 'preserve',
      });
  }
  return out;
}

/** Only reorganizes V9's decisions; the request and original observation set stay unchanged. */
export function buildRelationalImportInstrumentPlanV11(input: {
  readonly ofertaId: number;
  readonly offer: GradebookImportOfferV9;
  readonly granularObservationVersion: 1 | undefined;
  readonly instruments: ReadonlyMap<string, ImportInstrumentStateV11>;
}): ImportInstrumentPlanV11 {
  const entries: ImportInstrumentPlanEntryV11[] = [];
  const retirements: ImportInstrumentRetirementV11[] = [];
  const plannedKeys = new Set<string>();
  for (const term of input.offer.trimestres) {
    const authoritativeDefinitions = term.definitionSnapshotVersion === 1;
    const unavailableMaximum = new Set(term.unavailableMaximumSlots ?? []);
    const unavailableDescription = new Set(term.unavailableDescriptionSlots ?? []);
    const unavailableValues = new Set(term.unavailableValueSlots ?? []);
    if (authoritativeDefinitions)
      retirements.push(
        ...termRetirementsV11(input, term, {
          unavailableMaximum,
          unavailableDescription,
          unavailableValues,
        }),
      );
    entries.push(
      ...termEntriesV11(input, term, plannedKeys, {
        authoritativeDefinitions,
        unavailableMaximum,
        unavailableDescription,
      }),
    );
  }
  return { entries, retirements };
}
