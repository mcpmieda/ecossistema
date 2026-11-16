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
async function responseFixture() {
  const result = photoAdminResponseV1.parse(await previewResponse().json());
  if (result.state !== 'preview' || result.approval.source.portrait === null)
    throw new Error('synthetic-preview-fixture-invalid');
  return result;
}
describe('preview source and selected quality fidelity', () => {
  it('rejects a response using a different quality even when its own hashes are valid', async () => {
    const result = await responseFixture();
    result.approval.qualities.portrait = 80;
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(result));
    await expect(
      createPhotoAdminClientV1(fetcher).preview(subject, command, qualities, images(), signal()),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects a preview that describes a different original image despite a valid final-image hash', async () => {
    const result = await responseFixture();
    result.approval.source.portrait!.sha256 = 'a'.repeat(64);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(result));
    await expect(
      createPhotoAdminClientV1(fetcher).preview(subject, command, qualities, images(), signal()),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('checks against frozen request bytes rather than caller buffers changed during the request', async () => {
    const source = images(),
      before = source.portrait.slice();
    const fetcher = vi.fn<typeof fetch>(async () => {
      source.portrait.fill(0);
      return previewResponse();
    });
    const result = await createPhotoAdminClientV1(fetcher).preview(
      subject,
      command,
      qualities,
      source,
      signal(),
    );
    expect(result.images.portrait).toEqual(before);
    expect(Array.from(source.portrait)).toEqual(Array(38).fill(0));
  });
  it('rejects a committed envelope with the right request but a foreign revision', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        version: 1,
        traceId: ACTOR,
        state: 'committed',
        requestId: OPERATION,
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
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
