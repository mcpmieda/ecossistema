import type { SourceCellRawValueV1 } from '../source/source-contract-v1';
import {
  SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2,
  SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2,
  type SourceQualitativeActivitySlotV2,
  type SourceQuantitativeAssessmentSlotV2,
} from '../source/source-contract-v2';
import {
  GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V5,
  GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V5,
  GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V5,
  GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V5,
  GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V5,
  isGradebookImportPersistenceResponseV5,
  type GradebookImportPersistenceRequestV5,
  type GradebookImportPersistenceResponseV5,
} from './import-persistence-transport-v5';

/**
 * V6 keeps workbook interpretation local while removing repeated rosters and explicit empty-cell
 * envelopes from the wire. Browser input remains untrusted source observation: catalog identity,
 * CAS, authority, official-result materialization and the persistence plan stay server-owned.
 */
export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V6 = 6 as const;
export const GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V6 = GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V5;
export const GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V6 = GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V5;
export const GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V6 =
  GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V5;
export const GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V6 = [
  ...GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V5,
  'incompatible-reference',
] as const;

export const GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6 = {
  ...GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V5,
  maxRostersPerRequest: 128,
  maxCoursesPerRequest: 128,
  /** K5:K50 inclusive. */
  maxRosterStudentsPerClass: 46,
  maxCompactCellsPerTermRow: 17,
  maxCompactCellsPerRecoveryRow: 11,
  maxRosterStatusLength: 128,
} as const;

export type GradebookImportPersistenceRequestRejectionV6 =
  (typeof GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V6)[number];
export type GradebookImportPersistenceRequestInspectionV6 =
  | 'ready'
  | GradebookImportPersistenceRequestRejectionV6;

/** Omitted property means an expected source cell is empty/absent. */
export type GradebookImportCompactFormulaCellV6 =
  | readonly ['f', rawValue: SourceCellRawValueV1, cachedValue: number | null, formula: string]
  | readonly [
      'f',
      rawValue: SourceCellRawValueV1,
      cachedValue: number | null,
      formula: string,
      sourceError: string,
    ];

/**
 * Primitive cells preserve the observed scalar. Thus 0.1 remains the official-zero marker and 0
 * remains the historical manual zero. Formula cells retain raw/cache/formula independently.
 */
export type GradebookImportCompactCellV6 =
  | number
  | string
  | boolean
  | GradebookImportCompactFormulaCellV6;

export type GradebookImportRosterStudentV6 =
  | readonly [position: number, label: string]
  | readonly [position: number, label: string, status: string];

export interface GradebookImportRosterV6 {
  readonly classGroupLabel: string;
  /** Relation K5:K50, contiguous until the first empty/0/null K cell. */
  readonly students: readonly GradebookImportRosterStudentV6[];
}

export type GradebookImportAssessmentDefinitionV6 =
  | readonly [sourceSlot: SourceQuantitativeAssessmentSlotV2, maximum: number]
  | readonly [
      sourceSlot: SourceQualitativeActivitySlotV2,
      maximum: number | null,
      name: string | null,
    ];

export const GRADEBOOK_IMPORT_TERM_CELL_KEYS_V6 = [
  'R',
  'S',
  'T',
  'Z',
  ...SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.map((slot) => slot.sourceSlot),
  'AK',
  'AM',
  'AN',
] as const;
export type GradebookImportTermCellKeyV6 = (typeof GRADEBOOK_IMPORT_TERM_CELL_KEYS_V6)[number];

export const GRADEBOOK_IMPORT_RECOVERY_CELL_KEYS_V6 = [
  'R',
  'S',
  'T',
  'U',
  'X',
  'Y',
  'AA',
  'AB',
  'AC',
  'AD',
  'AE',
] as const;
export type GradebookImportRecoveryCellKeyV6 =
  (typeof GRADEBOOK_IMPORT_RECOVERY_CELL_KEYS_V6)[number];

