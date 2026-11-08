// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AuthorizationError, hasRole, requireRole, rolesForGroups } from '../server/auth/roles';
import { testEnv } from './fixtures';

describe('institutional role mapping', () => {
  it('maps Secretaria to ADMINISTRADOR', () =>
    expect(rolesForGroups([testEnv.GROUP_ADMIN_ID], testEnv)).toEqual(['ADMINISTRADOR']));
  it('maps PROFESSORES without admin', () =>
    expect(rolesForGroups([testEnv.GROUP_PROFESSOR_ID], testEnv)).toEqual(['PROFESSOR']));
  it('maps ALUNOS without admin', () =>
    expect(rolesForGroups([testEnv.GROUP_ALUNO_ID], testEnv)).toEqual(['ALUNO']));
  it('maps APOIO', () =>
    expect(rolesForGroups([testEnv.GROUP_APOIO_ID], testEnv)).toEqual(['APOIO']));
  it('maps VISITANTE without admin', () =>
    expect(rolesForGroups([testEnv.GROUP_VISITANTE_ID], testEnv)).toEqual(['VISITANTE']));
  it('returns no role for an unknown group', () =>
    expect(rolesForGroups(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], testEnv)).toEqual([]));
  it('deduplicates roles', () =>
    expect(rolesForGroups([testEnv.GROUP_ALUNO_ID, testEnv.GROUP_ALUNO_ID], testEnv)).toEqual([
      'ALUNO',
    ]));
  it('requires one exact role', () => {
    expect(() => requireRole(['PROFESSOR'], 'ADMINISTRADOR')).toThrow(AuthorizationError);
    expect(hasRole(['PROFESSOR'], 'PROFESSOR')).toBe(true);
  });
});
