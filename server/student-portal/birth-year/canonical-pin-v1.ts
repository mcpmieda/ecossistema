import type { CryptoPortV1 } from '../../../shared/student-portal-contracts/ports-v1';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';

/** Called only by an authorized QR issue under the existing year/account locks. */
export async function ensureCanonicalPinV1(
  tx: StudentPortalPostgresQueryV1,
  cryptoPort: CryptoPortV1,
  pepperVersion: number,
  accountId: string,
  pinVersion: number,
): Promise<boolean> {
  const [row] = await tx.unsafe(
    `SELECT d.birth_year,d.confirmation,d.source,p.pin_verifier,p.pin_version
    FROM student_portal.account_birth_v1 d LEFT JOIN student_portal.password_credential p ON p.account_id=d.account_id
    WHERE d.account_id=$1::uuid`,
    [accountId],
  );
  if (row?.pin_verifier != null) return Number(row.pin_version) === pinVersion;
  if (
    !row ||
    row.confirmation !== 'confirmed' ||
    !['profile', 'report'].includes(String(row.source)) ||
    row.birth_year == null
  )
    return false;
  const verifier = await cryptoPort.deriveVerifier(String(row.birth_year), pepperVersion);
  const written = await tx.unsafe(
    `INSERT INTO student_portal.password_credential(account_id,pin_verifier,pin_version)
    VALUES($1::uuid,$2::text::jsonb,$3) ON CONFLICT(account_id) DO UPDATE
    SET pin_verifier=EXCLUDED.pin_verifier,pin_version=EXCLUDED.pin_version,updated_at=statement_timestamp()
    WHERE student_portal.password_credential.pin_verifier IS NULL RETURNING account_id`,
    [accountId, JSON.stringify(verifier), pinVersion],
  );
  return written.length === 1;
}
