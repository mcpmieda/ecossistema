import { describe, expect, it } from 'vitest';
import {
  AUDIT_REASON_LABELS_V1,
  auditDetailRowsV1,
  auditReasonLineV1,
} from '../../../../src/features/student-portal-admin/audit/audit-reasons-v1';

describe('audit refusal reason labels (#1207)', () => {
  it('shows a neutral label for a retry, without claiming the data changed', () => {
    expect(auditReasonLineV1({ reason: 'retry-needed', step: 'create' })).toBe(
      'Nova tentativa necessária',
    );
    expect(auditDetailRowsV1({ reason: 'retry-needed', step: 'create' }, (value) => value)).toEqual(
      [
        { label: 'Motivo', value: 'Nova tentativa necessária' },
        { label: 'Como orientar', value: 'Ler o cartão novamente.' },
        { label: 'Etapa', value: 'Criação da senha' },
      ],
    );
    expect(JSON.stringify(AUDIT_REASON_LABELS_V1)).not.toContain('Dados alterados');
  });

  it('keeps the expired deadline label for a proven expiry at the PIN step', () => {
    expect(auditReasonLineV1({ reason: 'password-window-expired', step: 'pin' })).toBe(
      'Prazo para criar a senha esgotado',
    );
    expect(
      auditDetailRowsV1({ reason: 'password-window-expired', step: 'pin' }, (value) => value),
    ).toContainEqual({
      label: 'Etapa',
      value: 'PIN',
    });
  });
});
