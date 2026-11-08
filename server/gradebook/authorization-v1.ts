import type { PlatformCapability } from '../../shared/platform-contract';
import { capabilitiesForRoles, requireCapability } from '../auth/capabilities';
import type { Session } from '../auth/session';

export const GRADEBOOK_ADMIN_CAPABILITY =
  'gradebook.persistence.admin' satisfies PlatformCapability;

declare const gradebookRuntimeAuthorizationBrand: unique symbol;

export type GradebookRuntimeAuthorizationV1 = Readonly<{
  [gradebookRuntimeAuthorizationBrand]: true;
}>;

export function authorizeGradebookRuntimeV1(
  session: Pick<Session, 'roles'>,
): GradebookRuntimeAuthorizationV1 {
  requireCapability(capabilitiesForRoles(session.roles), GRADEBOOK_ADMIN_CAPABILITY);
  return Object.freeze({}) as GradebookRuntimeAuthorizationV1;
}
