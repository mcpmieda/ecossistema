import type { CompatibleSourceCellEvidenceV5 as SourceCellEvidenceV1 } from '../../../shared/gradebook-contracts/source/source-values-contract-v5';
type SourceCellClassificationV1 = SourceCellEvidenceV1['classification'];
import type {
  SourceCellProvenanceV1,
  SourceCellRawValueV1,
} from '../../../shared/gradebook-contracts/source/source-contract-v1';
import type { AcademicGradeValueV1 } from '../../../shared/gradebook-contracts/results/results-contract-v1';

export interface SourceCellInterpretationProfile {
  readonly maximumValue: number;
}

export type SourceCellInterpretationOccurrenceCode =
  | 'missing-source-field'
  | 'negative-source-value'
  | 'source-value-above-maximum'
  | 'formula-error-or-missing-cache'
  | 'invalid-source-text';

export interface SourceCellInterpretationOccurrence {
  readonly code: SourceCellInterpretationOccurrenceCode;
  readonly rule: 'source-cell-semantics-v1';
  readonly message: string;
  readonly recommendedAction: string;
  readonly provenance: SourceCellProvenanceV1;
}

export interface SourceCellInterpretation {
  readonly present: boolean;
  readonly sourceValue: SourceCellRawValueV1 | undefined;
  readonly semanticValue: AcademicGradeValueV1;
  readonly valid: boolean;
  readonly classification: SourceCellClassificationV1;
  readonly evidence: SourceCellEvidenceV1;
  readonly occurrences: readonly SourceCellInterpretationOccurrence[];
}

const RULE = 'source-cell-semantics-v1' as const;

function occurrence(
  evidence: SourceCellEvidenceV1,
  code: SourceCellInterpretationOccurrenceCode,
  message: string,
  recommendedAction: string,
): SourceCellInterpretationOccurrence {
  return {
    code,
    rule: RULE,
    message,
    recommendedAction,
    provenance: evidence.provenance,
  };
}

function result(
  evidence: SourceCellEvidenceV1,
  semanticValue: AcademicGradeValueV1,
  present: boolean,
  valid: boolean,
  occurrences: readonly SourceCellInterpretationOccurrence[] = [],
): SourceCellInterpretation {
  return {
    present,
    sourceValue: evidence.rawValue,
    semanticValue,
    valid,
    classification: evidence.classification,
    evidence,
    occurrences,
  };
}

function interpretNumericValue(
  evidence: SourceCellEvidenceV1,
  value: number,
  maximumValue: number,
): SourceCellInterpretation {
  if (value < 0) {
    return result(evidence, { state: 'numeric', value }, true, false, [
      occurrence(
        evidence,
        'negative-source-value',
        'The source grade is negative.',
        'Verify the source cell before using this grade.',
      ),
    ]);
  }

  if (value > maximumValue) {
    return result(evidence, { state: 'numeric', value }, true, false, [
      occurrence(
        evidence,
        'source-value-above-maximum',
        'The source grade exceeds the configured maximum.',
        'Verify the source cell and the configured maximum.',
      ),
    ]);
  }

  return result(evidence, { state: 'numeric', value }, true, true);
}

/**
 * Interprets one already-classified source cell without composing or rounding grades.
 */
export function interpretSourceCell(
  evidence: SourceCellEvidenceV1,
  profile: SourceCellInterpretationProfile,
): SourceCellInterpretation {
  if (!Number.isFinite(profile.maximumValue) || profile.maximumValue < 0) {
    throw new RangeError('maximumValue must be a finite, non-negative number');
  }

  switch (evidence.classification) {
    case 'snapshot-unavailable':
      return result(
        evidence,
        { state: 'insufficient-data', reason: 'snapshot-value-unavailable' },
        false,
        false,
        [
          occurrence(
            evidence,
            'formula-error-or-missing-cache',
            'The source has no valid saved value.',
            'Recalculate and save the original workbook before importing again.',
          ),
        ],
      );
    case 'snapshot-value': {
      const value = evidence.rawValue;
      if (value === null || value === '' || value === 0)
        return result(evidence, { state: 'absent' }, false, true);
      if (value === 0.1 /* NOSONAR: exact source marker */)
        return result(
          evidence,
          { state: 'official-zero', value: 0, sourceMarker: 0.1 },
          true,
          true,
        );
      if (typeof value === 'number')
        return interpretNumericValue(evidence, value, profile.maximumValue);
      return result(
        evidence,
        { state: 'insufficient-data', reason: 'invalid-source-text' },
        false,
        false,
        [
          occurrence(
            evidence,
            'invalid-source-text',
            'The saved value is not a grade.',
            'Correct the source value.',
          ),
        ],
      );
    }

    case 'missing-field':
      return result(
        evidence,
        { state: 'insufficient-data', reason: 'missing-source-field' },
        false,
        false,
        [
          occurrence(
            evidence,
            'missing-source-field',
            'The expected source field does not exist.',
            'Verify the source layout and field mapping.',
          ),
        ],
      );

    case 'not-applicable':
      return result(evidence, { state: 'not-applicable' }, false, true);

    case 'empty':
      return result(evidence, { state: 'absent' }, false, true);

    case 'manual-positive-number':
    case 'manual-negative-number':
      return interpretNumericValue(evidence, evidence.rawValue, profile.maximumValue);

    case 'manual-legacy-zero':
      return result(evidence, { state: 'legacy-zero', value: 0 }, true, true);

    case 'manual-official-zero-marker':
      return result(evidence, { state: 'official-zero', value: 0, sourceMarker: 0.1 }, true, true);

    case 'formula-nonzero':
      return interpretNumericValue(evidence, evidence.cachedValue, profile.maximumValue);

    case 'formula-zero':
      return result(evidence, { state: 'absent' }, false, true);

    case 'formula-error-or-missing-cache':
      return result(
        evidence,
        { state: 'insufficient-data', reason: 'formula-error-or-missing-cache' },
        false,
        false,
        [
          occurrence(
            evidence,
            'formula-error-or-missing-cache',
            'The source formula has an error or no cached value.',
            'Recalculate or correct the source workbook and import it again.',
          ),
        ],
      );

    case 'invalid-text':
      return result(
        evidence,
        { state: 'insufficient-data', reason: 'invalid-source-text' },
        false,
        false,
        [
          occurrence(
            evidence,
            'invalid-source-text',
            'The source cell contains text that is not a grade.',
            'Correct the source cell before using this grade.',
          ),
        ],
      );
  }
}
