import { vi } from 'vitest';
import { seal } from '../../server/auth/sealed';
import { createApplicationSession, SESSION_COOKIE } from '../../server/auth/session';
import type { RuntimeEnv } from '../../server/env';
import type { Role } from '../../server/auth/roles';
import { photoPreviewApprovalV1 } from '../../shared/student-photos/preview-v1';
import { encodePhotoBytesV1 } from '../../shared/student-photos/admin-http-v1';
import type { PhotoWriteContextV1, PhotoWriteCommandV1 } from '../../shared/student-photos/write-v1';
import type { PhotoAdminHttpOptionsV1 } from '../../server/student-photos/http/admin-v1';

export const ACTOR = '11111111-1111-4111-8111-111111111111';
export const STUDENT = '22222222-2222-4222-8222-222222222222';
export const OPERATION = '33333333-3333-4333-8333-333333333333';
export const ORIGIN = 'https://admin.escolaieda.com';
export const env = { SESSION_SECRET: 'synthetic-photo-http-session-1119-'.repeat(3),
  TENANT_ID: '44444444-4444-4444-8444-444444444444', RUNTIME_ENVIRONMENT: 'production', OFFICIAL_ORIGIN: ORIGIN } as unknown as RuntimeEnv;
export const subject = { source: 'gradebook' as const, academicYear: 2026, studentIds: [7] };
export const command: PhotoWriteCommandV1 = { requestId: OPERATION, kind: 'replace', expectedRevision: null };
export const qualities = { portrait: 86 as const, avatar: 86 as const };
// Small constant-color images generated locally; no photograph or person is represented.
export const wire = { portrait: 'UklGRh4AAABXRUJQVlA4TBEAAAAvAsAAAAdQo3qUrP+BiOh/AAA=',
  avatar: 'UklGRh4AAABXRUJQVlA4TBEAAAAvA8AAAAdQo3qUrP+BiOh/AAA=' };
export function images() {
  return { portrait: Uint8Array.from(atob(wire.portrait), c => c.charCodeAt(0)),
    avatar: Uint8Array.from(atob(wire.avatar), c => c.charCodeAt(0)) };
}
export function preview(context: PhotoWriteContextV1 = { actorId: ACTOR, studentUid: STUDENT }, cmd = command) {
  const plan = {
    portrait: { byteSize: 38, width: 3, height: 4, sha256: 'c6009b25c0450c3ddcd5d9f6673d7958a5ec54725f84671923e0f2e4c773664e' },
    avatar: { byteSize: 38, width: 4, height: 4, sha256: '8fdb0a4b54045622b8114bf9c5c0c2385d140811a0e6d5b14c5094eb05bc14f1' },
  };
  return { images: images(), approval: photoPreviewApprovalV1.parse({ version: 1, codec: 'student-webp-1.6.0-v1',
    context, command: cmd, qualities, source: plan, output: plan }) };
}
export const previewBody = () => ({ version: 1, subject, command, qualities, images: wire });
export const saveBody = () => ({ version: 1, subject, command, approval: preview().approval, images: wire });
export async function cookie(roles: Role[] = ['ADMINISTRADOR'], actor = ACTOR, expired = false): Promise<string> {
  const session = createApplicationSession({ oid: actor, name: 'SYNTHETIC HTTP ADMIN', roles }, 12, Math.floor(Date.now() / 1000) - 60);
  return `${SESSION_COOKIE}=${await seal({ ...session, ...(expired ? { exp: Math.floor(Date.now() / 1000) - 1 } : {}) }, env.SESSION_SECRET, 'admin-session')}`;
}
export async function request(body: unknown = previewBody(), path = 'preview', headers: HeadersInit = {}): Promise<Request> {
  const all = new Headers({ 'content-type': 'application/json', origin: ORIGIN, cookie: await cookie(), 'x-student-photo-request': '1' });
  new Headers(headers).forEach((value, key) => all.set(key, value));
  return new Request(`${ORIGIN}/api/student-photos/admin/${path}`, { method: 'POST', body: JSON.stringify(body), headers: all });
}
export function harness() {
  const resolveSubject = vi.fn<PhotoAdminHttpOptionsV1['resolveSubject']>(async () => STUDENT);
  const previewSpy = vi.fn(async (ctx: PhotoWriteContextV1, cmd: PhotoWriteCommandV1) => preview(ctx, cmd));
  const saveSpy = vi.fn(async () => ({ state: 'committed' as const, requestId: OPERATION, revision: OPERATION, cleanupPending: false }));
  const createService = vi.fn<PhotoAdminHttpOptionsV1['createService']>(authorize => ({
    async preview(ctx, cmd) { await authorize(ctx); return previewSpy(ctx, cmd); },
    async save(ctx) { await authorize(ctx); return saveSpy(); },
  }));
  return { options: { enabled: true, resolveSubject, createService } satisfies PhotoAdminHttpOptionsV1,
    resolveSubject, previewSpy, saveSpy, createService };
}
export function previewResponse(): Response {
  const result = preview();
  return Response.json({ version: 1, traceId: OPERATION, state: 'preview', approval: result.approval, images: encodePhotoBytesV1(result.images) });
}
