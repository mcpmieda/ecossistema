import type {
  SourceCellEvidenceV1,
  SourceCellProvenanceV1,
  SourceCellRawValueV1,
} from './source-contract-v1';
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
