import { z } from 'zod';
import { GraphError } from '../graph/request-policy-v1';

const DIRECTORY_WINDOW_MS = 300_000;
export const collectorGrantBindingV1 = z
  .object({
    tenantId: z.string().uuid(),
    clientId: z.string().uuid(),
    actorId: z.string().uuid(),
    grantId: z.string().uuid(),
    generation: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    originAuthenticatedAt: z.number().int().positive(),
  })
  .strict();
export type CollectorGrantBindingV1 = z.infer<typeof collectorGrantBindingV1>;
const directoryUser = z.object({
  id: z.string().uuid(),
  accountEnabled: z.boolean(),
  signInSessionsValidFromDateTime: z.string().datetime({ offset: true }),
});
const memberships = z.object({ value: z.array(z.string().uuid()).max(1) });

export type CollectorDirectoryEvidenceV1 = Readonly<{
  tenantId: string;
  actorId: string;
  grantId: string;
  grantGeneration: number;
  originAuthenticatedAt: number;
  directoryCheckedAt: number;
  directoryValidUntil: number;
}>;
export class CollectorDirectoryErrorV1 extends Error {
  constructor(readonly reason: 'access-denied' | 'unavailable') {
    super('collector-directory-' + reason);
  }
}
export type CollectorDirectoryDependenciesV1 = {
  now: () => number;
  /** A Microsoft Graph read with the server's own identity (the Graph Backend app: User.Read.All
   * and GroupMember.ReadWrite.All). No credential of the person is asked for or kept. */
  graph: (input: { path: string; method?: 'GET' | 'POST'; body?: unknown }) => Promise<unknown>;
};

function valid(
  binding: CollectorGrantBindingV1,
  evidence: CollectorDirectoryEvidenceV1,
  now: number,
): boolean {
  return (
    evidence.tenantId === binding.tenantId &&
    evidence.actorId === binding.actorId &&
    evidence.grantId === binding.grantId &&
    evidence.grantGeneration === binding.generation &&
    evidence.originAuthenticatedAt === binding.originAuthenticatedAt &&
    Number.isSafeInteger(evidence.directoryCheckedAt) &&
    evidence.directoryCheckedAt <= now &&
    evidence.directoryValidUntil === evidence.directoryCheckedAt + DIRECTORY_WINDOW_MS &&
    now < evidence.directoryValidUntil
  );
}

/** Evidence is checked independently of a local device/session revocation read.
 * The lease may never extend beyond directoryValidUntil, even at the cache edge. */
export function collectorLeaseExpiryV1(
  binding: CollectorGrantBindingV1,
  evidence: CollectorDirectoryEvidenceV1,
  now: number,
  leaseMs = DIRECTORY_WINDOW_MS,
): number {
  if (
    !valid(binding, evidence, now) ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1 ||
    leaseMs > DIRECTORY_WINDOW_MS
  )
    throw new CollectorDirectoryErrorV1('access-denied');
  return Math.min(now + leaseMs, evidence.directoryValidUntil);
}

/**
 * The person behind a collector grant, read in the directory by the server itself: the account
 * exists and is enabled, its sign-ins were not revoked after the grant was authorized, and it is a
 * member of the admin group (the Secretaria). Only these answers end a grant; a failed or
 * malformed read is an outage and ends nothing.
 */
export async function readCollectorDirectoryV1(input: {
  binding: CollectorGrantBindingV1;
  expectedTenantId: string;
  expectedClientId: string;
  adminGroupId: string;
  dependencies: CollectorDirectoryDependenciesV1;
}): Promise<CollectorDirectoryEvidenceV1> {
  const { dependencies } = input;
  let stage = 'validate-binding';
  try {
    const binding = collectorGrantBindingV1.parse(input.binding);
    const group = z.string().uuid().parse(input.adminGroupId).toLowerCase();
    if (binding.tenantId !== input.expectedTenantId || binding.clientId !== input.expectedClientId)
      throw new CollectorDirectoryErrorV1('access-denied');
    const directoryCheckedAt = dependencies.now();
    const person = `/users/${binding.actorId.toLowerCase()}`;
    stage = 'read-user';
    let user: z.infer<typeof directoryUser>;
    try {
      user = directoryUser.parse(
        await dependencies.graph({
          path: `${person}?$select=id,accountEnabled,signInSessionsValidFromDateTime`,
        }),
      );
    } catch (error) {
      // Entra has no such account any more.
      if (error instanceof GraphError && error.status === 404)
        throw new CollectorDirectoryErrorV1('access-denied');
      throw error;
    }
    stage = 'verify-user';
    if (
      user.id.toLowerCase() !== binding.actorId.toLowerCase() ||
      !user.accountEnabled ||
      Date.parse(user.signInSessionsValidFromDateTime) > binding.originAuthenticatedAt
    )
      throw new CollectorDirectoryErrorV1('access-denied');
    stage = 'read-admin-membership';
    const result = memberships.parse(
      await dependencies.graph({
        path: `${person}/checkMemberGroups`,
        method: 'POST',
        body: { groupIds: [group] },
      }),
    );
    stage = 'verify-admin-membership';
    if (result.value.length !== 1 || result.value[0]!.toLowerCase() !== group)
      throw new CollectorDirectoryErrorV1('access-denied');
    const evidence = Object.freeze({
      tenantId: binding.tenantId,
      actorId: binding.actorId,
      grantId: binding.grantId,
      grantGeneration: binding.generation,
      originAuthenticatedAt: binding.originAuthenticatedAt,
      directoryCheckedAt,
      directoryValidUntil: directoryCheckedAt + DIRECTORY_WINDOW_MS,
    });
    stage = 'validate-directory-window';
    collectorLeaseExpiryV1(binding, evidence, dependencies.now());
    return evidence;
  } catch (error) {
    // Never include provider bodies, exception text or identities.
    console.error(JSON.stringify({ message: 'collector_directory_failed', stage }));
    if (error instanceof CollectorDirectoryErrorV1) throw error;
    throw new CollectorDirectoryErrorV1('unavailable');
  }
}
