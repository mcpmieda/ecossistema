import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { BirthYearServiceV1 } from '../birth-year/legacy-birth-fixture-v1';

/** Local synthetic baseline: these integration suites exercise access already issued before #1269. */
export async function seedExistingBirthFixtureV1(
  sql: StudentPortalPostgresSqlV1,
  accountId: string,
) {
  const [row] = await sql.unsafe(
    `SELECT a.version::integer AS account_version,COALESCE(d.version,0)::integer AS birth_version
    FROM student_portal.account a LEFT JOIN student_portal.account_access_data d ON d.account_id=a.id WHERE a.id=$1::uuid`,
    [accountId],
  );
  if (!row) throw new Error('synthetic-existing-account-missing');
  const cryptoPort = new PortalCryptoV1(
    new Map([[1, new Uint8Array(32).fill(71)]]),
    new Map([[1, new Uint8Array(32).fill(72)]]),
  );
  const result = await new BirthYearServiceV1(sql, cryptoPort, 1).write(
    '11111111-1111-4111-8111-111111111111',
    {
      contractVersion: 1,
      operation: 'birth-write',
      expectedVersion: row.account_version,
      idempotencyKey: crypto.randomUUID(),
      item: {
        action: 'set',
        accountId,
        expectedVersion: row.birth_version,
        year: '2001',
        confirmation: 'confirmed',
      },
    },
  );
  if (!Number.isSafeInteger(result.version))
    throw new Error('synthetic-existing-birth-unavailable');
}
