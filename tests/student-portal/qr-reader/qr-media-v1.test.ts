// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCameraLeaseV1,
  createQrCameraDecoderV1,
  decodeQrFrameV1,
  readQrImageV1,
} from '../../../src/features/student-portal/auth/qr-media-v1';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('local QR resource lifecycle', () => {
  it('requests continuous focus only when the rear camera supports it', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = {
      stop: vi.fn(),
      getCapabilities: () => ({ focusMode: ['manual', 'continuous'] }),
      applyConstraints,
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream);
    const lease = createCameraLeaseV1({ getUserMedia });
    expect(await lease.open('environment')).toBe(stream);
    expect(applyConstraints).toHaveBeenCalledWith({
      advanced: [{ focusMode: 'continuous' }],
    });
    applyConstraints.mockClear();
    expect(await lease.open('user')).toBe(stream);
    expect(applyConstraints).not.toHaveBeenCalled();
    lease.stop();
  });
  it('keeps scanning when focus controls are unavailable or rejected', async () => {
    const applyConstraints = vi.fn().mockRejectedValue(new Error('unsupported'));
    const track = {
      stop: vi.fn(),
      getCapabilities: vi
        .fn()
        .mockReturnValueOnce({ focusMode: ['manual'] })
        .mockReturnValue({
          focusMode: ['continuous'],
        }),
      applyConstraints,
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const lease = createCameraLeaseV1({
      getUserMedia: vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream),
    });
    expect(await lease.open('environment')).toBe(stream);
    expect(applyConstraints).not.toHaveBeenCalled();
    expect(await lease.open('environment')).toBe(stream);
    expect(applyConstraints).toHaveBeenCalledOnce();
    lease.stop();
  });
  it('does not revive a camera stopped while focus is being configured', async () => {
    let finishFocus!: () => void;
    const track = {
      stop: vi.fn(),
      getCapabilities: () => ({ focusMode: ['continuous'] }),
      applyConstraints: () =>
        new Promise<void>((resolve) => {
          finishFocus = resolve;
        }),
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const lease = createCameraLeaseV1({
      getUserMedia: vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream),
    });
    const opening = lease.open('environment');
    await vi.waitFor(() => expect(finishFocus).toBeTypeOf('function'));
    lease.stop();
    finishFocus();
    expect(await opening).toBeNull();
    expect(track.stop).toHaveBeenCalledOnce();
  });
  it('uses bounded zoom on the rear camera and preserves continuous focus', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = {
      stop: vi.fn(),
      getCapabilities: () => ({ focusMode: ['continuous'], zoom: { min: 1, max: 3 } }),
      getSettings: () => ({ zoom: 1 }),
      applyConstraints,
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const lease = createCameraLeaseV1({
      getUserMedia: vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream),
    });
    await lease.open('environment');
    expect(await lease.zoomForDistance()).toBe(true);
    expect(applyConstraints).toHaveBeenLastCalledWith({
      advanced: [{ zoom: 1.5, focusMode: 'continuous' }],
    });
    await lease.open('user');
    expect(await lease.zoomForDistance()).toBe(false);
    expect(applyConstraints).toHaveBeenCalledTimes(2);
    lease.stop();
  });
  it('skips unsupported zoom and ignores a completed adjustment after cancellation', async () => {
    let finishZoom!: () => void;
    const applyConstraints = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishZoom = resolve;
        }),
    );
    const track = {
      stop: vi.fn(),
      getCapabilities: () => ({ zoom: { min: 1, max: 2 } }),
      getSettings: vi.fn().mockReturnValueOnce({ zoom: 2 }).mockReturnValue({ zoom: 1 }),
      applyConstraints,
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const lease = createCameraLeaseV1({
      getUserMedia: vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream),
    });
    await lease.open('environment');
    expect(await lease.zoomForDistance()).toBe(false);
    expect(applyConstraints).not.toHaveBeenCalled();
    const zooming = lease.zoomForDistance();
    await vi.waitFor(() => expect(finishZoom).toBeTypeOf('function'));
    lease.stop();
    finishZoom();
    expect(await zooming).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
  });
  it('stops a late camera permission result and the current stream when switching', async () => {
    const stop = vi.fn(),
      stream = { getTracks: () => [{ stop }], getVideoTracks: () => [] } as unknown as MediaStream;
    let resolve!: (s: MediaStream) => void;
    const getUserMedia = vi
      .fn<MediaDevices['getUserMedia']>()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue(stream);
    const lease = createCameraLeaseV1({ getUserMedia });
    const pending = lease.open('environment');
    lease.stop();
    resolve(stream);
    expect(await pending).toBeNull();
    expect(stop).toHaveBeenCalledOnce();
    await lease.open('environment');
    await lease.open('user');
    expect(stop).toHaveBeenCalledTimes(2);
    lease.stop();
    expect(stop).toHaveBeenCalledTimes(3);
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({
      audio: false,
      video: { facingMode: { ideal: 'environment' } },
    });
    expect(getUserMedia.mock.lastCall?.[0]).toMatchObject({
      video: { facingMode: { ideal: 'user' } },
    });
  });
  it('terminates the local worker on cancellation without sending data to any server', async () => {
    const terminate = vi.fn(),
      post = vi.fn();
    vi.stubGlobal(
      'Worker',
      class {
        terminate = terminate;
        postMessage = post;
        onmessage = null;
        onerror = null;
      },
    );
    const controller = new AbortController();
    const decoding = decodeQrFrameV1(
      { width: 1, height: 1, data: new Uint8ClampedArray(4) } as ImageData,
      controller.signal,
    );
    controller.abort();
    await expect(decoding).rejects.toMatchObject({ name: 'AbortError' });
    expect(terminate).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[0]).toMatchObject({ width: 1, height: 1 });
  });
  it('keeps one warm worker for camera frames and replaces it after a cancellation', async () => {
    const workers: {
      terminate: ReturnType<typeof vi.fn>;
      postMessage: ReturnType<typeof vi.fn>;
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: (() => void) | null;
    }[] = [];
    vi.stubGlobal(
      'Worker',
      class {
        terminate = vi.fn();
        postMessage = vi.fn();
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() {
          workers.push(this);
        }
      },
    );
    const frame = () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }) as ImageData;
    const decoder = createQrCameraDecoderV1();
    for (const sharpen of [false, true]) {
      const pending = decoder(frame(), new AbortController().signal, { sharpen });
      workers[0]!.onmessage!({ data: { codes: [] } } as MessageEvent);
      await expect(pending).resolves.toEqual([]);
      expect(workers[0]!.postMessage.mock.lastCall?.[0]).toMatchObject({ sharpen });
    }
    expect(workers).toHaveLength(1);
    const controller = new AbortController();
    const cancelled = decoder(frame(), controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    void decoder(frame(), new AbortController().signal).catch(() => {});
    expect(workers).toHaveLength(2);
    decoder.dispose();
    expect(workers[1]!.terminate).toHaveBeenCalledOnce();
  });
  it('releases the bitmap on cancellation and rejects excessive pixel dimensions before canvas work', async () => {
    const close = vi.fn(),
      bitmap = { width: 5000, height: 5000, close };
    const create = vi.fn().mockResolvedValue(bitmap);
    vi.stubGlobal('createImageBitmap', create);
    const file = new File(['synthetic'], 'synthetic.png', { type: 'image/png' });
    await expect(readQrImageV1(file, new AbortController().signal)).rejects.toThrow('large');
    expect(close).toHaveBeenCalledOnce();
    const controller = new AbortController();
    create.mockImplementationOnce(async () => {
      controller.abort();
      return bitmap;
    });
    await expect(readQrImageV1(file, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('never decodes unsupported SVG input', async () => {
    const create = vi.fn();
    vi.stubGlobal('createImageBitmap', create);
    await expect(
      readQrImageV1(
        new File(['<svg/>'], 'synthetic.svg', { type: 'image/svg+xml' }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('unsupported');
    expect(create).not.toHaveBeenCalled();
  });
});
