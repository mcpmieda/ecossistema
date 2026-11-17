import type { AccessArea, PlatformCapability } from '../../shared/platform-contract';
import { capabilitiesForSession, requireAnyArea, requireCapability } from '../auth/capabilities';
import type { Session } from '../auth/session';

export const GRADEBOOK_ADMIN_CAPABILITY =
  'gradebook.persistence.admin' satisfies PlatformCapability;

/**
 * Who may call a gradebook route (#1513): the areas that use it, or 'admin' for what stays with
 * ADMINISTRADOR (the year settings and the assessment names).
 */
export type GradebookAccessV1 = 'admin' | readonly AccessArea[];
export const GRADEBOOK_READING_AREAS_V1: readonly AccessArea[] = ['desempenho', 'importacao'];

declare const gradebookRuntimeAuthorizationBrand: unique symbol;

export type GradebookRuntimeAuthorizationV1 = Readonly<{
  [gradebookRuntimeAuthorizationBrand]: true;
}>;

export function authorizeGradebookRuntimeV1(
  session: Pick<Session, 'roles' | 'areas'>,
  access: GradebookAccessV1 = 'admin',
): GradebookRuntimeAuthorizationV1 {
  const capabilities = capabilitiesForSession(session);
  if (access === 'admin') requireCapability(capabilities, GRADEBOOK_ADMIN_CAPABILITY);
  else requireAnyArea(capabilities, access);
  return Object.freeze({}) as GradebookRuntimeAuthorizationV1;
}
