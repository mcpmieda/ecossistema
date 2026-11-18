import type { AccessArea } from './platform-contract';

/** Configurações › Acessos (#1513). */
export const ACCESS_PATH_V1 = '/api/platform/access';

export type AccessGrantViewV1 = {
  /** The person's Entra id: the grant follows the person, not the sign-in name (#1530 A3). */
  id: string;
  /** The sign-in name when the grant was saved, to show. */
  email: string;
  areas: AccessArea[];
  updatedAt: string;
  updatedBy: string | null;
};

/** One grant, change or removal, newest first (#1530 A5). */
export type AccessGrantChangeViewV1 = {
  at: string;
  actor: string;
  email: string;
  before: AccessArea[];
  after: AccessArea[];
};

export type AccessGrantsResponseV1 = {
  contractVersion: 1;
  grants: AccessGrantViewV1[];
  history: AccessGrantChangeViewV1[];
};

/**
 * PUT: opens the areas to the account with this sign-in name or e-mail; no area removes the grant.
 * `expectedUpdatedAt` is the version edited, so a change made meanwhile is not overwritten.
 */
export type AccessGrantChangeRequestV1 = {
  email: string;
  areas: AccessArea[];
  expectedUpdatedAt?: string;
};

/**
 * - `account-not-found`: no single Entra account has that sign-in name or e-mail;
 * - `changed`: someone else changed this grant meanwhile.
 */
export type AccessFailureStateV1 =
  'invalid-request' | 'refused' | 'account-not-found' | 'changed' | 'unavailable';
