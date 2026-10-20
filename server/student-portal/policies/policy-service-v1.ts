import { enforceSchoolAccessV1 } from './school-access-v1';
import { z } from 'zod';
import {
  adminCommandV1,
  type AdminCommandV1,
} from '../../../shared/student-portal-contracts/admin-v1';
import {
  policyScopeV1,
  shiftV1,
  versionV1,
  type PolicyScopeV1,
  type ShiftV1,
} from '../../../shared/student-portal-contracts/core-v1';
import {
  completeStoredPolicyValueV1,
  effectiveSettingsV1,
  OPTIONAL_STORED_POLICY_DEFAULTS_V1,
  settingsValueV1,
  type EffectiveSettingsV1,
} from '../../../shared/student-portal-contracts/policy-v1';
import type {
  EffectivePolicyPortV1,
  PortalTransactionV1,
} from '../../../shared/student-portal-contracts/ports-v1';
import {
  StudentPortalPostgresPersistenceV1,
  type StudentPortalPostgresQueryV1,
  type StudentPortalPostgresSqlV1,
} from '../persistence/postgres-persistence-v1';
import { initialPolicyDefaultsV1 } from './defaults-v1';
import { normalizeCalendarV1 } from './calendar-v1';

const FIELDS = [
  'accessEnabled',
  'accessSchedule',
  'showPartials',
  'autoUpdate',
  'showFinalResult',
  'showTermClosing',
  'termClosingConclusive',
  'showFrequency',
  'allowedPeriods',
  'risk',
  'calendar',
] as const;
type Field = (typeof FIELDS)[number];
/** Added by migrations 0020 (#1132), 0021 (schedules) and 0027 (frequência). Absent school rows read as off / none. */
const OPTIONAL_SCHOOL_FIELDS: readonly Field[] = ['showTermClosing', 'termClosingConclusive', 'accessSchedule', 'showFrequency'];
const REQUIRED_SCHOOL_FIELD_COUNT = FIELDS.length - OPTIONAL_SCHOOL_FIELDS.length;
const schoolFieldCountValidV1 = (count: number) =>
  count >= REQUIRED_SCHOOL_FIELD_COUNT && count <= FIELDS.length;
/** Before migration 0020 the school row may be absent: the feature then reads as off. */
const OPTIONAL_SCHOOL_DEFAULTS_V1: Partial<Record<Field, unknown>> = OPTIONAL_STORED_POLICY_DEFAULTS_V1;
const schoolValueV1 = (school: readonly StoredRowV1[]) =>
  completeStoredPolicyValueV1(Object.fromEntries(school.map((row) => [row.field_key, row.value_json])));
const SCHOOL = { kind: 'school', academicYear: 2026 } as const;
const storedRow = z.object({
  scope_key: z.string(),
  field_key: z.enum(FIELDS),
  value_json: z.unknown(),
  source_scope_json: policyScopeV1,
  version: versionV1,
});
type StoredRowV1 = z.infer<typeof storedRow>;
// Built once: a schema created for each target costs more than the validation it performs.
const storedRowsV1 = z.array(storedRow);
const targetClassIdV1 = z.number().int().positive();
const accountVersionV1 = z.coerce.number().int().safe().nonnegative();

function normalizedScope(input: PolicyScopeV1): PolicyScopeV1 {
  const scope = policyScopeV1.parse(input);
  return scope.kind === 'account' ? { ...scope, accountId: scope.accountId.toLowerCase() } : scope;
}

function key(scope: PolicyScopeV1): string {
  if (scope.kind === 'school') return 'school:2026';
  if (scope.kind === 'class') return `class:2026:${scope.classId}`;
  if (scope.kind === 'shift') return `shift:2026:${scope.shift}`;
  return `account:2026:${scope.accountId}`;
}

function canonical(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
  if (input !== null && typeof input === 'object') {
    const entries = Object.entries(input)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([field, value]) => JSON.stringify(field) + ':' + canonical(value))
      .join(',');
    return '{' + entries + '}';
  }
  return JSON.stringify(input);
}

async function hash(input: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(input))),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function lockYear(tx: StudentPortalPostgresQueryV1) {
  await tx.unsafe('SELECT pg_advisory_xact_lock_shared(613,0)');
  await tx.unsafe('SELECT pg_advisory_xact_lock(613,2026)');
}

