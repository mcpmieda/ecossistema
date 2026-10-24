import type { GradebookImportPersistenceRequestV9, GradebookImportTermV9 } from '../imports/import-persistence-transport-v9';
import { scalarTextV1 } from '../../scalar-text-v1';
/** A printed column ordinal is not an activity. A maximum or any saved grade is evidence. */
export function isQualitativeColumnOrdinalV1(slot: number, description: unknown): boolean {
  if (slot < 11 || slot > 20) return false;
  if (description === undefined || description === null || description === '') return true;
  const value = scalarTextV1(description).trim();
  return value === '' || new RegExp(`^${slot - 10}([.,]0+)?$`, 'u').test(value);
}

export function meaningfulQualitativeDescriptionV1(
  slot: number,
  maximum: number | null,
  description: string | undefined,
  hasValue: boolean,
): string | undefined {
  return maximum === null && !hasValue && isQualitativeColumnOrdinalV1(slot, description)
    ? undefined : description;
}

function normalizeTerm(term: GradebookImportTermV9): GradebookImportTermV9 {
  return { ...term, instrumentos: term.instrumentos.map(([slot, maximum, raw], column) => {
    const hasValue = term.alunos.some(([, values]) => typeof values[column] === 'number' || Array.isArray(values[column]));
    const description = meaningfulQualitativeDescriptionV1(slot, maximum, raw, hasValue);
    return description === undefined ? [slot, maximum] : [slot, maximum, description];
  }) };
}

/** Keep every slot/value for delta clearing; normalize only meaningless metadata. */
export function normalizeTemplateDescriptionsV1(request: GradebookImportPersistenceRequestV9): GradebookImportPersistenceRequestV9 {
  if (request.operation !== 'persist-notas') return request;
  return { ...request, ofertas: request.ofertas.map((offer) => ({ ...offer,
    trimestres: [normalizeTerm(offer.trimestres[0]), normalizeTerm(offer.trimestres[1]), normalizeTerm(offer.trimestres[2])],
  })) };
}
