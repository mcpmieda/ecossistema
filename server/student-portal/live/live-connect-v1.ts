export interface SecurityRenewalV1 {
  connectionId: string;
  sessionId: string;
  accountId: string;
  studentId: number;
  classId: number | null;
  verifiedAt: number;
  expiresAt: string;
}
interface LiveStubV1 {
  fetch(request: Request): Promise<Response>;
  renewSecurity(input: SecurityRenewalV1): Promise<boolean>;
  publish(input: unknown): Promise<'delivered' | 'duplicate'>;
  presence(
    input: unknown,
  ): Promise<{ connectedStudents: number; observedAt: string; windowSeconds: number }>;
}
interface LiveNamespaceV1 {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): LiveStubV1;
}
export interface PortalLiveEnvV1 {
  PORTAL_LIVE?: LiveNamespaceV1;
}

export function portalLiveStubV1(env: PortalLiveEnvV1, audience: 'admin' | 'student') {
  if (!env.PORTAL_LIVE) throw new Error('student-portal-live-unavailable');
  return env.PORTAL_LIVE.get(env.PORTAL_LIVE.idFromName(`${audience}:2026`));
}

export function connectPortalLiveV1(
  env: PortalLiveEnvV1,
  request: Request,
  identity: {
    purpose?: 'academic' | 'security';
    audience: 'admin' | 'student';
    expiresAt: string;
    effectiveExpiresAt?: string;
    connectionId?: string;
    sessionId?: string;
    accountId: string | null;
    studentId: number | null;
    classId: number | null;
  },
) {
  const headers = new Headers({
    Upgrade: 'websocket',
    'x-live-audience': identity.audience,
    'x-live-purpose': identity.purpose ?? 'academic',
    'x-live-expires-at': identity.expiresAt,
  });
  if (identity.connectionId && identity.sessionId) {
    headers.set('x-live-connection-id', identity.connectionId);
    headers.set('x-live-session-id', identity.sessionId);
  }
  if (identity.accountId) headers.set('x-live-account-id', identity.accountId);
  if (identity.studentId) headers.set('x-live-student-id', String(identity.studentId));
  if (identity.classId) headers.set('x-live-class-id', String(identity.classId));
  if (identity.purpose === 'security' && identity.effectiveExpiresAt)
    headers.set('x-live-effective-expires-at', identity.effectiveExpiresAt);
  return portalLiveStubV1(env, identity.audience).fetch(new Request(request.url, { headers }));
}