export type GradebookImportTermCellsV6 = Readonly<
  Partial<Record<GradebookImportTermCellKeyV6, GradebookImportCompactCellV6>>
>;
export type GradebookImportRecoveryCellsV6 = Readonly<
  Partial<Record<GradebookImportRecoveryCellKeyV6, GradebookImportCompactCellV6>>
>;

/** Term source row is derived as roster position + 4. */
export type GradebookImportTermRowV6 = readonly [
  rosterPosition: number,
  cells: GradebookImportTermCellsV6,
];

/** REC is a dynamic visual subset, therefore its physical source row is retained for provenance. */
export type GradebookImportRecoveryRowV6 = readonly [
  rosterPosition: number,
  sourceRow: number,
  cells: GradebookImportRecoveryCellsV6,
];

export interface GradebookImportTermV6 {
  readonly term: 1 | 2 | 3;
  readonly sourceSheetName: string;
  readonly assessmentDefinitions: readonly GradebookImportAssessmentDefinitionV6[];
  readonly rows: readonly GradebookImportTermRowV6[];
}

export interface GradebookImportRecoveryV6 {
  readonly sourceSheetName: string;
  readonly rows: readonly GradebookImportRecoveryRowV6[];
}

export interface GradebookImportCourseV6 {
  readonly classGroupLabel: string;
  readonly subjectLabel: string;
  readonly disciplineIndex: `D${number}`;
  readonly terms: readonly [GradebookImportTermV6, GradebookImportTermV6, GradebookImportTermV6];
  readonly recovery: GradebookImportRecoveryV6 | null;
}

export interface GradebookImportPersistenceRequestV6
  extends Omit<GradebookImportPersistenceRequestV5, 'transportVersion' | 'sheets' | 'diagnostics'> {
  readonly transportVersion: typeof GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V6;
  readonly rosters: readonly GradebookImportRosterV6[];
  readonly courses: readonly GradebookImportCourseV6[];
  readonly diagnostics: readonly [];
}

export type GradebookImportPersistenceResponseV6 =
  GradebookImportPersistenceResponseV5 extends infer Response
    ? Response extends { readonly transportVersion: 5 }
      ? Omit<Response, 'transportVersion'> & {
          readonly transportVersion: typeof GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V6;
        }
      : never
    : never;

const QUANTITATIVE_SLOTS = new Set<string>(
  SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2.map((slot) => slot.sourceSlot),
);
const QUALITATIVE_SLOTS = new Set<string>(
  SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.map((slot) => slot.sourceSlot),
);
const TERM_CELL_KEYS = new Set<string>(GRADEBOOK_IMPORT_TERM_CELL_KEYS_V6);
const RECOVERY_CELL_KEYS = new Set<string>(GRADEBOOK_IMPORT_RECOVERY_CELL_KEYS_V6);
const FORBIDDEN_FIELDS = new Set<string>(GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V6);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toUpperCase();
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function containsForbiddenField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenField);
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key) || containsForbiddenField(nested)) return true;
  }
  return false;
}

function validManifest(value: unknown): value is GradebookImportPersistenceRequestV5['manifest'] {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'fileName',
      'extension',
      'reportedMimeType',
      'sizeBytes',
      'lastModifiedAt',
      'sha256',
      'sourceContractVersion',
      'parserVersion',
      'readAt',
    ])
  ) {
    return false;
  }
  return (
    boundedText(value.fileName, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxFileNameLength) &&
    ['xlsb', 'xlsx', 'xls'].includes(String(value.extension)) &&
    (value.reportedMimeType === null ||
      (typeof value.reportedMimeType === 'string' &&
        value.reportedMimeType.length <= GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxMimeTypeLength)) &&
    Number.isSafeInteger(value.sizeBytes) &&
    Number(value.sizeBytes) >= 0 &&
    (value.lastModifiedAt === null || typeof value.lastModifiedAt === 'string') &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    value.sourceContractVersion === 2 &&
    boundedText(value.parserVersion, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxParserVersionLength) &&
    typeof value.readAt === 'string'
  );
}

