import type { SimplifiedTermOutcomeV1 } from './resolve-simplified-academic-engine-v1';

/** A display restriction only. It does not change Z replacement or annual REC. */
export function termRecoveryVisibilityV1(
  term: SimplifiedTermOutcomeV1 | null,
  finalRecoveryApplicable: boolean | null,
): { readonly showParallel: boolean; readonly showRecovery: boolean } {
  return {
    showParallel: term?.parallelApplicable === true,
    showRecovery: term !== null && finalRecoveryApplicable === true,
  };
}
