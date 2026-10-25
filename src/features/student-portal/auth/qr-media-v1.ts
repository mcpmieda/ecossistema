import {
  QrInputErrorV1,
  QR_IMAGE_MAX_PIXELS_V1,
  selectStudentQrV1,
  validateQrImageFileV1,
} from './qr-input-v1';

export type QrFrameOptionsV1 = { sharpen?: boolean };
export type QrFrameDecoderV1 = (
  frame: ImageData,
  signal: AbortSignal,
  options?: QrFrameOptionsV1,
) => Promise<string[]>;

const qrWorkerV1 = () =>
  new Worker(new URL('./qr-decoder.worker.ts', import.meta.url), { type: 'module' });

function decodeWithWorkerV1(
  worker: Worker,
  frame: ImageData,
  signal: AbortSignal,
  options: QrFrameOptionsV1 | undefined,
  release: (failed: boolean) => void,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let settled = false;
    const finish = (codes?: string[], error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.onmessage = worker.onerror = null;
      release(error !== undefined);
      if (error) reject(error);
      else resolve(codes!);
    };
    const abort = () => finish(undefined, new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(undefined, new QrInputErrorV1('unavailable')), 8000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(undefined, new QrInputErrorV1('unavailable'));
    worker.onmessage = (event: MessageEvent<{ codes?: string[]; error?: boolean }>) => {
      if (
        Array.isArray(event.data.codes) &&
        event.data.codes.every((code) => typeof code === 'string')
      )
        finish(event.data.codes);
      else finish(undefined, new QrInputErrorV1('unavailable'));
    };
    try {
      worker.postMessage(
        {
          pixels: frame.data,
          width: frame.width,
          height: frame.height,
          sharpen: options?.sharpen === true,
        },
        [frame.data.buffer],
      );
    } catch {
      finish(undefined, new QrInputErrorV1('unavailable'));
    }
  });
}

/** One-off decode (image files): the worker lives only for this frame. */
export const decodeQrFrameV1: QrFrameDecoderV1 = (frame, signal, options) => {
  signal.throwIfAborted();
  const worker = qrWorkerV1();
  return decodeWithWorkerV1(worker, frame, signal, options, () => worker.terminate());
};

/** Camera sessions decode several frames a second: keep one local worker warm and replace it
 * after a failure or cancellation, so a late answer can never be read as the next frame's.
 */
export function createQrCameraDecoderV1(): QrFrameDecoderV1 & { dispose(): void } {
  let worker: Worker | undefined;
  const dispose = () => {
    worker?.terminate();
    worker = undefined;
  };
  const decode: QrFrameDecoderV1 = (frame, signal, options) => {
    signal.throwIfAborted();
    const current = (worker ??= qrWorkerV1());
    return decodeWithWorkerV1(current, frame, signal, options, (failed) => {
      if (failed && worker === current) dispose();
    });
  };
  return Object.assign(decode, { dispose });
}

/** Image stays local. No object URL/upload; bitmap and worker are released on every path. */
export async function readQrImageV1(
  file: File,
  signal: AbortSignal,
  decode: QrFrameDecoderV1 = decodeQrFrameV1,
): Promise<string> {
  validateQrImageFileV1(file);
  signal.throwIfAborted();
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    signal.throwIfAborted();
    if (bitmap.width * bitmap.height > QR_IMAGE_MAX_PIXELS_V1 || !bitmap.width || !bitmap.height)
      throw new QrInputErrorV1('large');
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new QrInputErrorV1('unavailable');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const codes = await decode(context.getImageData(0, 0, canvas.width, canvas.height), signal);
    signal.throwIfAborted();
    return selectStudentQrV1(codes);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof QrInputErrorV1) throw error;
    throw new QrInputErrorV1('unsupported');
  } finally {
    bitmap?.close();
  }
}

export function stopCameraTracksV1(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}

async function enableContinuousFocusV1(stream: MediaStream) {
  const track = stream.getVideoTracks()[0];
  try {
    if (!track) return;
    const capabilities = track.getCapabilities?.() as
      (MediaTrackCapabilities & { focusMode?: string[] }) | undefined;
    if (!capabilities?.focusMode?.includes('continuous')) return;
    await track.applyConstraints({
      advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
    });
  } catch {
    // Keep the browser's default autofocus if this device rejects the optional setting.
  }
}

/** Late permission responses cannot resurrect a camera after a switch/unmount. */
export function createCameraLeaseV1(media: Pick<MediaDevices, 'getUserMedia'>) {
  let generation = 0;
  let current: MediaStream | undefined;
  let currentFacing: 'environment' | 'user' | undefined;
  const stop = () => {
    generation += 1;
    stopCameraTracksV1(current);
    current = undefined;
    currentFacing = undefined;
  };
  return {
    stop,
    async zoomForDistance(): Promise<boolean> {
      const stream = current;
      const request = generation;
      const track = stream?.getVideoTracks()[0];
      if (!track || currentFacing !== 'environment') return false;
      try {
        const capabilities = track.getCapabilities?.() as
          | (MediaTrackCapabilities & {
              focusMode?: string[];
              zoom?: { min: number; max: number };
            })
          | undefined;
        const settings = track.getSettings?.() as
          (MediaTrackSettings & { zoom?: number }) | undefined;
        const zoom = capabilities?.zoom;
        const target = zoom && Math.min(1.5, zoom.max);
        const currentZoom = settings?.zoom;
        if (
          !zoom ||
          !Number.isFinite(zoom.min) ||
          !Number.isFinite(zoom.max) ||
          typeof currentZoom !== 'number' ||
          !Number.isFinite(currentZoom) ||
          !target ||
          target < zoom.min ||
          currentZoom >= target
        )
          return false;
        await track.applyConstraints({
          advanced: [
            {
              zoom: target,
              ...(capabilities?.focusMode?.includes('continuous')
                ? { focusMode: 'continuous' }
                : {}),
            } as MediaTrackConstraintSet,
          ],
        });
        return request === generation && current === stream;
      } catch {
        return false;
      }
    },
    async open(facing: 'environment' | 'user'): Promise<MediaStream | null> {
      stop();
      const request = generation;
      const stream = await media.getUserMedia({
        audio: false,
        // A printed card read from where the lens can focus is small in frame: ask for detail.
        video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (request !== generation) {
        stopCameraTracksV1(stream);
        return null;
      }
      current = stream;
      currentFacing = facing;
      if (facing === 'environment') await enableContinuousFocusV1(stream);
      if (request !== generation) return null;
      return stream;
    },
  };
}