function validRawValue(value: unknown): value is SourceCellRawValueV1 {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function validCompactCell(value: unknown): value is GradebookImportCompactCellV6 {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string') {
    return value.length > 0 && value.length <= GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxSuggestionLength;
  }
  if (!Array.isArray(value) || (value.length !== 4 && value.length !== 5)) return false;
  if (value[0] !== 'f' || !validRawValue(value[1])) return false;
  if (value[2] !== null && (typeof value[2] !== 'number' || !Number.isFinite(value[2]))) return false;
  if (!boundedText(value[3], GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxFormulaLength)) return false;
  return (
    value.length === 4 ||
    boundedText(value[4], GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxSuggestionLength)
  );
}

/** The roster's positions (1, 2, … in order), each with a distinct name and an optional status. */
function rosterPositionsV6(
  students: readonly unknown[],
): ReadonlySet<number> | 'invalid-request' | 'duplicate-identity' {
  const positions = new Set<number>();
  const names = new Set<string>();
  for (const [index, student] of students.entries()) {
    if (!Array.isArray(student) || (student.length !== 2 && student.length !== 3)) {
      return 'invalid-request';
    }
    const expectedPosition = index + 1;
    if (
      student[0] !== expectedPosition ||
      !boundedText(student[1], GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxSuggestionLength) ||
      (student.length === 3 &&
        !boundedText(student[2], GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxRosterStatusLength))
    ) {
      return 'invalid-request';
    }
    const name = canonicalText(student[1]);
    if (names.has(name)) return 'duplicate-identity';
    names.add(name);
    positions.add(expectedPosition);
  }
  return positions;
}

/** The term's assessment slots, each valid and declared once. */
function definitionSlotsV6(
  definitions: readonly unknown[],
): Set<string> | 'invalid-academic-shape' | 'duplicate-identity' {
  const definitionSlots = new Set<string>();
  for (const definition of definitions) {
    if (!validAssessmentDefinition(definition)) return 'invalid-academic-shape';
    if (definitionSlots.has(definition[0])) return 'duplicate-identity';
    definitionSlots.add(definition[0]);
  }
  return definitionSlots;
}

/** One term row: a roster position seen once, valid cells, qualitative cells only for declared
 * slots (recorded as observed), and AN only in the third term. */
function inspectTermRowV6(
  row: unknown,
  term: unknown,
  seen: {
    rosterPositions: ReadonlySet<number>;
    definitionSlots: ReadonlySet<string>;
    rowPositions: Set<number>;
    observedQualitative: Set<string>;
  },
): GradebookImportPersistenceRequestRejectionV6 | null {
  if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0])) {
    return 'invalid-academic-shape';
  }
  const position = Number(row[0]);
  if (!seen.rosterPositions.has(position)) return 'incompatible-reference';
  if (seen.rowPositions.has(position)) return 'duplicate-identity';
  seen.rowPositions.add(position);
  const cells = row[1];
  const cellIssue = inspectCells(
    cells,
    TERM_CELL_KEYS,
    GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxCompactCellsPerTermRow,
  );
  if (cellIssue) return cellIssue;
  for (const key of Object.keys(cells as Record<string, unknown>)) {
    if (!QUALITATIVE_SLOTS.has(key)) continue;
    if (!seen.definitionSlots.has(key)) return 'invalid-academic-shape';
    seen.observedQualitative.add(key);
  }
  if (term !== 3 && Object.hasOwn(cells as Record<string, unknown>, 'AN')) {
    return 'invalid-academic-shape';
  }
  return null;
}

/** A sheet name not used before in the file. */
function claimSheetNameV6(sheetName: unknown, sheetNames: Set<string>) {
  if (typeof sheetName !== 'string' || sheetNames.has(sheetName)) return false;
  sheetNames.add(sheetName);
  return true;
}

