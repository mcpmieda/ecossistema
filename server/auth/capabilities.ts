import type { PlatformCapability } from '../../shared/platform-contract';
import { AuthorizationError, type Role } from './roles';

export const capabilityGrantsByRole: Record<Role, readonly PlatformCapability[]> = {
  ADMINISTRADOR: [
    'platform.snapshot.read',
    'platform.health.read',
    'platform.audit.read',
    'platform.settings.read',
    'platform.settings.write',
    'gradebook.persistence.admin',
  ],
  PROFESSOR: [],
  ALUNO: [],
  APOIO: [],
  VISITANTE: [],
};

export function capabilitiesForRoles(roles: readonly Role[]): PlatformCapability[] {
  return [...new Set(roles.flatMap((role) => capabilityGrantsByRole[role]))];
}

export function hasCapability(
  capabilities: readonly PlatformCapability[],
  capability: PlatformCapability,
): boolean {
  return capabilities.includes(capability);
}

export function requireCapability(
  capabilities: readonly PlatformCapability[],
  capability: PlatformCapability,
): void {
  if (!hasCapability(capabilities, capability)) throw new AuthorizationError();
}
