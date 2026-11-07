import type { PlatformCapability } from '../../shared/platform-contract';
import { capabilitiesForRoles, requireCapability } from '../auth/capabilities';
import type { Session } from '../auth/session';

export const GRADEBOOK_ADMIN_CAPABILITY =
  'gradebook.persistence.admin' satisfies PlatformCapability;

declare const gradebookRuntimeAuthorizationBrand: unique symbol;

export type GradebookRuntimeAuthorizationV1 = Readonly<{
  [gradebookRuntimeAuthorizationBrand]: true;
}>;

const issuedAuthorizations = new WeakSet<object>();

export function authorizeGradebookRuntimeV1(
  session: Pick<Session, 'roles'>,
): GradebookRuntimeAuthorizationV1 {
  requireCapability(capabilitiesForRoles(session.roles), GRADEBOOK_ADMIN_CAPABILITY);
  const authorization = Object.freeze({});
  issuedAuthorizations.add(authorization);
  return authorization as GradebookRuntimeAuthorizationV1;
}
