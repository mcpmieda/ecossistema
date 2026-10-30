import type {
  FrequencyActorV2,
  FrequencyStudentReportNotesV2,
  FrequencyStudentReportV2,
} from '../../shared/attendance-contracts/frequency-v2';
import type {
  ReconciliationContextV1,
  ReconciliationRequestV1,
  ReconciliationResponseV1,
  ReportClassLinkV1,
  ReportRowV1,
} from '../../shared/student-identity/reconciliation-v1';
import {
  classifyReportClassV1,
  reportClassReferenceV1,
} from '../../shared/student-identity/reconciliation-normalization-v1';
import type { TrustedAdminContextV1 } from '../../shared/student-portal-contracts/ports-v1';
import type { RuntimeEnv } from '../env';
import type { GradebookPostgresDatabaseV1 } from '../gradebook/persistence/postgres/postgres-database-v1';
import {
  stageReconciliationCredentialsV1,
  type StagedCredentialsV1,
} from '../student-identity/reconciliation/http-v1';
import { StudentReconciliationServiceV1 } from '../student-identity/reconciliation/service-v1';
import {
  createFrequencyServiceV2,
  FrequencyErrorV2,
  StudentReportPendingV2,
  type StudentReportOutcomeV2,
  type StudentReportPreviousV2,
} from './service-v2';

/** Credentials prepared per request (four each); the Coletor sends the report again for the rest. */
const STAGE_CALLS_V2 = 20;
/** A Conciliação that changed under the report (another operator's decision) is read again. */
const ATTEMPTS_V2 = 3;

type Mutation = Pick<
  Extract<ReconciliationRequestV1, { operation: 'apply' }>,
  'contractVersion' | 'academicYear' | 'generation' | 'expectedRevision' | 'idempotencyKey'
>;
type Prepared = Extract<ReconciliationResponseV1, { state: 'ready'; batchId: string }>;
type Catalog = Extract<ReconciliationResponseV1, { state: 'ready'; operation: 'catalog' }>;
type Reconciliation = Pick<StudentReconciliationServiceV1, 'execute'>;
type Stage = (input: {
  batchId: string;
  generation: string;
  expectedRevision: number;
}) => Promise<StagedCredentialsV1>;

class RetryV2 extends Error {}

function mutationV2(context: ReconciliationContextV1): Mutation {
  return {
    contractVersion: 1,
    academicYear: 2026,
    generation: context.generation,
    expectedRevision: context.revision,
    idempotencyKey: crypto.randomUUID(),
  };
}
function emptyNotesV2(): FrequencyStudentReportNotesV2 {
  return { counts: null, differences: [], invalid: [] };
}
function retryOrFail(response: ReconciliationResponseV1, detail: string): never {
  if (response.state === 'conflict' || response.state === 'expired') throw new RetryV2();
  throw new FrequencyErrorV2('unavailable', 503, `student-report-${detail}-${response.state}`);
}

/** Each class of the report with the Relação class the Conciliação already links it to. */
function classLinksV2(rows: readonly ReportRowV1[], catalog: Catalog, notes: FrequencyStudentReportNotesV2) {
  const links = new Map<string, ReportClassLinkV1>();
  for (const row of rows) {
    const key = reportClassReferenceV1(row.classLabel, row.shift, row.stageLabel);
    if (links.has(key)) continue;
    const known = catalog.reportClasses.find(
      (item) =>
        reportClassReferenceV1(item.label, item.shift, item.stageLabel) === key && !item.reviewRequired,
    );
    links.set(key, {
      classLabel: row.classLabel,
      shift: row.shift,
      stageLabel: row.stageLabel,
      gradebookClassId: known?.classId ?? null,
      confirmRegular: false,
    });
    // A class the Conciliação never linked (or under review): its rows wait for the link.
    if (!known && catalog.context.relationAvailable)
      notes.differences.push(
        `Turma ${row.classLabel} sem ligação com a Relação: envie o relatório pelo botão Relatório e ligue a turma.`,
      );
  }
  return [...links.values()];
}