/** The course's three terms in order and its recovery, each from a sheet of its own. */
function inspectCourseSheetsV6(
  terms: readonly unknown[],
  recovery: unknown,
  rosterPositions: ReadonlySet<number>,
  sheetNames: Set<string>,
): GradebookImportPersistenceRequestRejectionV6 | null {
  for (let index = 0; index < 3; index += 1) {
    const term = terms[index];
    if (!isRecord(term) || term.term !== index + 1) return 'invalid-academic-shape';
    const issue = inspectTerm(term, rosterPositions);
    if (issue) return issue;
    if (!claimSheetNameV6(term.sourceSheetName, sheetNames)) return 'duplicate-identity';
  }

  const recoveryIssue = inspectRecovery(recovery, rosterPositions);
  if (recoveryIssue) return recoveryIssue;
  if (isRecord(recovery) && !claimSheetNameV6(recovery.sourceSheetName, sheetNames))
    return 'duplicate-identity';
  return null;
}

function inspectRosters(value: unknown):
  | { readonly status: 'ready'; readonly positionsByClass: ReadonlyMap<string, ReadonlySet<number>> }
  | { readonly status: GradebookImportPersistenceRequestRejectionV6 } {
  if (!Array.isArray(value) || value.length === 0) return { status: 'invalid-request' };
  if (value.length > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxRostersPerRequest) {
    return { status: 'payload-too-large' };
  }
  const positionsByClass = new Map<string, ReadonlySet<number>>();
  let totalStudents = 0;
  for (const roster of value) {
    if (
      !isRecord(roster) ||
      !exactKeys(roster, ['classGroupLabel', 'students']) ||
      !boundedText(roster.classGroupLabel, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxSuggestionLength) ||
      !Array.isArray(roster.students) ||
      roster.students.length === 0
    ) {
      return { status: 'invalid-request' };
    }
    if (roster.students.length > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxRosterStudentsPerClass) {
      return { status: 'payload-too-large' };
    }
    const classKey = canonicalText(roster.classGroupLabel);
    if (positionsByClass.has(classKey)) return { status: 'duplicate-identity' };
    const positions = rosterPositionsV6(roster.students);
    if (typeof positions === 'string') return { status: positions };
    totalStudents += roster.students.length;
    if (totalStudents > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxStudentObservationsPerRequest) {
      return { status: 'payload-too-large' };
    }
    positionsByClass.set(classKey, positions);
  }
  return { status: 'ready', positionsByClass };
}

function validAssessmentDefinition(value: unknown): value is GradebookImportAssessmentDefinitionV6 {
  if (!Array.isArray(value)) return false;
  const slot = value[0];
  if (typeof slot !== 'string') return false;
  if (QUANTITATIVE_SLOTS.has(slot)) {
    return (
      value.length === 2 &&
      typeof value[1] === 'number' &&
      Number.isFinite(value[1]) &&
      value[1] > 0
    );
  }
  if (!QUALITATIVE_SLOTS.has(slot) || value.length !== 3) return false;
  const maximum = value[1];
  const name = value[2];
  return (
    (maximum === null ||
      (typeof maximum === 'number' && Number.isFinite(maximum) && maximum > 0)) &&
    (name === null || boundedText(name, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxSuggestionLength))
  );
}

function inspectCells(
  value: unknown,
  allowed: ReadonlySet<string>,
  maxCells: number,
): GradebookImportPersistenceRequestRejectionV6 | null {
  if (!isRecord(value)) return 'invalid-academic-shape';
  const entries = Object.entries(value);
  if (entries.length > maxCells) return 'payload-too-large';
  for (const [key, cell] of entries) {
    if (!allowed.has(key) || !validCompactCell(cell)) return 'invalid-academic-shape';
  }
  return null;
}

