// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createPhotoAdminClientV1 } from '../../src/features/student-photos/admin-client-v1';
import { photoAdminResponseV1 } from '../../shared/student-photos/admin-http-v1';
import {
  ACTOR,
  OPERATION,
  subject,
  command,
  qualities,
  images,
  preview,
  previewResponse,
} from './http-fixture-v1';
const signal = () => new AbortController().signal;
describe('photo editor HTTP client', () => {
  it('uses same-origin credentials, no-store, explicit header and the verified final preview bytes', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => previewResponse());
    const source = images(),
      before = source.portrait.slice();
    const value = await createPhotoAdminClientV1(fetcher).preview(
      subject,
      command,
      qualities,
      source,
      signal(),
    );
    expect(value.images.portrait).toEqual(source.portrait);
    expect(source.portrait).toEqual(before);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/student-photos/admin/preview',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-Student-Photo-Request': '1' },
      }),
    );
  });
  it('sends original prepared bytes on save, not an unannounced new quality or repeated request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        version: 1,
        traceId: ACTOR,
        state: 'committed',
        requestId: OPERATION,
        revision: OPERATION,
        cleanupPending: true,
      }),
    );
    const result = await createPhotoAdminClientV1(fetcher).save(
      subject,
      command,
      preview().approval,
      images(),
      signal(),
    );
    expect(result).toMatchObject({ state: 'committed', cleanupPending: true });
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.command.requestId).toBe(OPERATION);
    expect(body.approval.qualities).toEqual(qualities);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns pending as pending and performs no automatic mutation retry', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        { version: 1, traceId: ACTOR, state: 'pending', requestId: OPERATION, stage: 'commit' },
        { status: 202 },
      ),
    );
    expect(
      await createPhotoAdminClientV1(fetcher).save(
        subject,
        command,
        preview().approval,
        images(),
        signal(),
      ),
    ).toMatchObject({ state: 'pending', stage: 'commit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry transport failure or treat login HTML as successful image data', async () => {
    const broken = vi.fn<typeof fetch>(async () => {
      throw new Error('synthetic network failure');
    });
    await expect(
      createPhotoAdminClientV1(broken).save(
        subject,
        command,
        preview().approval,
        images(),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'transport' });
    expect(broken).toHaveBeenCalledTimes(1);
    const html = vi.fn<typeof fetch>(async () => new Response('<html>login</html>'));
    await expect(
      createPhotoAdminClientV1(html).preview(subject, command, qualities, images(), signal()),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('rejects a substituted preview hash or an unrelated write receipt', async () => {
    const changed = photoAdminResponseV1.parse(await previewResponse().json());
    if (changed.state !== 'preview' || changed.approval.output.portrait === null)
      throw new Error('synthetic-preview-fixture-invalid');
    changed.approval.output.portrait.sha256 = 'a'.repeat(64);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(changed));
    await expect(
      createPhotoAdminClientV1(fetcher).preview(subject, command, qualities, images(), signal()),
    ).rejects.toThrow();
    fetcher.mockResolvedValueOnce(
      Response.json({
        version: 1,
        traceId: ACTOR,
        state: 'committed',
        requestId: ACTOR,
        revision: ACTOR,
        cleanupPending: false,
      }),
    );
    await expect(
      createPhotoAdminClientV1(fetcher).save(
        subject,
        command,
        preview().approval,
        images(),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('does not start an HTTP operation after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createPhotoAdminClientV1(fetcher).preview(
        subject,
        command,
        qualities,
        images(),
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
