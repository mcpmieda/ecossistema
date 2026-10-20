import { AUDIT_IP_MASK_V1, AUDIT_IP_SOURCE_V1 } from '../observability/audit-context-v1';
import {
  accountStateV1,
  eligibilityStateV1,
  scopeV1,
  type AcademicLinkV1,
  type PolicyScopeV1,
  type ScopeV1,
} from '../../../shared/student-portal-contracts/core-v1';
import { auditEventV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { effectiveSettingsV1, type EffectiveSettingsV1 } from '../../../shared/student-portal-contracts/policy-v1';
import type {
  AccountRecordV1,
  AttemptRecordV1,
  BirthRecordV1,
  ChallengeRecordV1,
  CredentialRecordV1,
  IdempotencyRecordV1,
  PersistencePortV1,
  PortalTransactionV1,
  PublicationJobV1,
  RevisionEventV1,
  SessionRecordV1,
  VerifierV1,
} from '../../../shared/student-portal-contracts/ports-v1';

type SqlRowV1 = Record<string, unknown>;

export interface StudentPortalPostgresResultV1<Row extends SqlRowV1 = SqlRowV1>
  extends ReadonlyArray<Row> {
  readonly count?: number | null;
}

export interface StudentPortalPostgresQueryV1 {
  unsafe<Row extends SqlRowV1 = SqlRowV1>(
    query: string,
    parameters?: readonly unknown[],
  ): PromiseLike<StudentPortalPostgresResultV1<Row>>;
}

export interface StudentPortalPostgresSqlV1 extends StudentPortalPostgresQueryV1 {
  begin<T>(operation: (sql: StudentPortalPostgresQueryV1) => Promise<T>): Promise<T>;
}

async function rows<Row extends SqlRowV1>(
  sql: StudentPortalPostgresQueryV1,
  query: string,
  parameters: readonly unknown[] = [],
): Promise<readonly Row[]> {
  return Array.from(await sql.unsafe<Row>(query, parameters));
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) throw new Error(`student-portal-invalid-${field}`);
  return parsed;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`student-portal-invalid-${field}`);
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === '0') return false;
  if (value === 1 || value === '1') return true;
  throw new Error(`student-portal-invalid-${field}`);
}

function instant(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(text(value, field));
  if (Number.isNaN(date.getTime())) throw new Error(`student-portal-invalid-${field}`);
  return date.toISOString();
}

function nullableInstant(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : instant(value, field);
}

function json(value: unknown, field: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`student-portal-invalid-${field}`);
  }
}

function verifier(value: unknown, field: string): VerifierV1 | null {
  if (value === null || value === undefined) return null;
  const parsed = json(value, field);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`student-portal-invalid-${field}`);
  }
  const record = parsed as Record<string, unknown>;
  const parameters = record.parameters;
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error(`student-portal-invalid-${field}-parameters`);
  }
  const normalizedParameters: Record<string, number> = {};
  for (const [key, parameter] of Object.entries(parameters as Record<string, unknown>)) {
    if (typeof parameter !== 'number' || !Number.isFinite(parameter)) {
      throw new Error(`student-portal-invalid-${field}-parameter`);
    }
    normalizedParameters[key] = parameter;
  }
  return {
    algorithm: text(record.algorithm, `${field}-algorithm`),
    parameters: normalizedParameters,
    salt: text(record.salt, `${field}-salt`),
    pepperVersion: integer(record.pepperVersion, `${field}-pepper-version`),
    digest: text(record.digest, `${field}-digest`),
  };
}

function scopeKey(scope: PolicyScopeV1): string {
  switch (scope.kind) {
    case 'school':
      return `school:${String(scope.academicYear)}`;
    case 'class':
      return `class:${String(scope.academicYear)}:${String(scope.classId)}`;
    case 'shift':
      return `shift:${String(scope.academicYear)}:${scope.shift}`;
    case 'account':
      return `account:${String(scope.academicYear)}:${scope.accountId}`;
  }
}

function scopeColumns(scope: PolicyScopeV1): readonly [string, number, number | null, string | null] {
  return [scope.kind, scope.academicYear, scope.kind === 'class' ? scope.classId : null, scope.kind === 'account' ? scope.accountId : null];
}

