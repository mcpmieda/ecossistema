import {
  checkPortalOperationV1,
  portalAnonymousPeerIpV1,
  portalAnonymousSubjectV1,
} from './operation-burst-v1';

type AnonymousPeerEnvV1 = {
  PORTAL_AUTH_GLOBAL?: Pick<RateLimit, 'limit'>;
  PORTAL_UNKNOWN_PEER?: Pick<RateLimit, 'limit'>;
};

/** The binding and key for an anonymous budget. A request without any peer address never
 * shares the families' namespace: it goes to its own, higher PORTAL_UNKNOWN_PEER budget and
 * is logged (without any address) so production shows whether it ever happens. Only local
 * tests without that binding fall back to the shared namespace. */
export function portalAnonymousPeerV1(env: AnonymousPeerEnvV1, request: Request,
  log: (value: unknown) => void = console.warn): { binding: Pick<RateLimit, 'limit'> | undefined; subject: string } {
  const { source } = portalAnonymousPeerIpV1(request);
  if (source !== 'cf') {
    try { log({ event: 'student-portal-anonymous-peer-v1', source }); } catch { /* Telemetry only. */ }
  }
  const subject = portalAnonymousSubjectV1(request);
  if (source === 'unknown' && env.PORTAL_UNKNOWN_PEER) return { binding: env.PORTAL_UNKNOWN_PEER, subject };
  return { binding: env.PORTAL_AUTH_GLOBAL, subject };
}

/** The anonymous entry check of every public route, keyed by the network peer. */
export async function checkPortalAnonymousV1(env: AnonymousPeerEnvV1, operation: string,
  request: Request): Promise<void> {
  const peer = portalAnonymousPeerV1(env, request);
  await checkPortalOperationV1(peer.binding, operation, peer.subject);
}