/** The year of the report's regular classes; another year is never applied. */
function sourceYearV2(rows: readonly ReportRowV1[]): number | null {
  const years = new Set<number>();
  for (const row of rows) {
    const kind = classifyReportClassV1(row.classLabel, row.stageLabel, row.shift);
    if (kind.kind === 'regular') years.add(kind.academicYear);
  }
  return years.size === 1 ? [...years][0]! : null;
}

/**
 * Prepares the report as the ADM's import does. A row with an invalid cell would reject the whole
 * report there (C3); here it is set aside and listed in the Conciliação, and the rest is prepared
 * (owner decision 29/10/2026: differences never hold back what is right).
 */
async function prepareV2(
  reconciliation: Reconciliation,
  catalog: Catalog,
  input: FrequencyStudentReportV2,
  rows: readonly ReportRowV1[],
  notes: FrequencyStudentReportNotesV2,
): Promise<Prepared | null> {
  const sourceYear = sourceYearV2(rows);
  if (sourceYear !== 2026) {
    notes.differences.push('O relatório não é de 2026. Nada foi aplicado.');
    return null;
  }
  const classLinks = classLinksV2(rows, catalog, notes);
  // The database's clock decides "not in the future": a Coletor a few seconds ahead never fails it.
  const generatedAt = new Date(Math.min(Date.parse(input.observedAt), Date.now() - 5000)).toISOString();
  let remaining = [...rows];
  for (let attempt = 0; attempt < ATTEMPTS_V2 && remaining.length; attempt++) {
    const response = await reconciliation.execute({
      ...mutationV2(catalog.context),
      operation: 'prepare',
      normalizationVersion: 1,
      sourceFormat: 'smecel-report-v1',
      date1904: false,
      sourceYear,
      confirmYear: false,
      sourceGeneratedAt: generatedAt,
      rows: remaining,
      classLinks,
    });
    if (response.state === 'validation-failed') {
      const invalid = new Set(response.errors.map((error) => error.sourceRow));
      notes.invalid.push(
        ...response.errors.map((error) => ({
          sourceRow: error.sourceRow,
          name: error.name,
          classLabel: error.classLabel,
          field: error.field,
          reason: error.reason,
        })),
      );
      remaining = remaining.filter((row) => !invalid.has(row.sourceRow));
      continue;
    }
    if (response.state === 'ready' && response.operation === 'prepare') return response;
    if (response.state === 'invalid-request') {
      notes.differences.push('O relatório não pôde ser preparado. Confira no Smecel e envie pelo botão Relatório.');
      return null;
    }
    retryOrFail(response, 'prepare');
  }
  if (!remaining.length) notes.differences.push('Nenhuma linha do relatório pôde ser aplicada.');
  return null;
}

/** Portal credentials of the batch, four per call, then the Conciliação's own apply. */
async function activateV2(
  reconciliation: Reconciliation,
  stage: Stage,
  batchId: string,
  context: ReconciliationContextV1,
): Promise<boolean> {
  for (let call = 0; call < STAGE_CALLS_V2; call++) {
    const check = await reconciliation.execute({ ...mutationV2(context), operation: 'stage', batchId });
    if (check.state !== 'ready' || check.operation !== 'stage') retryOrFail(check, 'stage');
    const staged = await stage({ batchId, generation: context.generation, expectedRevision: context.revision });
    if (staged.state === 'conflict' || staged.state === 'expired') throw new RetryV2();
    if (staged.state === 'unavailable')
      throw new FrequencyErrorV2('unavailable', 503, 'student-report-credentials-unavailable');
    if (staged.state === 'ready') {
      const applied = await reconciliation.execute({
        ...mutationV2(context),
        operation: 'apply',
        batchId,
        confirmDifferences: true,
      });
      if (applied.state !== 'committed') retryOrFail(applied, 'apply');
      return true;
    }
  }
  return false;
}