function sameLink(left: AcademicLinkV1 | null, right: AcademicLinkV1 | null): boolean {
  if (left === null || right === null) return left === right;
  return left.academicYear === right.academicYear && left.studentId === right.studentId;
}

export function accountFromRowV1(row: SqlRowV1): AccountRecordV1 {
  const studentId = row.gradebook_student_id === null ? null : integer(row.gradebook_student_id, 'student-id');
  const year = integer(row.academic_year, 'academic-year');
  const link = studentId === null ? null : ({ academicYear: year, studentId } as AcademicLinkV1);
  return {
    id: text(row.id, 'account-id'),
    link,
    state: accountStateV1.parse(text(row.auth_state, 'account-state')),
    eligibility: eligibilityStateV1.parse(text(row.eligibility, 'eligibility')),
    blocked: booleanValue(row.blocked, 'blocked'),
    version: integer(row.version, 'account-version'),
    securityVersion: integer(row.security_version, 'security-version'),
    pinVersion: integer(row.pin_version, 'pin-version'),
    closedAt: nullableInstant(row.closed_at, 'closed-at'),
  };
}

function sessionFromRow(row: SqlRowV1): SessionRecordV1 {
  return {
    id: text(row.id, 'session-id'),
    accountId: text(row.account_id, 'account-id'),
    tokenHash: text(row.token_hash, 'token-hash'),
    securityVersion: integer(row.security_version, 'security-version'),
    expiresAt: instant(row.expires_at, 'expires-at'),
    revokedAt: nullableInstant(row.revoked_at, 'revoked-at'),
    persistent: booleanValue(row.persistent, 'persistent'),
  };
}

async function bumpPortalLinkRevision(
  sql: StudentPortalPostgresQueryV1,
  studentIds: readonly number[],
): Promise<void> {
  const state = await rows<SqlRowV1>(
    sql,
    `UPDATE student_portal.academic_revision
       SET reset_counter=reset_counter+1,
           portal_link_counter=portal_link_counter+1,
           updated_at=now()
     WHERE academic_year=$1
     RETURNING academic_generation,academic_counter,reset_generation,reset_counter,
               portal_link_generation,portal_link_counter`,
    [2026],
  );
  const current = state[0];
  if (!current) throw new Error('student-portal-revision-state-missing');
  const dataVersion = `${text(current.academic_generation, 'academic-generation')}:${String(current.academic_counter)}`;
  const resetVersion = `${text(current.reset_generation, 'reset-generation')}:${String(current.reset_counter)}`;
  const portalLinkVersion = `${text(current.portal_link_generation, 'portal-link-generation')}:${String(current.portal_link_counter)}`;
  await rows(
    sql,
    `INSERT INTO student_portal.revision_event
       (event_id,academic_year,student_ids,cause,affects_academic,affects_reset,
        data_version,reset_version,portal_link_version,occurred_at)
     VALUES (gen_random_uuid(),$1,$2::integer[],'portal-link',false,true,$3,$4,$5,now())`,
    [2026, [...studentIds], dataVersion, resetVersion, portalLinkVersion],
  );
}

class StudentPortalTransaction implements PortalTransactionV1 {
  private yearLock: 'exclusive' | 'shared' | null = null;
  constructor(private readonly sql: StudentPortalPostgresQueryV1) {}

  private requireYearWriter(): void {
    if (this.yearLock === 'shared') throw new Error('student-portal-shared-year-write-forbidden');
  }

  async lockAcademicYear(year: 2026, mode: 'exclusive' | 'shared' = 'exclusive'): Promise<void> {
    if (year !== 2026) throw new Error('student-portal-year-not-supported');
    if (mode === 'exclusive') this.requireYearWriter();
    await rows(this.sql, 'SELECT pg_advisory_xact_lock_shared($1,$2)', [613, 0]);
    await rows(this.sql, mode === 'shared'
      ? 'SELECT pg_advisory_xact_lock_shared($1,$2)' : 'SELECT pg_advisory_xact_lock($1,$2)', [613, year]);
    await rows(this.sql, mode === 'shared'
      ? 'SELECT academic_year FROM student_portal.academic_revision WHERE academic_year=$1 FOR SHARE'
      : 'SELECT academic_year FROM student_portal.academic_revision WHERE academic_year=$1 FOR UPDATE', [year]);
    if (this.yearLock !== 'exclusive') this.yearLock = mode;
  }