async function writeField(
  tx: StudentPortalPostgresQueryV1,
  scope: PolicyScopeV1,
  field: Field,
  value: unknown,
  version: number,
) {
  await tx.unsafe(
    `INSERT INTO student_portal.setting
    (scope_key,field_key,scope_kind,academic_year,class_id,account_id,value_json,source_scope_json,version)
    VALUES ($1,$2,$3,2026,$4,$5::uuid,$6::text::jsonb,$7::text::jsonb,$8)
    ON CONFLICT (scope_key,field_key) DO UPDATE SET value_json=EXCLUDED.value_json,
      source_scope_json=EXCLUDED.source_scope_json,version=EXCLUDED.version,updated_at=statement_timestamp()`,
    [
      key(scope),
      field,
      scope.kind,
      scope.kind === 'class' ? scope.classId : null,
      scope.kind === 'account' ? scope.accountId : null,
      JSON.stringify(value),
      JSON.stringify(scope),
      version,
    ],
  );
}

function immediateCalendarChange(previous: unknown, next: unknown, now: number): boolean {
  const before = normalizeCalendarV1(previous);
  const after = normalizeCalendarV1(next);
  const past = (value: string | null) => value !== null && Date.parse(value) <= now;
  const changedDate = (left: string | null, right: string | null) =>
    left !== right && (past(left) || past(right));
  const dates = [
    'enrollmentStartsAt',
    'yearStartsAt',
    't1EndsAt',
    't2StartsAt',
    't2EndsAt',
    't3StartsAt',
    't3EndsAt',
    'recoveriesStartAt',
    'yearEndsAt',
    'finalDisclosureAt',
    'accessStartsAt',
    'accessEndsAt',
    'finalDisclosureEndsAt',
  ] as const;
  if (dates.some((field) => changedDate(before[field] ?? null, after[field] ?? null))) return true;
  // Agendas (Aba Notas) can change what students see right away: any change is immediate.
  if (canonical(before.finalAgenda ?? null) !== canonical(after.finalAgenda ?? null)) return true;
  const left = before.disclosure;
  const right = after.disclosure;
  if (left.mode !== right.mode) return true;
  if (left.mode === 'agenda' || right.mode === 'agenda') return canonical(left) !== canonical(right);
  if (left.mode === 'single' && right.mode === 'single') {
    return (
      changedDate(left.at, right.at) ||
      changedDate(left.endsAt ?? null, right.endsAt ?? null) ||
      (canonical([...left.periods].sort((a, b) => a.localeCompare(b))) !==
        canonical([...right.periods].sort((a, b) => a.localeCompare(b))) &&
        (past(left.at) || past(right.at)))
    );
  }
  if (left.mode === 'per-period' && right.mode === 'per-period') {
    return (['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'] as const).some(
      (period) =>
        changedDate(left.at[period], right.at[period]) ||
        changedDate(left.endsAt?.[period] ?? null, right.endsAt?.[period] ?? null),
    );
  }
  return false;
}

function schoolDefaultsV1(records: readonly StoredRowV1[]) {
  const school = records.filter((row) => row.scope_key === key(SCHOOL));
  const present = new Set(school.map((row) => row.field_key));
  const complete =
    schoolFieldCountValidV1(school.length) &&
    present.size === school.length &&
    FIELDS.every((field) => present.has(field) || OPTIONAL_SCHOOL_FIELDS.includes(field)) &&
    new Set(school.map((row) => row.version)).size === 1;
  if (!complete) throw new Error('student-portal-policy-defaults-unavailable');
  if (school.some((row) => key(normalizedScope(row.source_scope_json)) !== key(SCHOOL)))
    throw new Error('student-portal-policy-defaults-unavailable');
  try {
    const defaults = settingsValueV1.parse(schoolValueV1(school));
    normalizeCalendarV1(defaults.calendar);
  } catch {
    throw new Error('student-portal-policy-defaults-unavailable');
  }
  return school;
}

/**
 * Resolution order (owner decision 28/09/2026): school, then class, then shift, then account. The
 * shift comes after its class, so for the same option a shift rule wins and the class's own rule
 * stays stored but inactive; an account rule still wins over both.
 */