function inspectTerm(
  value: unknown,
  rosterPositions: ReadonlySet<number>,
): GradebookImportPersistenceRequestRejectionV6 | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['term', 'sourceSheetName', 'assessmentDefinitions', 'rows']) ||
    (value.term !== 1 && value.term !== 2 && value.term !== 3) ||
    !boundedText(value.sourceSheetName, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxSheetNameLength) ||
    !Array.isArray(value.assessmentDefinitions) ||
    !Array.isArray(value.rows)
  ) {
    return 'invalid-academic-shape';
  }
  if (
    value.assessmentDefinitions.length >
      GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxAssessmentDefinitionsPerTermSheet ||
    value.rows.length > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxRosterStudentsPerClass
  ) {
    return 'payload-too-large';
  }
  const definitionSlots = definitionSlotsV6(value.assessmentDefinitions);
  if (typeof definitionSlots === 'string') return definitionSlots;
  if (!definitionSlots.has('R') || !definitionSlots.has('S')) return 'invalid-academic-shape';

  const rowPositions = new Set<number>();
  const observedQualitative = new Set<string>();
  for (const row of value.rows) {
    const issue = inspectTermRowV6(row, value.term, {
      rosterPositions,
      definitionSlots,
      rowPositions,
      observedQualitative,
    });
    if (issue) return issue;
  }

  for (const definition of value.assessmentDefinitions) {
    if (!validAssessmentDefinition(definition) || definition.length !== 3) continue;
    if (definition[1] === null && definition[2] === null && !observedQualitative.has(definition[0])) {
      return 'invalid-academic-shape';
    }
  }
  return null;
}

function inspectRecovery(
  value: unknown,
  rosterPositions: ReadonlySet<number>,
): GradebookImportPersistenceRequestRejectionV6 | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !exactKeys(value, ['sourceSheetName', 'rows']) ||
    !boundedText(value.sourceSheetName, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxSheetNameLength) ||
    !Array.isArray(value.rows)
  ) {
    return 'invalid-academic-shape';
  }
  if (value.rows.length > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxRosterStudentsPerClass) {
    return 'payload-too-large';
  }
  const positions = new Set<number>();
  const sourceRows = new Set<number>();
  for (const row of value.rows) {
    if (
      !Array.isArray(row) ||
      row.length !== 3 ||
      !Number.isSafeInteger(row[0]) ||
      !Number.isSafeInteger(row[1])
    ) {
      return 'invalid-academic-shape';
    }
    const position = Number(row[0]);
    const sourceRow = Number(row[1]);
    if (!rosterPositions.has(position)) return 'incompatible-reference';
    if (sourceRow < 5 || sourceRow > 50) return 'invalid-academic-shape';
    if (positions.has(position) || sourceRows.has(sourceRow)) return 'duplicate-identity';
    positions.add(position);
    sourceRows.add(sourceRow);
    const cellIssue = inspectCells(
      row[2],
      RECOVERY_CELL_KEYS,
      GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxCompactCellsPerRecoveryRow,
    );
    if (cellIssue) return cellIssue;
  }
  return null;
}

function inspectCourses(
  value: unknown,
  positionsByClass: ReadonlyMap<string, ReadonlySet<number>>,
): GradebookImportPersistenceRequestRejectionV6 | null {
  if (!Array.isArray(value) || value.length === 0) return 'invalid-request';
  if (value.length > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxCoursesPerRequest) {
    return 'payload-too-large';
  }
  const courseKeys = new Set<string>();
  const sheetNames = new Set<string>();
  for (const course of value) {
    if (
      !isRecord(course) ||
      !exactKeys(course, [
        'classGroupLabel',
        'subjectLabel',
        'disciplineIndex',
        'terms',
        'recovery',
      ]) ||
      !boundedText(course.classGroupLabel, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxSuggestionLength) ||
      !boundedText(course.subjectLabel, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxSuggestionLength) ||
      typeof course.disciplineIndex !== 'string' ||
      !/^D[1-9]\d*$/u.test(course.disciplineIndex) ||
      !Array.isArray(course.terms) ||
      course.terms.length !== 3
    ) {
      return 'invalid-academic-shape';
    }
    const classKey = canonicalText(course.classGroupLabel);
    const rosterPositions = positionsByClass.get(classKey);
    if (!rosterPositions) return 'incompatible-reference';
    const courseKey = `${classKey}\u0000${canonicalText(course.subjectLabel)}\u0000${course.disciplineIndex}`;
    if (courseKeys.has(courseKey)) return 'duplicate-identity';
    courseKeys.add(courseKey);
    const issue = inspectCourseSheetsV6(course.terms, course.recovery, rosterPositions, sheetNames);
    if (issue) return issue;
  }
  return null;
}