  async lockAccounts(accountIdsSorted: readonly string[]): Promise<void> {
    const sorted = [...accountIdsSorted].sort((left, right) => left.localeCompare(right));
    if (sorted.some((value, index) => value !== accountIdsSorted[index])) {
      throw new Error('student-portal-account-lock-order');
    }
    for (const accountId of sorted) {
      await rows(this.sql, 'SELECT id FROM student_portal.account WHERE id=$1::uuid FOR UPDATE', [accountId]);
    }
  }

  async findAccount(id: string): Promise<AccountRecordV1 | null> {
    const result = await rows(
      this.sql,
      `SELECT id,academic_year,gradebook_student_id,auth_state,eligibility,blocked,
              version,security_version,pin_version,closed_at
         FROM student_portal.account WHERE id=$1::uuid`,
      [id],
    );
    return result[0] ? accountFromRowV1(result[0]) : null;
  }

  async findByLink(link: AcademicLinkV1): Promise<AccountRecordV1 | null> {
    const result = await rows(
      this.sql,
      `SELECT id,academic_year,gradebook_student_id,auth_state,eligibility,blocked,
              version,security_version,pin_version,closed_at
         FROM student_portal.account
        WHERE academic_year=$1 AND gradebook_student_id=$2 AND closed_at IS NULL`,
      [link.academicYear, link.studentId],
    );
    return result[0] ? accountFromRowV1(result[0]) : null;
  }