function scopeChainV1(scope: PolicyScopeV1, classId: number | null, shift: ShiftV1 | null): PolicyScopeV1[] {
  const chain: PolicyScopeV1[] = [SCHOOL];
  if (classId !== null) chain.push({ kind: 'class', academicYear: 2026, classId });
  if (shift !== null) chain.push({ kind: 'shift', academicYear: 2026, shift });
  if (scope.kind === 'account') chain.push(scope);
  return chain;
}

function resolvedValuesV1(records: readonly StoredRowV1[], chain: readonly PolicyScopeV1[]) {
  const value: Record<string, unknown> = {};
  const sources: Record<string, PolicyScopeV1> = {};
  for (const origin of chain) {
    const originKey = key(origin);
    for (const row of records.filter((item) => item.scope_key === originKey)) {
      // Foundation snapshots may annotate inherited values. Only the owning scope overrides.
      if (key(normalizedScope(row.source_scope_json)) !== originKey) continue;
      value[row.field_key] =
        row.field_key === 'calendar' ? normalizeCalendarV1(row.value_json) : row.value_json;
      sources[row.field_key] = origin;
    }
  }
  return { value, sources };
}

const resolvedPolicyV1 = effectiveSettingsV1.pick({ value: true, sources: true });
type ResolvedPolicyV1 = z.infer<typeof resolvedPolicyV1> & {
  enforced: ReturnType<typeof enforceSchoolAccessV1>;
  epoch: number;
};
/**
 * Work of one read shared by the targets whose stored rows are identical. Without an account rule
 * among those rows the resolved value, its sources and the enforced value cannot depend on which
 * account is being resolved; only the scope and the version are the account's own. The memory
 * belongs to the read that created it and is never kept by this module.
 */
export type PolicyResolutionMemoV1 = Map<string, ResolvedPolicyV1>;
export const createPolicyResolutionMemoV1 = (): PolicyResolutionMemoV1 => new Map();

/** Shared pure policy resolution for single-target and batched administrative reads. */
export async function resolvePolicySnapshotRowsV1(
  input: PolicyScopeV1,
  rows: readonly Record<string, unknown>[],
  memo?: PolicyResolutionMemoV1,
) {
  const resolved = resolvePolicyValuesRowsV1(input, rows, memo);
  const { settings, classId, shift } = resolved;
  return { ...resolved, policyVersion: `policy:${await hash({ settings, classId, shift })}` };
}

/** The same resolution without the version digest, for a reader that only applies the policy. */
export function resolvePolicyValuesRowsV1(
  input: PolicyScopeV1,
  rows: readonly Record<string, unknown>[],
  memo?: PolicyResolutionMemoV1,
) {
  const scope = normalizedScope(input);
  if (rows.length !== 1 || rows[0]!.resolved !== true)
    throw new Error('student-portal-policy-target-unresolved');
  const target = rows[0]!;
  const memoKey = memo
    ? JSON.stringify([
        scope.kind === 'account' ? 'account' : scope,
        target.class_id ?? null,
        target.shift ?? null,
        target.settings_rows,
      ])
    : null;
  let resolved = memoKey === null ? undefined : memo!.get(memoKey);
  if (!resolved) {
    const records = storedRowsV1.parse(target.settings_rows);
    const school = schoolDefaultsV1(records);
    const { value, sources } = resolvedValuesV1(
      records,
      scopeChainV1(scope, targetClassV1(target), targetShiftV1(scope, target)),
    );
    for (const [field, fallback] of Object.entries(OPTIONAL_SCHOOL_DEFAULTS_V1))
      if (!(field in value)) {
        value[field] = fallback;
        sources[field] = SCHOOL;
      }
    const checked = resolvedPolicyV1.parse({ value, sources });
    resolved = {
      ...checked,
      enforced: enforceSchoolAccessV1(checked, settingsValueV1.parse(schoolValueV1(school))),
      epoch: school[0]!.version,
    };
    // An account's own rule makes the result that account's alone.
    if (memoKey !== null && !records.some((row) => row.scope_key.startsWith('account:')))
      memo!.set(memoKey, resolved);
  }
  const classId = targetClassV1(target);
  const shift = targetShiftV1(scope, target);
  const accountVersion = accountVersionV1.parse(target.account_version);
  const version = versionV1.parse(resolved.epoch + accountVersion);
  // Each target receives its own objects: nothing resolved for one can be changed through another.
  const own = <T>(part: T): T => (memo ? structuredClone(part) : part);
  const settings: EffectiveSettingsV1 = {
    scope,
    version,
    value: own(resolved.value),
    sources: own(resolved.sources),
  };
  return { settings, enforcedValue: own(resolved.enforced), classId, shift, epoch: resolved.epoch };
}
function targetClassV1(target: Record<string, unknown>) {
  return target.class_id === null ? null : targetClassIdV1.parse(target.class_id);
}
/** A shift scope is its own level; any other target takes the shift of its class, if known. */
function targetShiftV1(scope: PolicyScopeV1, target: Record<string, unknown>) {
  return scope.kind === 'shift'
    ? scope.shift
    : target.shift === null || target.shift === undefined
      ? null
      : shiftV1.parse(target.shift);
}

