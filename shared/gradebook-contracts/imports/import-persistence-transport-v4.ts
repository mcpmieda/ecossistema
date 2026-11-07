import type { SourceCellRawValueV1 } from '../source/source-contract-v1';

export type GradebookImportResultCellObservationV4 =
  | { readonly classification: 'missing-field' }
  | { readonly classification: 'empty'; readonly rawValue: null | '' }
  | { readonly classification: 'manual-positive-number'; readonly rawValue: number }
  | { readonly classification: 'manual-negative-number'; readonly rawValue: number }
  | { readonly classification: 'manual-legacy-zero'; readonly rawValue: 0 }
  | { readonly classification: 'manual-official-zero-marker'; readonly rawValue: 0.1 }
  | {
      readonly classification: 'formula-nonzero';
      readonly rawValue: SourceCellRawValueV1;
      readonly formula: string;
      readonly cachedValue: number;
    }
  | {
      readonly classification: 'formula-zero';
      readonly rawValue: SourceCellRawValueV1;
      readonly formula: string;
      readonly cachedValue: 0;
    }
  | {
      readonly classification: 'formula-error-or-missing-cache';
      readonly rawValue: SourceCellRawValueV1;
      readonly formula: string;
      readonly cachedValue: null;
      readonly sourceError: string | null;
    }
  | { readonly classification: 'invalid-text'; readonly rawValue: string };

export interface GradebookImportTermResultObservationsV4 {
  readonly quantitativeTotal: GradebookImportResultCellObservationV4;
  readonly parallelAssessment: GradebookImportResultCellObservationV4;
  readonly qualitativeTotal: GradebookImportResultCellObservationV4;
  readonly officialTermGrade: GradebookImportResultCellObservationV4;
  readonly annualAccumulatedTotal: GradebookImportResultCellObservationV4;
}
