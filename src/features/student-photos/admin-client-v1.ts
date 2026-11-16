import {
  PHOTO_ADMIN_PATHS_V1,
  photoAdminPreviewRequestV1,
  photoAdminSaveRequestV1,
  photoAdminResponseV1,
  encodePhotoBytesV1,
  decodePhotoBytesV1,
  assertPhotoPreviewBytesV1,
  clearPhotoBytesV1,
  sameCommand,
  type PhotoByteImagesV1,
  type PhotoAdminSubjectV1,
  type PhotoAdminFailureStateV1,
} from '../../../shared/student-photos/admin-http-v1';
import { readPhotoJsonV1 } from '../../../shared/student-photos/bounded-json-v1';
import type { PhotoWriteCommandV1 } from '../../../shared/student-photos/write-v1';
import type {
  PhotoPreviewApprovalV1,
  PhotoQualitiesV1,
} from '../../../shared/student-photos/preview-v1';

export class PhotoAdminClientErrorV1 extends Error {
  constructor(readonly code: PhotoAdminFailureStateV1 | 'transport') {
    super(`student-photo-client-${code}`);
  }
}
/** Same-origin client with bounded responses and explicit, caller-controlled confirmation/retry. */
export function createPhotoAdminClientV1(fetcher: typeof fetch = fetch) {
  async function send(path: string, body: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const serialized = JSON.stringify(body); // Freeze request before the first await.
    let response: Response;
    try {
      response = await fetcher(path, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json', 'X-Student-Photo-Request': '1' },
        body: serialized,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PhotoAdminClientErrorV1('transport');
    }
    signal.throwIfAborted();
    let parsed: ReturnType<typeof photoAdminResponseV1.parse>;
    try {
      const headers = new Headers(response.headers);
      // Fetch has already decoded response content codings, but these headers can still
      // describe the compressed wire representation. Bound decoded bytes instead.
      // This adaptation is browser-response-only; incoming ADM bodies still reject compression.
      const encoding = headers.get('content-encoding');
      if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
        headers.delete('content-encoding');
        headers.delete('content-length');
      }
      parsed = photoAdminResponseV1.parse(
        await readPhotoJsonV1({ body: response.body, headers }, signal),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PhotoAdminClientErrorV1('unavailable');
    }
    if (parsed.state !== 'preview' && parsed.state !== 'committed' && parsed.state !== 'pending')
      throw new PhotoAdminClientErrorV1(parsed.state);
    if (response.redirected || response.status !== (parsed.state === 'pending' ? 202 : 200))
      throw new PhotoAdminClientErrorV1('unavailable');
    signal.throwIfAborted();
    return parsed;
  }
  return {
    async preview(
      subject: PhotoAdminSubjectV1,
      command: PhotoWriteCommandV1,
      qualities: PhotoQualitiesV1,
      source: PhotoByteImagesV1,
      signal: AbortSignal,
    ) {
      const input = photoAdminPreviewRequestV1.parse({
        version: 1,
        subject,
        command,
        qualities,
        images: encodePhotoBytesV1(source),
      });
      const result = await send(PHOTO_ADMIN_PATHS_V1.preview, input, signal);
      if (
        result.state !== 'preview' ||
        !sameCommand(result.approval.command, input.command) ||
        result.approval.qualities.portrait !== input.qualities.portrait ||
        result.approval.qualities.avatar !== input.qualities.avatar
      )
        throw new PhotoAdminClientErrorV1('unavailable');
      const images: PhotoByteImagesV1 = { portrait: null, avatar: null };
      const frozenSource = decodePhotoBytesV1(input.images);
      try {
        // Bind the returned approval to the exact original bytes serialized for this call.
        // Reuse the transport check against source metadata; this does not replace the codec.
        await assertPhotoPreviewBytesV1(
          { ...result.approval, output: result.approval.source },
          frozenSource,
        );
        Object.assign(images, decodePhotoBytesV1(result.images));
        await assertPhotoPreviewBytesV1(result.approval, images);
        signal.throwIfAborted();
        return { approval: result.approval, images }; // Caller clears on cancel/student change.
      } catch (error) {
        clearPhotoBytesV1(images);
        throw error;
      } finally {
        clearPhotoBytesV1(frozenSource);
      }
    },
    async save(
      subject: PhotoAdminSubjectV1,
      command: PhotoWriteCommandV1,
      approval: PhotoPreviewApprovalV1 | null,
      source: PhotoByteImagesV1,
      signal: AbortSignal,
    ) {
      const input = photoAdminSaveRequestV1.parse({
        version: 1,
        subject,
        command,
        approval,
        images: encodePhotoBytesV1(source),
      });
      const result = await send(PHOTO_ADMIN_PATHS_V1.save, input, signal);
      if (
        result.state === 'preview' ||
        result.requestId !== input.command.requestId ||
        (result.state === 'committed' && result.revision !== input.command.requestId)
      )
        throw new PhotoAdminClientErrorV1('unavailable');
      return result;
    },
  };
}
