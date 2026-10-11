// Synthetic historical fixture only. Production has no manual birth writer.
import { z } from 'zod';
import { ENROLLED_ACCOUNT_SQL_V1 } from '../../../server/student-portal/admin/queries-v1';
import { adminCommandV1, birthWriteV1, savedBirthV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { versionV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { CryptoPortV1, PortalTransactionV1 } from '../../../shared/student-portal-contracts/ports-v1';
import { StudentPortalPostgresPersistenceV1, type StudentPortalPostgresQueryV1, type StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';

type Item = z.infer<typeof birthWriteV1>;
type ItemState = 'committed' | 'conflict' | 'forbidden' | 'unavailable';
type ItemResult = { accountId: string; state: ItemState; version: number };
type BatchReceipt = { operationId: string; expiresAt: string };

async function legacyBirthCasV1(tx: StudentPortalPostgresQueryV1,
  record: {accountId: string; year: string | null; confirmation: string | null; version: number}, expected: number) {
  const rows = await tx.unsafe(`INSERT INTO student_portal.account_access_data(account_id,birth_year,confirmation,version)
    VALUES($1::uuid,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET birth_year=EXCLUDED.birth_year,
    confirmation=EXCLUDED.confirmation,version=EXCLUDED.version WHERE student_portal.account_access_data.version=$5
    RETURNING account_id`,[record.accountId,record.year===null?null:Number(record.year),record.confirmation,record.version,expected]);
  return rows.length===1;
}

function canonical(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
  if (input !== null && typeof input === 'object') return `{${Object.entries(input).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(',')}}`;
  return JSON.stringify(input);
}

async function digest(input: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(input))));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function persistence(tx: StudentPortalPostgresQueryV1) {
  return new StudentPortalPostgresPersistenceV1({ unsafe: (query, parameters) => tx.unsafe(query, parameters), begin: (operation) => operation(tx) });
}

async function now(tx: StudentPortalPostgresQueryV1): Promise<Date> {
  const rows = await tx.unsafe('SELECT statement_timestamp() AS now');
  const value = rows[0]?.now;
  const date = value instanceof Date ? value : new Date(z.string().parse(value));
  if (!Number.isFinite(date.getTime())) throw new Error('student-portal-birth-clock-unavailable');
  return date;
}

async function scopeVersion(tx: StudentPortalPostgresQueryV1): Promise<number> {
  const rows = await tx.unsafe(`SELECT (academic_counter+portal_link_counter)::text AS version
    FROM student_portal.academic_revision WHERE academic_year=2026`);
  if (rows.length !== 1) throw new Error('student-portal-birth-scope-unavailable');
  return versionV1.parse(Number(rows[0]!.version));
}

async function currentClass(tx: StudentPortalPostgresQueryV1, accountId: string): Promise<number | null> {
  const rows = await tx.unsafe(`SELECT min(b.class_id) AS class_id,count(*)::integer AS matches
    FROM student_portal.account a JOIN student_portal.academic_binding_v1 b
      ON b.student_id=a.gradebook_student_id AND b.academic_year=a.academic_year
    WHERE a.id=$1::uuid AND a.academic_year=2026 AND a.closed_at IS NULL AND b.status IS DISTINCT FROM 6`, [accountId]);
  return rows[0]?.matches === 1 ? z.number().int().positive().parse(rows[0].class_id) : null;
}

/** Private administrative primitive. The caller supplies the authenticated/authorized actor. */
export class BirthYearServiceV1 {
  constructor(private readonly sql: StudentPortalPostgresSqlV1, private readonly cryptoPort: CryptoPortV1,
    private readonly pepperVersion: number, private readonly batchDerivations = 1) {
    z.number().int().positive().safe().parse(pepperVersion);
    // Sequential derivations preserve the existing KDF strength and peak memory footprint.
    // Production opts into four with its larger CPU allowance; legacy callers keep one.
    z.number().int().min(1).max(4).parse(batchDerivations);
  }

  /** Internal keyset page; the admin facade owns its opaque, scoped, expiring HTTP cursor. */
  async readClass(classId: number, limit = 50, afterAccountId?: string) {
    z.number().int().positive().safe().parse(classId);
    z.number().int().min(1).max(100).parse(limit);
    const after = afterAccountId === undefined ? null : z.uuid().parse(afterAccountId).toLowerCase();
    return this.sql.begin(async (tx) => persistence(tx).transaction(async (store) => {
      await store.lockAcademicYear(2026);
      const version = await scopeVersion(tx);
      const rows = await tx.unsafe(`SELECT a.id AS account_id,s.name,a.version::text AS account_version,
        d.birth_year,d.confirmation,COALESCE(d.version,0)::text AS birth_version
        FROM student_portal.account a JOIN student_portal.academic_student_v1 s
          ON s.student_id=a.gradebook_student_id AND s.academic_year=a.academic_year
        JOIN LATERAL (SELECT min(class_id) AS class_id,count(*)::integer AS matches
          FROM student_portal.academic_binding_v1 WHERE student_id=a.gradebook_student_id
          AND academic_year=2026 AND status IS DISTINCT FROM 6) b ON b.matches=1 AND b.class_id=$1
        LEFT JOIN student_portal.account_access_data d ON d.account_id=a.id
        WHERE a.academic_year=2026 AND a.closed_at IS NULL AND ${ENROLLED_ACCOUNT_SQL_V1}
          AND ($2::uuid IS NULL OR a.id>$2::uuid)
        ORDER BY a.id LIMIT $3`, [classId, after, limit + 1]);
      const items = rows.slice(0, limit).map((row) => ({
        accountId: z.uuid().parse(row.account_id), name: z.string().max(200).parse(row.name),
        accountVersion: versionV1.parse(Number(row.account_version)), version: versionV1.parse(Number(row.birth_version)),
        year: row.birth_year === null ? null : String(row.birth_year),
        confirmation: z.enum(['confirmed', 'unconfirmed-test']).nullable().parse(row.confirmation),
      }));
      return { scopeVersion: version, items, nextAccountId: rows.length > limit ? items.at(-1)!.accountId : null };
    }));
  }

  async write(actorId: string, input: unknown) {
    const actor = z.uuid().parse(actorId).toLowerCase();
    const command = adminCommandV1.parse(input);
    if (command.operation !== 'birth-write') throw new Error('student-portal-birth-command-invalid');
    const item = { ...command.item, accountId: command.item.accountId.toLowerCase() };
    const requestDigest = await digest({ ...command, item });
    return this.sql.begin(async (tx) => persistence(tx).transaction(async (store) => {
      await store.lockAcademicYear(2026);
      await store.lockAccounts([item.accountId]);
      const clock = await now(tx);
      const receiptActor = `birth-write:${actor}`;
      const savedValue = async (version: number) => {
        if (!command.includeSavedBirth) return {};
        const current = await store.findAccount(item.accountId);
        if (!current?.link || current.closedAt !== null || current.version !== version) return {};
        const birth = await store.readBirth(current.id);
        const classId = await currentClass(tx, current.id);
        if (!birth || classId === null) return {};
        return { savedBirth: savedBirthV1.parse({ accountId: current.id, classId,
          accountVersion: current.version, version: birth.version, year: birth.year,
          confirmation: birth.confirmation }) };
      };
      const receipt = await store.readIdempotency(command.idempotencyKey, receiptActor);
      if (receipt && Date.parse(receipt.expiresAt) > clock.getTime()) {
        if (receipt.requestDigest !== requestDigest) throw new Error('student-portal-birth-idempotency-conflict');
        return { operationId: receipt.operationId, version: receipt.version, ...await savedValue(receipt.version) };
      }
      if (receipt) await tx.unsafe('DELETE FROM student_portal.operation_receipt WHERE idempotency_key=$1 AND actor_id=$2', [command.idempotencyKey, receiptActor]);
      const account = await store.findAccount(item.accountId);
      if (!account?.link || account.closedAt !== null || await currentClass(tx, item.accountId) === null) throw new Error('student-portal-birth-forbidden');
      if (account.version !== command.expectedVersion) throw new Error('student-portal-birth-version-conflict');
      const result = await this.apply(tx, store, actor, command.idempotencyKey, item, clock);
      if (result.state !== 'committed') throw new Error(`student-portal-birth-${result.state}`);
      const operationId = crypto.randomUUID();
      const version = (await store.findAccount(item.accountId))!.version;
      await store.saveIdempotency({ key: command.idempotencyKey, actorId: receiptActor, requestDigest, operationId,
        version, expiresAt: new Date(clock.getTime() + 86400_000).toISOString() });
      // The surrounding begin() resolves only after COMMIT; the HTTP layer awaits write().
      return { operationId, version, ...await savedValue(version) };
    }));
  }

  async batch(actorId: string, input: unknown) {
    const actor = z.uuid().parse(actorId).toLowerCase();
    const parsed = adminCommandV1.parse(input);
    if (parsed.operation !== 'birth-batch') throw new Error('student-portal-birth-command-invalid');
    const command = { ...parsed, items: parsed.items.map((item) => ({ ...item, accountId: item.accountId.toLowerCase() })) };
    if (new Set(command.items.map((item) => item.accountId)).size !== command.items.length) throw new Error('student-portal-birth-duplicate-account');
    const requestDigest = await digest(command);
    const receiptActor = `birth-batch:${actor}`;
    const parent: BatchReceipt = await this.sql.begin(async (tx) => persistence(tx).transaction(async (store) => {
      await store.lockAcademicYear(2026);
      const clock = await now(tx);
      const receipt = await store.readIdempotency(command.idempotencyKey, receiptActor);
      if (receipt && Date.parse(receipt.expiresAt) > clock.getTime()) {
        if (receipt.requestDigest !== requestDigest) throw new Error('student-portal-birth-idempotency-conflict');
        return receipt;
      }
      if (receipt) await tx.unsafe(`DELETE FROM student_portal.operation_receipt WHERE idempotency_key=$1
        AND (actor_id=$2 OR starts_with(actor_id,$2||':'))`, [command.idempotencyKey, receiptActor]);
      if (await scopeVersion(tx) !== command.expectedVersion) throw new Error('student-portal-birth-scope-conflict');
      const created = { key: command.idempotencyKey, actorId: receiptActor, requestDigest, operationId: crypto.randomUUID(),
        version: command.expectedVersion, expiresAt: new Date(clock.getTime() + 86400_000).toISOString() };
      await store.saveIdempotency(created);
      return created;
    }));
    const completed = await this.sql.begin(async (tx) => {
      const rows = await tx.unsafe(`SELECT actor_id,version::text,request_digest FROM student_portal.operation_receipt
        WHERE idempotency_key=$1 AND starts_with(actor_id,$2) AND expires_at>statement_timestamp()
        ORDER BY actor_id LIMIT 101`, [command.idempotencyKey, `${receiptActor}:`]);
      if (rows.length > 100) throw new Error('student-portal-birth-receipt-invalid');
      const result = new Map<string, ItemResult>();
      for (const row of rows) {
        if (row.request_digest !== requestDigest) throw new Error('student-portal-birth-idempotency-conflict');
        const [accountId, state] = String(row.actor_id).slice(receiptActor.length + 1).split(':');
        const account = z.uuid().parse(accountId);
        if (result.has(account)) throw new Error('student-portal-birth-receipt-invalid');
        result.set(account, { accountId: account, state: z.enum(['committed', 'conflict', 'forbidden']).parse(state),
          version: versionV1.parse(Number(row.version)) });
      }
      return result;
    });
    let derivations = 0;
    let attemptedItems = 0;
    const takeKdf = () => {
      if (derivations >= this.batchDerivations) throw new Error('student-portal-birth-budget-unavailable');
      derivations += 1;
    };
    const items: ItemResult[] = [];
    for (const item of command.items) {
      const previous = completed.get(item.accountId);
      if (previous) { items.push(previous); continue; }
      if (attemptedItems >= this.batchDerivations * 2 || derivations >= this.batchDerivations) {
        items.push({ accountId: item.accountId, state: 'unavailable', version: item.expectedVersion });
        continue;
      }
      attemptedItems++;
      try {
        items.push(await this.sql.begin(async (tx) => persistence(tx).transaction(async (store) => {
          await store.lockAcademicYear(2026);
          await store.lockAccounts([item.accountId]);
          const clock = await now(tx);
          if (Date.parse(parent.expiresAt) <= clock.getTime()) throw new Error('student-portal-birth-receipt-expired');
          const prefix = `${receiptActor}:${item.accountId}:`;
          const previous = await tx.unsafe(`SELECT actor_id,version::text,request_digest FROM student_portal.operation_receipt
            WHERE idempotency_key=$1 AND starts_with(actor_id,$2) AND expires_at>statement_timestamp()`, [command.idempotencyKey, prefix]);
          if (previous.length > 1) throw new Error('student-portal-birth-receipt-invalid');
          if (previous.length === 1) {
            if (previous[0]!.request_digest !== requestDigest) throw new Error('student-portal-birth-idempotency-conflict');
            return { accountId: item.accountId, state: z.enum(['committed', 'conflict', 'forbidden']).parse(String(previous[0]!.actor_id).slice(prefix.length)),
              version: versionV1.parse(Number(previous[0]!.version)) };
          }
          let result: ItemResult;
          if (await currentClass(tx, item.accountId) !== command.classId) result = { accountId: item.accountId, state: 'forbidden', version: 0 };
          else if (await scopeVersion(tx) !== command.expectedVersion) result = { accountId: item.accountId, state: 'conflict', version: item.expectedVersion };
          else result = await this.apply(tx, store, actor, command.idempotencyKey, item, clock, takeKdf);
          await store.saveIdempotency({ key: command.idempotencyKey, actorId: prefix + result.state, requestDigest,
            operationId: parent.operationId, version: result.version, expiresAt: parent.expiresAt });
          return result;
        })));
      } catch {
        items.push({ accountId: item.accountId, state: 'unavailable', version: item.expectedVersion });
      }
    }
    return { operationId: parent.operationId, items };
  }

  private async apply(tx: StudentPortalPostgresQueryV1, store: PortalTransactionV1, actor: string, requestId: string, item: Item, clock: Date, takeKdf?: () => void): Promise<ItemResult> {
    const account = await store.findAccount(item.accountId);
    if (!account?.link || account.closedAt !== null) return { accountId: item.accountId, state: 'forbidden', version: 0 };
    const before = await store.readBirth(item.accountId);
    const version = before?.version ?? 0;
    if (version !== item.expectedVersion) return { accountId: item.accountId, state: 'conflict', version };
    const year = item.action === 'set' ? item.year : null;
    const confirmation = item.action === 'set' ? item.confirmation : null;
    if ((before?.year ?? null) === year && (before?.confirmation ?? null) === confirmation) return { accountId: item.accountId, state: 'committed', version };
    if (year !== null) takeKdf?.();
    const verifier = year === null ? null : await this.cryptoPort.deriveVerifier(year, this.pepperVersion);
    const nextVersion = versionV1.parse(version + 1);
    const nextPinVersion = versionV1.parse(account.pinVersion + 1);
    if (!await legacyBirthCasV1(tx, { accountId: item.accountId, year, confirmation, version: nextVersion }, version)) throw new Error('student-portal-birth-version-conflict');
    await tx.unsafe(`INSERT INTO student_portal.password_credential(account_id,pin_verifier,pin_version)
      VALUES ($1::uuid,$2::text::jsonb,$3) ON CONFLICT (account_id) DO UPDATE
      SET pin_verifier=EXCLUDED.pin_verifier,pin_version=EXCLUDED.pin_version,updated_at=statement_timestamp()`,
    [item.accountId, verifier === null ? null : JSON.stringify(verifier), nextPinVersion]);
    if (!await store.compareAndSetAccount({ ...account, version: versionV1.parse(account.version + 1), pinVersion: nextPinVersion }, account.version)) throw new Error('student-portal-birth-version-conflict');
    await tx.unsafe('UPDATE student_portal.auth_challenge SET consumed_at=$1::timestamptz WHERE account_id=$2::uuid AND consumed_at IS NULL', [clock.toISOString(), item.accountId]);
    await store.appendAudit({ eventId: crypto.randomUUID(), at: clock.toISOString(), actorId: actor, accountId: item.accountId,
      scope: { kind: 'account', academicYear: 2026, accountId: item.accountId }, kind: 'birth-changed', result: 'success',
      requestId, version: nextVersion, maskedIp: null });
    return { accountId: item.accountId, state: 'committed', version: nextVersion };
  }
}
