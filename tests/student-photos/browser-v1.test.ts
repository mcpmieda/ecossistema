// @vitest-environment node
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import {
  loadPhotoSourceV1,
  prepareAvatarDraftV1,
  preparePhotoDraftV1,
  type PhotoBrowserV1,
  type PhotoCanvasV1,
  type PhotoSourceV1,
} from '../../src/features/student-photos/browser-v1';
import { initialPhotoCropV1 } from '../../shared/student-photos/crop-v1';

const image = () =>
  sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 31, g: 81, b: 137 } } });
const signal = () => new AbortController().signal;
function setup() {
  const close = vi.fn(),
    bitmap = { width: 300, height: 400, close } as unknown as ImageBitmap;
  const draw = vi.fn(),
    release = vi.fn();
  const canvases: PhotoCanvasV1[] = [];
  const browser: PhotoBrowserV1 = {
    decode: vi.fn(async () => bitmap),
    createObjectURL: vi.fn(() => 'blob:synthetic-source'),
    revokeObjectURL: release,
    canvas: () => {
      const canvas: PhotoCanvasV1 = {
        width: 0,
        height: 0,
        getContext: () => ({
          fillStyle: '',
          fillRect: vi.fn(),
          drawImage: draw,
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
        }),
        toBlob(callback, type, quality) {
          // Native encoding validates actual output bytes; drawing geometry is checked separately.
          void image()
            .resize(canvas.width, canvas.height)
            .webp({ quality: Math.round(quality * 100) })
            .toBuffer()
            .then((buffer) => callback(new Blob([new Uint8Array(buffer).buffer], { type })))
            .catch(() => callback(null));
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  return { browser, close, release, draw, canvases };
}
const options = {
  portrait: initialPhotoCropV1('portrait'),
  avatar: initialPhotoCropV1('avatar'),
  portraitWidth: 900 as const,
  quality: 0.92,
};
it('decodes the source, exports two real WebPs and releases pixel surfaces without upscaling', async () => {
  const s = setup(),
    source = await loadPhotoSourceV1(
      new Blob([new Uint8Array(await image().jpeg().toBuffer()).buffer], { type: 'image/jpeg' }),
      signal(),
      s.browser,
    );
  const draft = await preparePhotoDraftV1(source, options, signal(), s.browser);
  expect([draft.portrait.width, draft.portrait.height]).toEqual([300, 400]);
  expect([draft.avatar.width, draft.avatar.height]).toEqual([300, 300]);
  for (const variant of [draft.portrait, draft.avatar]) {
    const meta = await sharp(Buffer.from(await variant.blob.arrayBuffer())).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(variant.width);
    expect(meta.height).toBe(variant.height);
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
  }
  expect(s.draw).toHaveBeenCalledTimes(2);
  expect(s.draw.mock.calls[1]?.slice(1, 5)).toEqual([0, 16, 300, 300]);
  expect(s.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  source.dispose();
  source.dispose();
  expect(s.close).toHaveBeenCalledOnce();
  expect(s.release).toHaveBeenCalledOnce();
});
it('exports the avatar alone for a saved portrait, with the same framing and checks', async () => {
  const s = setup(),
    source = await loadPhotoSourceV1(
      new Blob([new Uint8Array(await image().jpeg().toBuffer()).buffer], { type: 'image/jpeg' }),
      signal(),
      s.browser,
    );
  const avatar = await prepareAvatarDraftV1(
    source,
    initialPhotoCropV1('avatar'),
    0.86,
    signal(),
    s.browser,
  );
  expect([avatar.width, avatar.height]).toEqual([300, 300]);
  expect((await sharp(Buffer.from(await avatar.blob.arrayBuffer())).metadata()).format).toBe(
    'webp',
  );
  expect(s.draw).toHaveBeenCalledOnce();
  expect(s.draw.mock.calls[0]?.slice(1, 5)).toEqual([0, 16, 300, 300]);
  await expect(
    prepareAvatarDraftV1(source, initialPhotoCropV1('avatar'), 0.5, signal(), s.browser),
  ).rejects.toThrow('student-photo-encode');
  source.dispose();
});
it('rejects unsupported or mislabeled input before invoking the decoder', async () => {
  const s = setup(),
    jpeg = new Uint8Array(await image().jpeg().toBuffer()).buffer;
  await expect(
    loadPhotoSourceV1(new Blob([jpeg], { type: 'image/webp' }), signal(), s.browser),
  ).rejects.toThrow('student-photo-format');
  expect(s.browser.decode).not.toHaveBeenCalled();
});
it('honors swapped EXIF dimensions once and closes a bitmap returned after cancellation', async () => {
  const s = setup(),
    bytes = new Uint8Array(await image().jpeg().toBuffer()).buffer;
  const swapped = { width: 400, height: 300, close: vi.fn() } as unknown as ImageBitmap;
  s.browser.decode = async () => swapped;
  const oriented = await loadPhotoSourceV1(
    new Blob([bytes], { type: 'image/jpeg' }),
    signal(),
    s.browser,
  );
  expect(oriented.width).toBe(400);
  oriented.dispose();
  const cancellation = new AbortController();
  s.browser.decode = async () => {
    cancellation.abort();
    return swapped;
  };
  await expect(
    loadPhotoSourceV1(new Blob([bytes], { type: 'image/jpeg' }), cancellation.signal, s.browser),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(swapped.close).toHaveBeenCalledTimes(2);
});
it('does not accept a PNG fallback as WebP or silently lower quality to fit the budget', async () => {
  const s = setup();
  const source: PhotoSourceV1 = {
    width: 300,
    height: 400,
    image: {} as CanvasImageSource,
    src: 'blob:synthetic',
    dispose() {},
  };
  for (const blob of [
    new Blob(['invalid'], { type: 'image/png' }),
    new Blob([new Uint8Array(131073)], { type: 'image/webp' }),
  ]) {
    const calls = vi.fn((callback: BlobCallback) => callback(blob));
    s.browser.canvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
      }),
      toBlob: calls,
    });
    await expect(preparePhotoDraftV1(source, options, signal(), s.browser)).rejects.toThrow();
    expect(calls).toHaveBeenCalledOnce();
    expect(calls.mock.calls[0]?.[0]).toBeTypeOf('function');
  }
});
