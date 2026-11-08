const FRONTEND_DIAGNOSTIC_VERSION_V1 = 1 as const;
export const FRONTEND_DIAGNOSTIC_BODY_BYTES_V1 = 1_024;
export const FRONTEND_DIAGNOSTIC_ROUTE_V1 = '/api/observability/frontend-diagnostic';

const FRONTEND_DIAGNOSTIC_AREAS_V1 = [
  'gradebook',
  'student-portal',
  'platform',
] as const;

export const FRONTEND_DIAGNOSTIC_CATEGORIES_V1 = [
  'module-load',
  'render',
  'read',
] as const;

type FrontendDiagnosticAreaV1 = (typeof FRONTEND_DIAGNOSTIC_AREAS_V1)[number];
export type FrontendDiagnosticCategoryV1 =
  (typeof FRONTEND_DIAGNOSTIC_CATEGORIES_V1)[number];

interface FrontendDiagnosticSubmissionV1 {
  readonly version: 1;
  readonly area: FrontendDiagnosticAreaV1;
  readonly category: FrontendDiagnosticCategoryV1;
  /** Published application version/SHA label only. No URL or route. */
  readonly release: string;
  /** Opaque UUID only. Never encode user, academic or request data here. */
  readonly correlationId: string;
}

const EXACT_KEYS_V1 = ['version', 'area', 'category', 'release', 'correlationId'] as const;
const RELEASE_V1 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const UUID_V1 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function exactObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === EXACT_KEYS_V1.length &&
    EXACT_KEYS_V1.every((key) => Object.hasOwn(value, key))
  );
}

export function inspectFrontendDiagnosticSubmissionV1(
  value: unknown,
): value is FrontendDiagnosticSubmissionV1 {
  if (!exactObject(value)) return false;
  return (
    value.version === FRONTEND_DIAGNOSTIC_VERSION_V1 &&
    member(value.area, FRONTEND_DIAGNOSTIC_AREAS_V1) &&
    member(value.category, FRONTEND_DIAGNOSTIC_CATEGORIES_V1) &&
    typeof value.release === 'string' &&
    RELEASE_V1.test(value.release) &&
    typeof value.correlationId === 'string' &&
    UUID_V1.test(value.correlationId)
  );
}
