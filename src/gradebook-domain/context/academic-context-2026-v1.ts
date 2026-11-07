import type { AcademicYearV1 } from '../../../shared/gradebook-contracts/entities';
import { NATIVE_ANNUAL_OUTCOME_PROFILE_2026_V1, type NativeAnnualOutcomeProfileV1 } from '../calculations/annual-result/resolve-native-annual-outcome';
import { NATIVE_FINAL_RECOVERY_PROFILE_2026_V1, type NativeFinalRecoveryProfileV1 } from '../calculations/final-recovery/resolve-native-final-recovery';
import { NATIVE_PARALLEL_RECOVERY_PROFILE_2026_V1, type NativeParallelRecoveryProfileV1 } from '../calculations/parallel-recovery/resolve-native-parallel-recovery';
import { NATIVE_TERM_OUTCOME_PROFILE_2026_V1, type NativeTermOutcomeProfileV1 } from '../calculations/term-result/compose-native-term-outcome';
import { NATIVE_TERM_COMPOSITION_PROFILE_2026_V1, type NativeTermCompositionProfileV1 } from '../calculations/term/compose-native-term-result';
import type { AcademicPersistenceContextV1 } from '../ports/persistence/persistence-ports-v1';

export const ACADEMIC_CONTEXT_2026_IDENTITY_V1 = Object.freeze({
  academicYear: 2026,
  evaluationProfileId: 'evaluation-profile:2026',
  configurationId: 'academic-year-configuration:2026',
  configurationVersion: 1,
} as const);

export type AcademicContextErrorCodeV1 =
  | 'context-missing'
  | 'context-duplicate'
  | 'context-inactive'
  | 'context-incompatible';

const ACADEMIC_CONTEXT_ERROR_MESSAGES_V1: Record<AcademicContextErrorCodeV1, string> = {
  'context-missing': 'O contexto acadêmico configurado não foi encontrado.',
  'context-duplicate': 'Mais de um contexto acadêmico foi encontrado para a configuração solicitada.',
  'context-inactive': 'O contexto acadêmico configurado não está ativo.',
  'context-incompatible': 'O contexto acadêmico configurado é incompatível com o perfil acadêmico 2026 V1.',
};

export class AcademicContextErrorV1 extends Error {
  readonly code: AcademicContextErrorCodeV1;

  constructor(code: AcademicContextErrorCodeV1) {
    super(ACADEMIC_CONTEXT_ERROR_MESSAGES_V1[code]);
    this.name = 'AcademicContextErrorV1';
    this.code = code;
  }
}

interface NativeAcademicProfiles2026V1 {
  readonly termComposition: NativeTermCompositionProfileV1;
  readonly parallelRecovery: NativeParallelRecoveryProfileV1;
  readonly termOutcome: NativeTermOutcomeProfileV1;
  readonly finalRecovery: NativeFinalRecoveryProfileV1;
  readonly annualOutcome: NativeAnnualOutcomeProfileV1;
}

export interface AcademicEvaluationProfile2026V1 {
  readonly id: 'evaluation-profile:2026';
  readonly version: 1;
  readonly academicYear: 2026;
  readonly nativeProfiles: NativeAcademicProfiles2026V1;
}

const NATIVE_ACADEMIC_PROFILES_2026_V1: NativeAcademicProfiles2026V1 = Object.freeze({
  termComposition: NATIVE_TERM_COMPOSITION_PROFILE_2026_V1,
  parallelRecovery: NATIVE_PARALLEL_RECOVERY_PROFILE_2026_V1,
  termOutcome: NATIVE_TERM_OUTCOME_PROFILE_2026_V1,
  finalRecovery: NATIVE_FINAL_RECOVERY_PROFILE_2026_V1,
  annualOutcome: NATIVE_ANNUAL_OUTCOME_PROFILE_2026_V1,
});

export const ACADEMIC_EVALUATION_PROFILE_2026_V1: AcademicEvaluationProfile2026V1 = Object.freeze({
  id: ACADEMIC_CONTEXT_2026_IDENTITY_V1.evaluationProfileId,
  version: NATIVE_TERM_COMPOSITION_PROFILE_2026_V1.version,
  academicYear: NATIVE_TERM_COMPOSITION_PROFILE_2026_V1.academicYear,
  nativeProfiles: NATIVE_ACADEMIC_PROFILES_2026_V1,
});

export type ActiveAcademicYear2026V1 = AcademicYearV1 & {
  readonly year: 2026;
  readonly status: 'active';
  readonly activeEvaluationProfileId: 'evaluation-profile:2026';
  readonly configurationVersion: '1';
};

export interface AcademicContext2026V1 {
  readonly version: 1;
  readonly academicYear: ActiveAcademicYear2026V1;
  readonly persistenceContext: AcademicPersistenceContextV1;
  readonly evaluationProfile: AcademicEvaluationProfile2026V1;
  readonly authorityMode: 'imported-source';
}

function incompatible(): never {
  throw new AcademicContextErrorV1('context-incompatible');
}

function validateNativeProfileCompositionV1(): void {
  const profiles = ACADEMIC_EVALUATION_PROFILE_2026_V1.nativeProfiles;
  const referenceYear = profiles.termComposition.academicYear;
  const referenceVersion = profiles.termComposition.version;

  if (
    ACADEMIC_EVALUATION_PROFILE_2026_V1.academicYear !== referenceYear ||
    ACADEMIC_EVALUATION_PROFILE_2026_V1.version !== referenceVersion ||
    profiles.parallelRecovery.academicYear !== referenceYear ||
    profiles.parallelRecovery.version !== referenceVersion ||
    profiles.termOutcome.academicYear !== referenceYear ||
    profiles.termOutcome.version !== referenceVersion ||
    profiles.finalRecovery.academicYear !== referenceYear ||
    profiles.finalRecovery.version !== referenceVersion ||
    profiles.annualOutcome.academicYear !== referenceYear ||
    profiles.annualOutcome.version !== referenceVersion ||
    profiles.parallelRecovery.termCompositionProfile !== profiles.termComposition ||
    profiles.termOutcome.parallelRecoveryProfile !== profiles.parallelRecovery ||
    profiles.termOutcome.termCompositionProfile !== profiles.termComposition ||
    profiles.finalRecovery.termCompositionProfile !== profiles.termComposition
  ) {
    incompatible();
  }
}

export function createAcademicContext2026V1(academicYear: AcademicYearV1): AcademicContext2026V1 {
  validateNativeProfileCompositionV1();

  if (academicYear.status !== 'active') {
    throw new AcademicContextErrorV1('context-inactive');
  }

  if (
    academicYear.year !== ACADEMIC_CONTEXT_2026_IDENTITY_V1.academicYear ||
    academicYear.activeEvaluationProfileId !== ACADEMIC_CONTEXT_2026_IDENTITY_V1.evaluationProfileId ||
    academicYear.configurationVersion !== String(ACADEMIC_CONTEXT_2026_IDENTITY_V1.configurationVersion)
  ) {
    incompatible();
  }

  const activeAcademicYear = Object.freeze({ ...academicYear }) as ActiveAcademicYear2026V1;
  const persistenceContext = Object.freeze({
    academicYearId: activeAcademicYear.id,
  }) satisfies AcademicPersistenceContextV1;

  return Object.freeze({
    version: 1,
    academicYear: activeAcademicYear,
    persistenceContext,
    evaluationProfile: ACADEMIC_EVALUATION_PROFILE_2026_V1,
    authorityMode: 'imported-source',
  });
}