async function attemptV2(
  reconciliation: Reconciliation,
  stage: Stage,
  input: FrequencyStudentReportV2,
  evidenceHash: string,
  previous: StudentReportPreviousV2 | null,
): Promise<StudentReportOutcomeV2> {
  const catalog = await reconciliation.execute({ contractVersion: 1, academicYear: 2026, operation: 'catalog' });
  if (catalog.state !== 'ready' || catalog.operation !== 'catalog') retryOrFail(catalog, 'catalog');
  const same = previous?.evidenceHash === evidenceHash;
  // Still before the Relação: the batch already kept waits; nothing new to prepare.
  if (same && previous.outcome === 'awaiting_relation' && !catalog.context.relationAvailable)
    return { evidenceHash, outcome: 'awaiting_relation', batchId: previous.batchId, notes: previous.notes, changed: false };
  // The same report whose credentials were still being prepared: go on with its batch.
  if (same && previous.outcome === 'preparing' && previous.batchId) {
    const done = await activateV2(reconciliation, stage, previous.batchId, catalog.context);
    return { evidenceHash, outcome: done ? 'applied' : 'preparing', batchId: previous.batchId, notes: previous.notes, changed: true };
  }
  const notes = emptyNotesV2();
  const rows = input.rows.filter(
    (row) => classifyReportClassV1(row.classLabel, row.stageLabel, row.shift).kind !== 'excluded',
  );
  const prepared = await prepareV2(reconciliation, catalog, input, rows, notes);
  // Nothing right in it: everything goes to the Conciliação all the same.
  if (!prepared) return { evidenceHash, outcome: 'review', batchId: null, notes, changed: true };
  notes.counts = prepared.counts;
  notes.differences.push(...prepared.differences);
  if (prepared.batchState === 'awaiting_relation')
    return { evidenceHash, outcome: 'awaiting_relation', batchId: prepared.batchId, notes, changed: true };
  const done = await activateV2(reconciliation, stage, prepared.batchId, prepared.context);
  return { evidenceHash, outcome: done ? 'applied' : 'preparing', batchId: prepared.batchId, notes, changed: true };
}

/** The Conciliação steps of an automatic report, with whatever reconciliation and staging given. */
export async function applyStudentReportV2(
  reconciliation: Reconciliation,
  stage: Stage,
  input: FrequencyStudentReportV2,
  pending: StudentReportPendingV2,
): Promise<StudentReportOutcomeV2> {
  let previous = pending.previous;
  for (let attempt = 0; attempt < ATTEMPTS_V2; attempt++) {
    try {
      return await attemptV2(reconciliation, stage, input, pending.evidenceHash, previous);
    } catch (error) {
      if (!(error instanceof RetryV2)) throw error;
      // A batch that went stale is prepared again from the report.
      previous = null;
    }
  }
  throw new FrequencyErrorV2('revision-conflict', 409, 'student-report-conciliation-busy');
}

/** The device's grant stands for the administrator who authorized it, as for every collection. */
function trustedContextV2(actor: FrequencyActorV2): TrustedAdminContextV1 {
  return {
    actorId: actor.actorId,
    tenantId: actor.tenantId,
    requestId: crypto.randomUUID(),
    authenticatedAt: new Date().toISOString(),
    capability: 'platform.settings.write',
  };
}

/**
 * The Coletor's automatic "Relatório de alunos" (owner decision 29/10/2026). Three steps, so that
 * no transaction holds the school's row while the report is applied (sqlstate 55P03 in concurrent
 * operations): a short check under the lease (an unchanged report ends there, dates refreshed),
 * the Conciliação's own catalog, prepare, credentials and apply, then a short record of the outcome
 * with the request's receipt.
 */
export async function collectStudentReportV2(
  database: GradebookPostgresDatabaseV1,
  env: RuntimeEnv,
  input: FrequencyStudentReportV2,
  actor: FrequencyActorV2,
): Promise<unknown> {
  const service = createFrequencyServiceV2(database);
  let pending: StudentReportPendingV2;
  try {
    return await service.execute(input, actor);
  } catch (error) {
    if (!(error instanceof StudentReportPendingV2)) throw error;
    pending = error;
  }
  const reconciliation = new StudentReconciliationServiceV1(database, actor.actorId, env.SESSION_SECRET);
  const outcome = await applyStudentReportV2(
    reconciliation,
    (stage) => stageReconciliationCredentialsV1(env, trustedContextV2(actor), stage),
    input,
    pending,
  );
  return service.finishStudentReport(input, actor, outcome);
}
