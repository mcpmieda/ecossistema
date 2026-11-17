import type { AccessArea } from './platform-contract';

/** Configurações › Acessos (#1513). */
export const ACCESS_PATH_V1 = '/api/platform/access';

export type AccessGrantViewV1 = {
  email: string;
  areas: AccessArea[];
  updatedAt: string;
  updatedBy: string | null;
};

export type AccessGrantsResponseV1 = { contractVersion: 1; grants: AccessGrantViewV1[] };
