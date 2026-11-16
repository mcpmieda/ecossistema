// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { servePhotoAdminV1 } from '../../server/student-photos/http/admin-v1';
import { PhotoWriteErrorV1 } from '../../shared/student-photos/write-v1';
import { PHOTO_ADMIN_BODY_BYTES_V1 } from '../../shared/student-photos/admin-http-v1';
import {
  ACTOR,
  STUDENT,
  OPERATION,
  ORIGIN,
  env,
  subject,
  command,
  previewBody,
  saveBody,
  cookie,
  request,
  harness,
  preview,
} from './http-fixture-v1';

afterEach(() => vi.useRealTimers());
describe('photo ADM HTTP boundary with real sealed sessions', () => {
  it('derives the actor from the sealed cookie and resolves one student before invoking the service', async () => {
    const h = harness();
    const result = await servePhotoAdminV1(
      await request(previewBody(), 'preview', { 'x-admin-actor-id': STUDENT }),
      env,
      h.options,
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      state: 'preview',
      approval: { context: { actorId: ACTOR, studentUid: STUDENT } },
    });
    expect(h.resolveSubject).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: ACTOR, capability: 'platform.settings.write' }),
      subject,
      expect.any(AbortSignal),
    );
    expect(h.previewSpy).toHaveBeenCalledWith({ actorId: ACTOR, studentUid: STUDENT }, command);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(result.headers.get('access-control-allow-origin')).toBeNull();
    expect(result.headers.get('set-cookie')).toBeNull();
  });

  it('preserves confirmed writes and a pending cleanup without exposing storage locators', async () => {
    const h = harness();
    h.saveSpy.mockResolvedValue({
      state: 'committed',
      requestId: OPERATION,
      revision: OPERATION,
      cleanupPending: true,
    });
    const result = await servePhotoAdminV1(await request(saveBody(), 'save'), env, h.options);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      state: 'committed',
      requestId: OPERATION,
      cleanupPending: true,
    });
    expect(h.saveSpy).toHaveBeenCalledTimes(1);
  });

  it('does not consume bodies when disabled or when the cookie/role is invalid', async () => {
    const h = harness();
    const off = await request();
    expect((await servePhotoAdminV1(off, env, { ...h.options, enabled: false })).status).toBe(404);
    expect(off.bodyUsed).toBe(false);
    const valid = await cookie();
    for (const [value, status] of [
      ['', 401],
      ['school_admin_session=forged', 401],
      [await cookie(['ADMINISTRADOR'], ACTOR, true), 401],
      [`${valid}; ${valid}`, 401],
      [await cookie(['PROFESSOR']), 403],
      [await cookie(['ALUNO']), 403],
    ] as const) {
      const input = await request(previewBody(), 'preview', { cookie: value });
      expect((await servePhotoAdminV1(input, env, h.options)).status).toBe(status);
      expect(input.bodyUsed).toBe(false);
    }
    expect(h.resolveSubject).not.toHaveBeenCalled();
    expect(h.createService).not.toHaveBeenCalled();
  });

  it('rejects cross-origin/forwarded claims, missing application header, query selectors and preview environments', async () => {
    const h = harness();
    const invalidHeaders: Record<string, string>[] = [
      { origin: 'https://attacker.invalid' },
      { origin: 'null' },
      { origin: '' },
      { host: 'attacker.invalid' },
      { 'x-forwarded-host': ORIGIN },
      { 'x-original-url': '/other' },
      { 'sec-fetch-site': 'cross-site' },
      { 'x-student-photo-request': '' },
    ];
    for (const headers of invalidHeaders) {
      expect(
        (await servePhotoAdminV1(await request(previewBody(), 'preview', headers), env, h.options))
          .status,
      ).toBe(403);
    }
    expect(
      (
        await servePhotoAdminV1(
          await request(previewBody(), 'preview?studentUid=' + STUDENT),
          env,
          h.options,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await servePhotoAdminV1(
          await request(),
          { ...env, RUNTIME_ENVIRONMENT: 'preview' },
          h.options,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await servePhotoAdminV1(
          new Request(ORIGIN + '/api/student-photos/admin/save'),
          env,
          h.options,
        )
      ).status,
    ).toBe(400);
    expect(h.createService).not.toHaveBeenCalled();
  });

  it('rejects untrusted context, multiple subjects, non-canonical bytes and invalid variant combinations', async () => {
    const h = harness(),
      base = previewBody();
    for (const body of [
      { ...base, actorId: STUDENT },
      { ...base, studentUid: STUDENT },
      { ...base, subject: { ...subject, studentIds: [7, 8] } },
      { ...base, subject: { ...subject, name: 'SYNTHETIC NOT A KEY' } },
      { ...base, images: { ...base.images, avatar: null } },
      { ...base, images: { ...base.images, avatar: base.images.avatar + ' ' } },
      { ...base, images: { ...base.images, portrait: 'A'.repeat(PHOTO_ADMIN_BODY_BYTES_V1) } },
    ]) {
      expect([400, 413]).toContain(
        (await servePhotoAdminV1(await request(body), env, h.options)).status,
      );
    }
    expect(h.previewSpy).not.toHaveBeenCalled();
  });

  it('detects expiry while the request body is being read before resolving the subject', async () => {
    const input = await request();
    vi.useFakeTimers({ toFake: ['Date'] });
    class ExpiringRequest extends Request {
      override get body() {
        vi.setSystemTime(Date.now() + 13 * 3600_000);
        return super.body;
      }
    }
    const h = harness();
    expect((await servePhotoAdminV1(new ExpiringRequest(input), env, h.options)).status).toBe(401);
    expect(h.resolveSubject).not.toHaveBeenCalled();
  });

  it('refuses a changed identity mapping at the next authorization check', async () => {
    const h = harness();
    h.resolveSubject.mockResolvedValueOnce(STUDENT).mockResolvedValue(ACTOR);
    expect((await servePhotoAdminV1(await request(), env, h.options)).status).toBe(403);
    expect(h.createService).not.toHaveBeenCalled();
  });

  it('rechecks the original actor before mutations instead of accepting a newly substituted valid cookie', async () => {
    const input = await request(saveBody(), 'save'),
      replacement = await cookie(['ADMINISTRADOR'], STUDENT);
    const h = harness();
    h.createService.mockImplementation((authorize) => ({
      async preview() {
        throw new Error('not used');
      },
      async save(context) {
        input.headers.set('cookie', replacement);
        await authorize(context);
        return h.saveSpy();
      },
    }));
    expect((await servePhotoAdminV1(input, env, h.options)).status).toBe(403);
    expect(h.saveSpy).not.toHaveBeenCalled();
  });

  it('clears image inputs and preview outputs, including a failed final authorization', async () => {
    const h = harness(),
      output = preview();
    let inputBytes: Uint8Array | null = null;
    h.createService.mockImplementation(() => ({
      async preview(_context, _command, _qualities, images) {
        inputBytes = images.portrait;
        h.resolveSubject.mockRejectedValue(new PhotoWriteErrorV1('not-found'));
        return output;
      },
      async save() {
        return h.saveSpy();
      },
    }));
    expect((await servePhotoAdminV1(await request(), env, h.options)).status).toBe(404);
    expect(Array.from(inputBytes ?? [])).toEqual(Array(38).fill(0));
    expect(Array.from(output.images.portrait)).toEqual(Array(38).fill(0));
    expect(Array.from(output.images.avatar)).toEqual(Array(38).fill(0));
  });

  it('sanitizes backend failures and rejects foreign operation results', async () => {
    const h = harness();
    h.saveSpy.mockRejectedValueOnce(
      new Error('secret https://graph.microsoft.com/private/student'),
    );
    const failed = await servePhotoAdminV1(await request(saveBody(), 'save'), env, h.options);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toMatch(/secret|graph|private\/student/u);
    h.saveSpy.mockResolvedValueOnce({
      state: 'committed',
      requestId: ACTOR,
      revision: ACTOR,
      cleanupPending: false,
    });
    expect(
      (await servePhotoAdminV1(await request(saveBody(), 'save'), env, h.options)).status,
    ).toBe(503);
  });
});
