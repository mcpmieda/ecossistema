export type GradebookImportRecoveryApplicabilityObservationV3 =
  | { readonly classification: 'numeric'; readonly rawValue: number }
  | { readonly classification: 'empty'; readonly rawValue: null | '' }
  | { readonly classification: 'missing-field' }
  | { readonly classification: 'unrecognized'; readonly rawValue: string | boolean }
  | {
      readonly classification: 'formula';
      readonly rawValue: string | number | boolean | null;
      readonly formula: string;
      readonly cachedValue: number | null;
    };
