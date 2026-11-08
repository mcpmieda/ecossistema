import type { RuntimeEnv } from '../env';

export const roles = ['ADMINISTRADOR', 'PROFESSOR', 'ALUNO', 'APOIO', 'VISITANTE'] as const;
export type Role = (typeof roles)[number];

export function rolesForGroups(groups: readonly string[], env: RuntimeEnv): Role[] {
  const mapping = new Map<string, Role>([
    [env.GROUP_ADMIN_ID, 'ADMINISTRADOR'],
    [env.GROUP_PROFESSOR_ID, 'PROFESSOR'],
    [env.GROUP_ALUNO_ID, 'ALUNO'],
    [env.GROUP_APOIO_ID, 'APOIO'],
    [env.GROUP_VISITANTE_ID, 'VISITANTE'],
  ]);
  return [
    ...new Set(
      groups.map((group) => mapping.get(group)).filter((role): role is Role => Boolean(role)),
    ),
  ];
}

export function hasRole(userRoles: readonly Role[], role: Role): boolean {
  return userRoles.includes(role);
}

export function requireRole(userRoles: readonly Role[], role: Role): void {
  if (!hasRole(userRoles, role)) throw new AuthorizationError();
}

export class AuthorizationError extends Error {
  readonly status = 403;
  constructor() {
    super('Forbidden');
  }
}
