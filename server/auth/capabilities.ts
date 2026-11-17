import {
  ACCESS_AREA_IDS,
  areaCapabilityV1,
  type AccessArea,
  type PlatformCapability,
} from '../../shared/platform-contract';
import { AuthorizationError, type Role } from './roles';

export const capabilityGrantsByRole: Record<Role, readonly PlatformCapability[]> = {
  ADMINISTRADOR: [
    'platform.snapshot.read',
    'platform.health.read',
    'platform.audit.read',
    'platform.settings.read',
    'platform.settings.write',
    'gradebook.persistence.admin',
    ...ACCESS_AREA_IDS.map(areaCapabilityV1),
  ],
  PROFESSOR: [],
  ALUNO: [],
  APOIO: [],
  VISITANTE: [],
};

export function capabilitiesForRoles(roles: readonly Role[]): PlatformCapability[] {
  return [...new Set(roles.flatMap((role) => capabilityGrantsByRole[role]))];
}

/**
 * The role's capabilities plus the areas an administrator opened to this person (#1513). An area
 * also lets the person open the Centro itself (the module catalog).
 */
export function capabilitiesForSession(session: {
  readonly roles: readonly Role[];
  readonly areas?: readonly AccessArea[];
}): PlatformCapability[] {
  const areas = session.areas ?? [];
  const granted: PlatformCapability[] =
    areas.length > 0 ? ['platform.snapshot.read', ...areas.map(areaCapabilityV1)] : [];
  return [...new Set([...capabilitiesForRoles(session.roles), ...granted])];
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

/** At least one of the areas, or the full administrator. */
export function requireAnyArea(
  capabilities: readonly PlatformCapability[],
  areas: readonly AccessArea[],
): void {
  if (!areas.some((area) => capabilities.includes(areaCapabilityV1(area))))
    throw new AuthorizationError();
}