  async insertAccount(record: AccountRecordV1): Promise<'created' | 'existing'> {
    this.requireYearWriter();
    const result = await rows(
      this.sql,
      `INSERT INTO student_portal.account
         (id,academic_year,gradebook_student_id,auth_state,eligibility,blocked,
          version,security_version,pin_version,closed_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        record.id,
        record.link?.academicYear ?? 2026,
        record.link?.studentId ?? null,
        record.state,
        record.eligibility,
        record.blocked,
        record.version,
        record.securityVersion,
        record.pinVersion,
        record.closedAt,
      ],
    );
    if (!result[0]) return 'existing';
    if (record.link) await bumpPortalLinkRevision(this.sql, [record.link.studentId]);
    return 'created';
  }

  async compareAndSetAccount(record: AccountRecordV1, expectedVersion: number): Promise<boolean> {
    const current = await this.findAccount(record.id);
    if (!current || current.version !== expectedVersion || !sameLink(current.link, record.link)) return false;
    const result = await rows(
      this.sql,
      `UPDATE student_portal.account
          SET auth_state=$1,eligibility=$2,blocked=$3,version=$4,
              security_version=$5,pin_version=$6,updated_at=now()
        WHERE id=$7::uuid AND version=$8
          AND gradebook_student_id IS NOT DISTINCT FROM $9
        RETURNING id`,
      [
        record.state,
        record.eligibility,
        record.blocked,
        record.version,
        record.securityVersion,
        record.pinVersion,
        record.id,
        expectedVersion,
        record.link?.studentId ?? null,
      ],
    );
    return Boolean(result[0]);
  }

  async saveSession(record: SessionRecordV1): Promise<void> {
    await rows(
      this.sql,
      `INSERT INTO student_portal.session
         (id,account_id,token_hash,security_version,expires_at,revoked_at,persistent)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5::timestamptz,$6::timestamptz,$7)`,
      [record.id, record.accountId, record.tokenHash, record.securityVersion, record.expiresAt, record.revokedAt, record.persistent],
    );
  }

  async revokeSessions(scope: ScopeV1, revokedAt: string, sessionId?: string): Promise<number> {
    scopeV1.parse(scope);
    const parameters: unknown[] = [revokedAt];
    let predicate: string;
    if (scope.kind === 'account') {
      parameters.push(scope.accountId);
      predicate = 's.account_id=$2::uuid';
      if (sessionId) {
        parameters.push(sessionId);
        predicate += ' AND s.id=$3::uuid';
      }
    } else if (scope.kind === 'class') {
      parameters.push(scope.academicYear, scope.classId);
      predicate = `s.account_id IN (
        SELECT a.id FROM student_portal.account a
        JOIN student_portal.academic_binding_v1 b
          ON b.academic_year=a.academic_year AND b.student_id=a.gradebook_student_id
       WHERE a.academic_year=$2 AND b.class_id=$3 AND b.status IS DISTINCT FROM 6
      )`;
    } else {
      parameters.push(scope.academicYear);
      predicate = 's.account_id IN (SELECT id FROM student_portal.account WHERE academic_year=$2)';
    }
    const result = await rows(
      this.sql,
      `UPDATE student_portal.session s SET revoked_at=$1::timestamptz
        WHERE ${predicate} AND s.revoked_at IS NULL
        RETURNING s.id`,
      parameters,
    );
    return result.length;
  }

  async consumeChallenge(hash: string, securityVersion: number, pinVersion: number, now: string): Promise<boolean> {
    const result = await rows(
      this.sql,
      `UPDATE student_portal.auth_challenge
          SET consumed_at=$1::timestamptz
        WHERE token_hash=$2 AND security_version=$3 AND pin_version=$4
          AND consumed_at IS NULL AND expires_at>$1::timestamptz
        RETURNING token_hash`,
      [now, hash, securityVersion, pinVersion],
    );
    return Boolean(result[0]);
  }

  async saveChallenge(record: ChallengeRecordV1): Promise<void> {
    await rows(
      this.sql,
      `INSERT INTO student_portal.auth_challenge
         (token_hash,account_id,security_version,pin_version,expires_at,consumed_at)
       VALUES ($1,$2::uuid,$3,$4,$5::timestamptz,$6::timestamptz)`,
      [record.tokenHash, record.accountId, record.securityVersion, record.pinVersion, record.expiresAt, record.consumedAt],
    );
  }

  async readCredentials(accountId: string): Promise<CredentialRecordV1 | null> {
    const result = await rows(
      this.sql,
      `SELECT q.account_id,q.credential_id,q.key_version,q.state,
              p.pin_verifier,p.password_verifier,p.pin_version
         FROM student_portal.qr_credential q
         LEFT JOIN student_portal.password_credential p ON p.account_id=q.account_id
        WHERE q.account_id=$1::uuid
        ORDER BY CASE WHEN q.state='active' THEN 0 ELSE 1 END,q.issued_at DESC
        LIMIT 1`,
      [accountId],
    );
    const row = result[0];
    if (!row) return null;
    return {
      accountId: text(row.account_id, 'account-id'),
      credentialId: text(row.credential_id, 'credential-id'),
      keyVersion: integer(row.key_version, 'key-version'),
      state: text(row.state, 'credential-state') === 'active' ? 'active' : 'revoked',
      pin: verifier(row.pin_verifier, 'pin-verifier'),
      password: verifier(row.password_verifier, 'password-verifier'),
      pinVersion: row.pin_version === null ? 0 : integer(row.pin_version, 'pin-version'),
    };
  }

  async saveCredentials(record: CredentialRecordV1): Promise<void> {
    if (record.state === 'active') {
      await rows(
        this.sql,
        `UPDATE student_portal.qr_credential SET state='revoked',revoked_at=now()
          WHERE account_id=$1::uuid AND state='active' AND credential_id<>$2`,
        [record.accountId, record.credentialId],
      );
    }
    await rows(
      this.sql,
      `INSERT INTO student_portal.qr_credential
         (credential_id,account_id,key_version,state,revoked_at)
       VALUES ($1,$2::uuid,$3,$4,CASE WHEN $4='revoked' THEN now() ELSE NULL END)
       ON CONFLICT (credential_id) DO UPDATE
         SET key_version=EXCLUDED.key_version,state=EXCLUDED.state,
             revoked_at=CASE WHEN EXCLUDED.state='revoked' THEN COALESCE(student_portal.qr_credential.revoked_at,now()) ELSE NULL END
       WHERE student_portal.qr_credential.account_id=EXCLUDED.account_id`,
      [record.credentialId, record.accountId, record.keyVersion, record.state],
    );
    await rows(
      this.sql,
      `INSERT INTO student_portal.password_credential
         (account_id,pin_verifier,password_verifier,pin_version)
       VALUES ($1::uuid,$2::text::jsonb,$3::text::jsonb,$4)
       ON CONFLICT (account_id) DO UPDATE
         SET pin_verifier=EXCLUDED.pin_verifier,password_verifier=EXCLUDED.password_verifier,
             pin_version=EXCLUDED.pin_version,updated_at=now()`,
      [
        record.accountId,
        record.pin === null ? null : JSON.stringify(record.pin),
        record.password === null ? null : JSON.stringify(record.password),
        record.pinVersion,
      ],
    );
  }

  async readBirth(accountId: string): Promise<BirthRecordV1 | null> {
    const result = await rows(
      this.sql,
      `SELECT account_id,birth_year,confirmation,version
         FROM student_portal.account_birth_v1 WHERE account_id=$1::uuid`,
      [accountId],
    );
    const row = result[0];
    if (!row) return null;
    return {
      accountId: text(row.account_id, 'account-id'),
      year: row.birth_year === null ? null : String(integer(row.birth_year, 'birth-year')),
      confirmation: row.confirmation === null ? null : text(row.confirmation, 'birth-confirmation') as BirthRecordV1['confirmation'],
      version: integer(row.version, 'birth-version'),
    };
  }

  async readAttempts(accountId: string): Promise<AttemptRecordV1 | null> {
    const result = await rows(
      this.sql,
      `SELECT account_id,failures,window_started_at,blocked_until,version
         FROM student_portal.auth_attempt WHERE account_id=$1::uuid`,
      [accountId],
    );
    const row = result[0];
    return row ? {
      accountId: text(row.account_id, 'account-id'),
      failures: integer(row.failures, 'failures'),
      windowStartedAt: instant(row.window_started_at, 'window-started-at'),
      blockedUntil: nullableInstant(row.blocked_until, 'blocked-until'),
      version: integer(row.version, 'attempt-version'),
    } : null;
  }

  async saveAttempts(record: AttemptRecordV1): Promise<void> {
    await rows(
      this.sql,
      `INSERT INTO student_portal.auth_attempt(account_id,failures,window_started_at,blocked_until,version)
       VALUES ($1::uuid,$2,$3::timestamptz,$4::timestamptz,$5)
       ON CONFLICT (account_id) DO UPDATE SET
         failures=EXCLUDED.failures,window_started_at=EXCLUDED.window_started_at,
         blocked_until=EXCLUDED.blocked_until,version=EXCLUDED.version`,
      [record.accountId, record.failures, record.windowStartedAt, record.blockedUntil, record.version],
    );
  }

  async readIdempotency(key: string, actorId: string): Promise<IdempotencyRecordV1 | null> {
    const result = await rows(
      this.sql,
      `SELECT idempotency_key,actor_id,request_digest,operation_id,version,expires_at
         FROM student_portal.operation_receipt
        WHERE idempotency_key=$1 AND actor_id=$2`,
      [key, actorId],
    );
    const row = result[0];
    return row ? {
      key: text(row.idempotency_key, 'idempotency-key'),
      actorId: text(row.actor_id, 'actor-id'),
      requestDigest: text(row.request_digest, 'request-digest'),
      operationId: text(row.operation_id, 'operation-id'),
      version: integer(row.version, 'receipt-version'),
      expiresAt: instant(row.expires_at, 'receipt-expires-at'),
    } : null;
  }

  async saveIdempotency(record: IdempotencyRecordV1): Promise<void> {
    await rows(
      this.sql,
      `INSERT INTO student_portal.operation_receipt
         (idempotency_key,actor_id,request_digest,operation_id,version,expires_at)
       VALUES ($1,$2,$3,$4::uuid,$5,$6::timestamptz)
       ON CONFLICT (idempotency_key,actor_id) DO NOTHING`,
      [record.key, record.actorId, record.requestDigest, record.operationId, record.version, record.expiresAt],
    );
  }

  async appendAudit(event: Parameters<typeof auditEventV1.parse>[0]): Promise<void> {
    const parsed = auditEventV1.parse(event);
    // detail_json (migration 0023) is written only when there is a detail to keep.
    const detail = parsed.detail && Object.keys(parsed.detail).length ? JSON.stringify(parsed.detail) : null;
    await rows(
      this.sql,
      `INSERT INTO student_portal.audit_event
         (event_id,occurred_at,actor_id,account_id,scope_json,kind,result,request_id,version,masked_ip,raw_ip,ip_expires_at${detail ? ',detail_json' : ''})
       SELECT $1::uuid,$2::text::timestamptz,$3::uuid,$4::uuid,$5::text::jsonb,$6,$7,$8::uuid,$9,
         COALESCE(${AUDIT_IP_MASK_V1},$10),client_ip,
         CASE WHEN client_ip IS NOT NULL THEN $2::text::timestamptz+interval '90 days' END${detail ? ',$11::text::jsonb' : ''} FROM ${AUDIT_IP_SOURCE_V1}`,
      [parsed.eventId, parsed.at, parsed.actorId, parsed.accountId, JSON.stringify(parsed.scope), parsed.kind, parsed.result, parsed.requestId, parsed.version, parsed.maskedIp, ...(detail ? [detail] : [])],
    );
  }

  async compareAndSetSettings(settings: EffectiveSettingsV1, expectedVersion: number): Promise<boolean> {
    this.requireYearWriter();
    const parsed = effectiveSettingsV1.parse(settings);
    const key = scopeKey(parsed.scope);
    const existing = await rows(this.sql, 'SELECT field_key,version FROM student_portal.setting WHERE scope_key=$1 FOR UPDATE', [key]);
    if (existing.length === 0 ? expectedVersion !== 0 : existing.some((row) => integer(row.version, 'setting-version') !== expectedVersion)) return false;
    await rows(this.sql, 'DELETE FROM student_portal.setting WHERE scope_key=$1', [key]);
    const [kind, year, classId, accountId] = scopeColumns(parsed.scope);
    const fields = ['accessEnabled','accessSchedule','showPartials','autoUpdate','showFinalResult','showTermClosing','termClosingConclusive','showFrequency','allowedPeriods','risk','calendar'] as const;
    for (const field of fields) {
      // No schedule is stored as no row (migration 0021 may not be applied yet).
      if (field === 'accessSchedule' && parsed.value.accessSchedule === null) continue;
      // Hidden frequency is also no row (migration 0027 may not be applied yet).
      if (field === 'showFrequency' && !parsed.value.showFrequency) continue;
      await rows(
        this.sql,
        `INSERT INTO student_portal.setting
           (scope_key,field_key,scope_kind,academic_year,class_id,account_id,value_json,source_scope_json,version)
         VALUES ($1,$2,$3,$4,$5,$6::uuid,$7::text::jsonb,$8::text::jsonb,$9)`,
        [key, field, kind, year, classId, accountId, JSON.stringify(parsed.value[field]), JSON.stringify(parsed.sources[field]), parsed.version],
      );
    }
    return true;
  }

  async closeAcademicLinks(year: 2026, expectedCount: number, closedAt: string): Promise<number> {
    await this.lockAcademicYear(year);
    const linked = await rows(
      this.sql,
      `SELECT id,gradebook_student_id,version FROM student_portal.account
        WHERE academic_year=$1 AND gradebook_student_id IS NOT NULL AND closed_at IS NULL
        ORDER BY id FOR UPDATE`,
      [year],
    );
    if (linked.length !== expectedCount) throw new Error('student-portal-link-count-conflict');
    if (linked.length === 0) return 0;
    const studentIds: number[] = [];
    for (const row of linked) {
      const accountId = text(row.id, 'account-id');
      const studentId = integer(row.gradebook_student_id, 'student-id');
      const version = integer(row.version, 'account-version') + 1;
      studentIds.push(studentId);
      await rows(
        this.sql,
        `INSERT INTO student_portal.link_closure
           (account_id,academic_year,gradebook_student_id,closed_at,version)
         VALUES ($1::uuid,$2,$3,$4::timestamptz,$5)`,
        [accountId, year, studentId, closedAt, version],
      );
      await rows(
        this.sql,
        `UPDATE student_portal.account
            SET gradebook_student_id=NULL,eligibility='unlinked',closed_at=$1::timestamptz,
                version=$2,security_version=security_version+1,updated_at=now()
          WHERE id=$3::uuid`,
        [closedAt, version, accountId],
      );
      await rows(
        this.sql,
        `UPDATE student_portal.session SET revoked_at=$1::timestamptz
          WHERE account_id=$2::uuid AND revoked_at IS NULL`,
        [closedAt, accountId],
      );
      await rows(
        this.sql,
        `UPDATE student_portal.auth_challenge SET consumed_at=$1::timestamptz
          WHERE account_id=$2::uuid AND consumed_at IS NULL`,
        [closedAt, accountId],
      );
    }
    await bumpPortalLinkRevision(this.sql, studentIds);
    return linked.length;
  }

  async appendRevision(event: RevisionEventV1): Promise<void> {
    this.requireYearWriter();
    const state = await rows(
      this.sql,
      `SELECT academic_generation,academic_counter,reset_generation,reset_counter,
              portal_link_generation,portal_link_counter
         FROM student_portal.academic_revision WHERE academic_year=$1 FOR UPDATE`,
      [event.academicYear],
    );
    const current = state[0];
    if (!current) throw new Error('student-portal-revision-state-missing');
    const dataVersion = `${text(current.academic_generation, 'academic-generation')}:${String(current.academic_counter)}`;
    if (dataVersion !== event.dataVersion) throw new Error('student-portal-academic-revision-conflict');
    const resetVersion = `${text(current.reset_generation, 'reset-generation')}:${String(current.reset_counter)}`;
    const portalLinkVersion = `${text(current.portal_link_generation, 'portal-link-generation')}:${String(current.portal_link_counter)}`;
    await rows(
      this.sql,
      `INSERT INTO student_portal.revision_event
         (event_id,academic_year,student_ids,cause,affects_academic,affects_reset,
          data_version,reset_version,portal_link_version,occurred_at)
       VALUES ($1::uuid,$2,$3::integer[],$4,true,true,$5,$6,$7,$8::timestamptz)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.academicYear, [...event.studentIds], event.cause, event.dataVersion, resetVersion, portalLinkVersion, event.occurredAt],
    );
  }

  async enqueuePublication(job: PublicationJobV1): Promise<'created' | 'existing'> {
    const inserted = await rows(
      this.sql,
      `INSERT INTO student_portal.publication_job
         (id,account_id,data_version,policy_version,publication_version,state,attempts,next_attempt_at,lease_until)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz)
       ON CONFLICT (account_id,data_version,policy_version,publication_version) DO NOTHING
       RETURNING id`,
      [job.id, job.accountId, job.target.dataVersion, job.target.policyVersion, job.target.publicationVersion, job.state, job.attempts, job.nextAttemptAt, job.leaseUntil],
    );
    return inserted[0] ? 'created' : 'existing';
  }
}

export class StudentPortalPostgresPersistenceV1 implements PersistencePortV1 {
  constructor(private readonly sql: StudentPortalPostgresSqlV1) {}

  async transaction<T>(operation: (tx: PortalTransactionV1) => Promise<T>): Promise<T> {
    return this.sql.begin(async (transactionSql) => operation(new StudentPortalTransaction(transactionSql)));
  }

  async findSessionByHash(hash: string): Promise<SessionRecordV1 | null> {
    const result = await rows(
      this.sql,
      `SELECT id,account_id,token_hash,security_version,expires_at,revoked_at,persistent
         FROM student_portal.session WHERE token_hash=$1`,
      [hash],
    );
    return result[0] ? sessionFromRow(result[0]) : null;
  }
}

export function createStudentPortalPostgresPersistenceV1(sql: StudentPortalPostgresSqlV1): PersistencePortV1 {
  return new StudentPortalPostgresPersistenceV1(sql);
}
