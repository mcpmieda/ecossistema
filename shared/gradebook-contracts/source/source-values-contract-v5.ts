import type {
  SourceCellEvidenceV1,
  SourceCellProvenanceV1,
  SourceCellRawValueV1,
} from './source-contract-v1';

/** Prospective value-only source semantics authorized in #561. V1–V4 are unchanged. */
export const SOURCE_VALUES_POLICY_V5 = 'current-values-zero-empty-v1' as const;
export const SNAPSHOT_ASSESSMENT_RULE_V5 = 'source-values-v5-assessment-entry-v1' as const;
export type SnapshotSourceEvidenceV5 =
  | {
      readonly classification: 'snapshot-value';
      readonly rawValue: SourceCellRawValueV1;
      readonly provenance: SourceCellProvenanceV1;
    }
  | {
      readonly classification: 'snapshot-unavailable';
      readonly rawValue: null;
      readonly provenance: SourceCellProvenanceV1;
    };
export type CompatibleSourceCellEvidenceV5 = SourceCellEvidenceV1 | SnapshotSourceEvidenceV5;
/** Internal observation annotation; never accepted as an old V4/V5 HTTP client assertion. */
export type SnapshotObservationV5 = { readonly snapshotState: 'value' | 'unavailable' };
export const SNAPSHOT_UNAVAILABLE_INTERNAL_V5 = '\u0000gradebook-snapshot-unavailable-v1';

export function normalizeSnapshotScalarV5(value: SourceCellRawValueV1): SourceCellRawValueV1 {
  if (typeof value !== 'string') return value === 0 ? 0 : value;
  const text = value.trim();
  if (text === '') return null;
  // No locale-dependent rounding or thousands-separator guessing.
  if (/^[+-]?\d+(?:[.,]\d+)?$/u.test(text)) {
    const number = Number(text.replace(',', '.'));
    if (Number.isFinite(number)) return number;
  }
  return value;
}

export function isSnapshotSourceEvidenceV5(value: unknown): value is SnapshotSourceEvidenceV5 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !['classification', 'rawValue', 'provenance'].includes(key)))
    return false;
  const p = item.provenance;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const provenance = p as Record<string, unknown>;
  if (
    Object.keys(provenance).length !== 4 ||
    !['fileName', 'fileSha256', 'sheetName', 'cellAddress'].every(
      (key) => typeof provenance[key] === 'string' && (provenance[key] as string).length > 0,
    )
  )
    return false;
  if (
    !/^[a-f0-9]{64}$/iu.test(provenance.fileSha256 as string) ||
    !/^[A-Z]+[1-9]\d*$/iu.test(provenance.cellAddress as string)
  )
    return false;
  if (item.classification === 'snapshot-unavailable') return item.rawValue === null;
  return (
    item.classification === 'snapshot-value' &&
    (item.rawValue === null ||
      typeof item.rawValue === 'string' ||
      typeof item.rawValue === 'boolean' ||
      (typeof item.rawValue === 'number' && Number.isFinite(item.rawValue)))
  );
}
