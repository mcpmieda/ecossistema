import { describe, expect, it } from 'vitest';
import { sameStudentNameV1 } from '../../../server/gradebook/onedrive-sync/server-audit-v1';

describe('student name check against the Relação (rule 14)', () => {
  it('accepts the same person written differently', () => {
    expect(sameStudentNameV1('Maria Sintética da Silva', 'MARIA SINTETICA DA SILVA')).toBe(true);
    expect(sameStudentNameV1('MARIA S. SILVA', 'MARIA SOUZA SILVA')).toBe(true);
    expect(sameStudentNameV1('MARIA SILVA', 'MARIA SOUZA SILVA')).toBe(true);
    expect(sameStudentNameV1('MARIA SOUZA S.', 'MARIA SOUZA SILVA')).toBe(true);
    expect(sameStudentNameV1('MARIA', 'MARIA SOUZA SILVA')).toBe(true);
  });

  it('flags another person', () => {
    expect(sameStudentNameV1('JOÃO SINTÉTICO SILVA', 'MARIA SOUZA SILVA')).toBe(false);
    expect(sameStudentNameV1('MARIA SOUZA COSTA', 'MARIA SOUZA SILVA')).toBe(false);
  });

  it('does not judge an empty name', () => {
    expect(sameStudentNameV1('', 'MARIA SOUZA SILVA')).toBe(true);
  });
});