type SettingsSetCommandV1 = Extract<AdminCommandV1, { operation: 'settings-set' }>;
type SettingsInheritCommandV1 = Extract<AdminCommandV1, { operation: 'settings-inherit' }>;
type SettingsCommandV1 = SettingsSetCommandV1 | SettingsInheritCommandV1;

function settingsCommandV1(input: unknown): SettingsCommandV1 {
  const command = adminCommandV1.parse(input);
  if (command.operation !== 'settings-set' && command.operation !== 'settings-inherit')
    throw new Error('student-portal-policy-command-invalid');
  return command;
}

async function statementNowV1(tx: StudentPortalPostgresQueryV1) {
  const clock = await tx.unsafe('SELECT statement_timestamp() AS now');
  const raw = clock[0]!.now;
  return raw instanceof Date ? raw : new Date(z.string().parse(raw));
}

async function receiptReplayV1(
  tx: StudentPortalPostgresQueryV1,
  persistence: PortalTransactionV1,
  command: SettingsCommandV1,
  receiptActor: string,
  requestDigest: string,
  now: Date,
) {
  const existing = await persistence.readIdempotency(command.idempotencyKey, receiptActor);
  if (!existing) return null;
  if (Date.parse(existing.expiresAt) <= now.getTime()) {
    await tx.unsafe(
      'DELETE FROM student_portal.operation_receipt WHERE idempotency_key=$1 AND actor_id=$2',
      [command.idempotencyKey, receiptActor],
    );
    return null;
  }
  if (existing.requestDigest !== requestDigest)
    throw new Error('student-portal-policy-idempotency-conflict');
  return { operationId: existing.operationId, version: existing.version };
}

function storedMatchesV1(
  previous: Record<string, unknown> | undefined,
  value: unknown,
  scope: PolicyScopeV1,
) {
  return Boolean(
    previous &&
    canonical(previous.value_json) === canonical(value) &&
    canonical(previous.source_scope_json) === canonical(scope),
  );
}

async function applySettingsSetV1(
  tx: StudentPortalPostgresQueryV1,
  scope: PolicyScopeV1,
  command: SettingsSetCommandV1,
  stored: readonly Record<string, unknown>[],
  nextEpoch: number,
  previousCalendar: unknown,
  now: Date,
) {
  let changed = false;
  for (const field of FIELDS) {
    if (!(field in command.value)) continue;
    const value =
      field === 'calendar' ? normalizeCalendarV1(command.value.calendar) : command.value[field];
    const previous = stored.find((row) => row.field_key === field);
    if (field === 'accessSchedule' && value === null) {
      // No schedule is kept as no row, so levels without one never need migration 0021.
      if (!previous) continue;
      if (!command.acknowledgeImmediateEffect)
        throw new Error('student-portal-policy-immediate-confirmation-required');
      await tx.unsafe('DELETE FROM student_portal.setting WHERE scope_key=$1 AND field_key=$2', [key(scope), field]);
      changed = true;
      continue;
    }
    if (storedMatchesV1(previous, value, scope)) continue;
    const immediate =
      field !== 'calendar' || immediateCalendarChange(previousCalendar, value, now.getTime());
    if (!command.acknowledgeImmediateEffect && immediate)
      throw new Error('student-portal-policy-immediate-confirmation-required');
    await writeField(tx, scope, field, value, nextEpoch);
    changed = true;
  }
  return changed;
}