export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_V6 = {
  version: GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V6,
  operation: GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V6,
  unit: 'one-recognized-source-file-per-request',
  bounds: GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6,
  security: GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V6,
  workbookProcessing: 'browser-local-compact-observation',
  roster: {
    sourceRows: 'K5:K50-until-first-empty-zero-null',
    statusColumn: 'G',
    declaredCurrentCount: 'J1-informational-only',
    reuse: 'once-per-class-per-file',
  },
  recovery: {
    roster: 'dynamic-subset-reference-only',
    identity: 'resolved-against-class-roster-before-transport',
    sourceRow: 'preserved-for-provenance',
  },
  trustBoundary: {
    browserInput: 'untrusted-compact-source-observations',
    serverOwned: ['catalog-identity', 'cas', 'authority', 'official-results', 'persistence-plan'],
    forbiddenClientFields: GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V6,
  },
} as const;

export function inspectGradebookImportPersistenceRequestV6(
  value: unknown,
): GradebookImportPersistenceRequestInspectionV6 {
  if (!isRecord(value)) return 'invalid-request';
  if (
    !exactKeys(value, [
      'transportVersion',
      'operation',
      'manifest',
      'recognizedSuggestions',
      'confirmedContext',
      'sourceResolution',
      'rosters',
      'courses',
      'diagnostics',
    ]) ||
    value.transportVersion !== GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V6 ||
    value.operation !== GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V6 ||
    containsForbiddenField(value) ||
    !validManifest(value.manifest)
  ) {
    return 'invalid-request';
  }
  if (
    !isRecord(value.recognizedSuggestions) ||
    !exactKeys(value.recognizedSuggestions, ['academicYear', 'teacherName']) ||
    !Number.isSafeInteger(value.recognizedSuggestions.academicYear) ||
    Number(value.recognizedSuggestions.academicYear) < 2000 ||
    Number(value.recognizedSuggestions.academicYear) > 9999 ||
    !boundedText(
      value.recognizedSuggestions.teacherName,
      GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxSuggestionLength,
    ) ||
    !isRecord(value.confirmedContext) ||
    !exactKeys(value.confirmedContext, ['academicYearId']) ||
    !boundedText(
      value.confirmedContext.academicYearId,
      GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V6.maxIdentifierLength,
    ) ||
    !isRecord(value.sourceResolution) ||
    !exactKeys(value.sourceResolution, ['mode']) ||
    value.sourceResolution.mode !== 'resolve-or-create' ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length !== 0
  ) {
    return 'invalid-request';
  }

  const rosters = inspectRosters(value.rosters);
  if (rosters.status !== 'ready') return rosters.status;
  return inspectCourses(value.courses, rosters.positionsByClass) ?? 'ready';
}

export function isGradebookImportPersistenceRequestV6(
  value: unknown,
): value is GradebookImportPersistenceRequestV6 {
  return inspectGradebookImportPersistenceRequestV6(value) === 'ready';
}

export function isGradebookImportPersistenceResponseV6(
  value: unknown,
): value is GradebookImportPersistenceResponseV6 {
  return (
    isRecord(value) &&
    value.transportVersion === GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V6 &&
    isGradebookImportPersistenceResponseV5({ ...value, transportVersion: 5 })
  );
}

export function asGradebookImportPersistenceResponseV6(
  value: GradebookImportPersistenceResponseV5,
): GradebookImportPersistenceResponseV6 {
  return { ...value, transportVersion: GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V6 };
}
