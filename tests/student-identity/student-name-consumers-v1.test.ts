// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { accountSummaryV1, printCardV1, auditEventV1 } from '../../shared/student-portal-contracts/admin-v1';
import { bulkPreviewItemV1 } from '../../shared/student-portal-contracts/bulk-v1';
import { selfResponseV1 } from '../../shared/student-portal-contracts/self-v1';
import { academicStudentSchemaV1 } from '../../shared/gradebook-contracts/student-portal/academic-student-reader-v1';
import { reportRowV1 } from '../../shared/student-identity/reconciliation-v1';

describe('complete report names reach student consumers without truncation', () => {
  const names = [
    reportRowV1.shape.name,
    accountSummaryV1.shape.name,
    printCardV1.options[1].shape.name,
    printCardV1.options[2].shape.name,
    bulkPreviewItemV1.shape.name,
    selfResponseV1.shape.profile.shape.name,
    academicStudentSchemaV1.shape.profile.shape.name,
    auditEventV1.shape.entities.unwrap().shape.subjectName,
  ];
  it.each([200, 201, 300])('preserves every character of a %i-character synthetic name', (length) => {
    const name = 'N'.repeat(length);
    for (const schema of names) expect(schema.parse(name)).toBe(name);
    const account = accountSummaryV1.parse({
      accountId: '11111111-1111-4111-8111-111111111111', link: { academicYear: 2026, studentId: 1 },
      name, classLabel: 'Synthetic class', state: 'pending-activation', eligibility: 'eligible',
      blocked: false, version: 1,
    });
    expect(account.name).toHaveLength(length);
    for (const mode of ['qr-name', 'qr-name-class'] as const) {
      const card = printCardV1.parse({
        accountId: account.accountId, mode, name,
        qr: `https://aluno.escolaieda.com/access#v1.${'S'.repeat(40)}.1.${'B'.repeat(43)}`,
        ...(mode === 'qr-name-class' ? { classLabel: account.classLabel } : {}),
      });
      expect('name' in card && card.name).toBe(name);
    }
  });
  it('rejects values beyond the report contract rather than truncating them', () => {
    for (const schema of names) expect(schema.safeParse('N'.repeat(301)).success).toBe(false);
  });
});