async function applySettingsInheritV1(
  tx: StudentPortalPostgresQueryV1,
  scope: PolicyScopeV1,
  command: SettingsInheritCommandV1,
) {
  let changed = false;
  for (const field of command.keys) {
    const deleted = await tx.unsafe(
      'DELETE FROM student_portal.setting WHERE scope_key=$1 AND field_key=$2 RETURNING field_key',
      [key(scope), field],
    );
    changed ||= deleted.length > 0;
  }
  return changed;
}

async function applySettingsCommandV1(
  tx: StudentPortalPostgresQueryV1,
  scope: PolicyScopeV1,
  command: SettingsCommandV1,
  stored: readonly Record<string, unknown>[],
  nextEpoch: number,
  previousCalendar: unknown,
  now: Date,
) {
  if (command.operation === 'settings-set')
    return applySettingsSetV1(tx, scope, command, stored, nextEpoch, previousCalendar, now);
  return applySettingsInheritV1(tx, scope, command);
}

async function advancePolicyEpochV1(tx: StudentPortalPostgresQueryV1, nextEpoch: number) {
  const advanced = await tx.unsafe(
    "UPDATE student_portal.setting SET version=$1,updated_at=statement_timestamp() WHERE scope_key='school:2026' RETURNING field_key",
    [nextEpoch],
  );
  if (!schoolFieldCountValidV1(advanced.length))
    throw new Error('student-portal-policy-defaults-unavailable');
  // Preserve the last published payload; the new policyVersion invalidates its authorization.
  await tx.unsafe(
    "UPDATE student_portal.publication_job SET state='failed',lease_until=NULL,updated_at=statement_timestamp() WHERE state IN ('queued','running')",
  );
}

async function savePolicyMutationV1(
  persistence: PortalTransactionV1,
  actor: string,
  scope: PolicyScopeV1,
  command: SettingsCommandV1,
  receiptActor: string,
  requestDigest: string,
  now: Date,
  version: number,
  changed: boolean,
) {
  const operationId = crypto.randomUUID();
  if (changed)
    await persistence.appendAudit({
      eventId: crypto.randomUUID(),
      at: now.toISOString(),
      actorId: actor,
      accountId: scope.kind === 'account' ? scope.accountId : null,
      scope,
      kind: 'settings-changed',
      result: 'success',
      requestId: command.idempotencyKey,
      version,
      maskedIp: null,
    });
  await persistence.saveIdempotency({
    key: command.idempotencyKey,
    actorId: receiptActor,
    requestDigest,
    operationId,
    version,
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  });
  return { operationId, version };
}

export class PolicyServiceV1 implements EffectivePolicyPortV1 {
  constructor(private readonly sql: StudentPortalPostgresSqlV1) {}

  async read(scope: PolicyScopeV1): Promise<EffectiveSettingsV1> {
    return (await this.readSnapshotInTransaction(this.sql, scope)).settings;
  }

  async readSnapshot(scope: PolicyScopeV1) {
    return this.readSnapshotInTransaction(this.sql, scope);
  }

  /** One SQL snapshot includes current class and shift, account version, overrides and school epoch. */
  async readSnapshotInTransaction(tx: StudentPortalPostgresQueryV1, input: PolicyScopeV1) {
    const scope = normalizedScope(input);
    const rows = await tx.unsafe(
      `WITH current_account AS (
      SELECT a.version::text AS account_version,b.class_id,b.matches FROM student_portal.account a
      CROSS JOIN LATERAL (SELECT min(class_id) AS class_id,count(*)::integer AS matches
        FROM student_portal.academic_binding_v1 WHERE academic_year=2026 AND student_id=a.gradebook_student_id
          AND status IS DISTINCT FROM 6) b
      WHERE a.id=$2::uuid AND a.academic_year=2026 AND a.closed_at IS NULL AND a.gradebook_student_id IS NOT NULL
    ), target AS (
      SELECT CASE WHEN $1='account' THEN (SELECT class_id FROM current_account) ELSE $3::integer END AS class_id,
        CASE WHEN $1='account' THEN COALESCE((SELECT matches=1 FROM current_account),false) ELSE true END AS resolved,
        CASE WHEN $1='account' THEN COALESCE((SELECT account_version FROM current_account),'0') ELSE '0' END AS account_version
    ), shifted AS (
      SELECT target.*,CASE WHEN $1='shift' THEN $4::text
        ELSE (SELECT c.shift FROM student_portal.academic_class_v1 c
          WHERE c.academic_year=2026 AND c.class_id=target.class_id) END AS shift FROM target
    ) SELECT shifted.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'scope_key',s.scope_key,'field_key',s.field_key,'value_json',s.value_json,'source_scope_json',s.source_scope_json,'version',s.version))
      FROM student_portal.setting s WHERE s.scope_key='school:2026'
        OR s.scope_key='class:2026:'||shifted.class_id::text
        OR s.scope_key='shift:2026:'||shifted.shift
        OR ($1='account' AND s.scope_key='account:2026:'||$2::uuid::text)), '[]'::jsonb) AS settings_rows FROM shifted`,
      [
        scope.kind,
        scope.kind === 'account' ? scope.accountId : null,
        scope.kind === 'class' ? scope.classId : null,
        scope.kind === 'shift' ? scope.shift : null,
      ],
    );
    return resolvePolicySnapshotRowsV1(scope, rows);
  }

  async initializeDefaults() {
    return this.sql.begin(async (tx) => {
      await lockYear(tx);
      const rows = await tx.unsafe(
        "SELECT field_key FROM student_portal.setting WHERE scope_key='school:2026' FOR UPDATE",
      );
      if (rows.length === 0) {
        const defaults = initialPolicyDefaultsV1();
        // No row already reads as off for showFrequency, so the bootstrap never needs migration 0027.
        for (const field of FIELDS)
          if (defaults[field] !== null && field !== 'showFrequency')
            await writeField(tx, SCHOOL, field, defaults[field], 1);
      }
      return this.readSnapshotInTransaction(tx, SCHOOL);
    });
  }

  async mutate(actorId: string, input: unknown) {
    return this.sql.begin((tx) => this.mutateInTransaction(tx, actorId, input));
  }

  /** Composition can enqueue publication work on this same physical transaction before commit. */
  async mutateInTransaction(tx: StudentPortalPostgresQueryV1, actorId: string, input: unknown) {
    const actor = z.uuid().parse(actorId).toLowerCase();
    const command = settingsCommandV1(input);
    const scope = normalizedScope(command.scope);
    if (command.operation === 'settings-inherit' && scope.kind === 'school')
      throw new Error('student-portal-school-cannot-inherit');

    await lockYear(tx);
    const store = new StudentPortalPostgresPersistenceV1({
      unsafe: (query, parameters) => tx.unsafe(query, parameters),
      begin: (operation) => operation(tx),
    });
    return store.transaction(async (persistence) => {
      const now = await statementNowV1(tx);
      const receiptActor = `policy:${actor}`;
      const requestDigest = await hash({ ...command, scope });
      const replay = await receiptReplayV1(
        tx,
        persistence,
        command,
        receiptActor,
        requestDigest,
        now,
      );
      if (replay) return replay;

      if (scope.kind === 'shift' && command.operation === 'settings-set') {
        const existing = await tx.unsafe(
          'SELECT 1 FROM student_portal.academic_class_v1 WHERE academic_year=2026 AND shift=$1 LIMIT 1',
          [scope.shift],
        );
        if (existing.length === 0) throw new Error('student-portal-shift-invalid-request');
      }
      if (scope.kind === 'account') await persistence.lockAccounts([scope.accountId]);
      const before = await this.readSnapshotInTransaction(tx, scope);
      if (before.settings.version !== command.expectedVersion)
        throw new Error('student-portal-policy-version-conflict');

      const stored = await tx.unsafe(
        'SELECT field_key,value_json,source_scope_json FROM student_portal.setting WHERE scope_key=$1 FOR UPDATE',
        [key(scope)],
      );
      const nextEpoch = versionV1.parse(before.epoch + 1);
      const changed = await applySettingsCommandV1(
        tx,
        scope,
        command,
        stored,
        nextEpoch,
        before.settings.value.calendar,
        now,
      );
      if (changed) await advancePolicyEpochV1(tx, nextEpoch);

      const after = await this.readSnapshotInTransaction(tx, scope);
      return savePolicyMutationV1(
        persistence,
        actor,
        scope,
        command,
        receiptActor,
        requestDigest,
        now,
        after.settings.version,
        changed,
      );
    });
  }
}
