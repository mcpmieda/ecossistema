import { expect, it, vi } from 'vitest';
import {
  createPhotoEditorControllerV1,
  type PhotoEditorMediaV1,
} from '../../src/features/student-photos/draft-controller-v1';
import type { PhotoDraftV1, PhotoSourceV1 } from '../../src/features/student-photos/browser-v1';
import { PhotoPreparationErrorV1 } from '../../shared/student-photos/crop-v1';
const source = (id: string): PhotoSourceV1 => ({
  src: 'blob:' + id,
  image: {} as CanvasImageSource,
  width: 300,
  height: 400,
  dispose: vi.fn(),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const file = () => new Blob(['synthetic input']);
it('keeps the two crops independent and sends no work until explicit preparation', async () => {
  const prepare = vi.fn<PhotoEditorMediaV1['prepare']>().mockResolvedValue({} as PhotoDraftV1);
  const controller = createPhotoEditorControllerV1({ load: async () => source('a'), prepare });
  await controller.select(file());
  const portrait = controller.getSnapshot().options.portrait;
  controller.change('avatar', { x: 0.2, y: 0.3, zoom: 2 });
  expect(controller.getSnapshot().options.portrait).toEqual(portrait);
  expect(prepare).not.toHaveBeenCalled();
  await controller.prepare();
  expect(prepare).toHaveBeenCalledOnce();
  expect(prepare.mock.calls[0]?.[1].avatar).toEqual({ x: 0.2, y: 0.3, zoom: 2 });
});
it('discards a late older file, closes both resources, and can reopen after cleanup', async () => {
  const first = deferred<PhotoSourceV1>(),
    a = source('a'),
    b = source('b');
  let count = 0;
  const controller = createPhotoEditorControllerV1({
    load: () => (++count === 1 ? first.promise : Promise.resolve(b)),
    prepare: vi.fn(),
  });
  const pending = controller.select(file());
  await controller.select(file());
  first.resolve(a);
  await pending;
  expect(controller.getSnapshot().source).toBe(b);
  expect(a.dispose).toHaveBeenCalledOnce();
  controller.reset();
  expect(b.dispose).toHaveBeenCalledOnce();
  expect(controller.getSnapshot().status).toBe('empty');
  await controller.select(file());
  expect(controller.getSnapshot().status).toBe('editing');
  controller.reset();
});
it('cannot apply work that completes after cancel, owner change, or a new upload', async () => {
  const finish = deferred<PhotoDraftV1>(),
    a = source('a');
  const controller = createPhotoEditorControllerV1({
    load: async () => a,
    prepare: () => finish.promise,
  });
  await controller.select(file());
  const pending = controller.prepare();
  expect(await controller.prepare()).toBeUndefined();
  controller.reset();
  finish.resolve({} as PhotoDraftV1);
  expect(await pending).toBeUndefined();
  expect(controller.getSnapshot().source).toBeNull();
  expect(a.dispose).toHaveBeenCalledOnce();
});
it('preserves the previous draft after a bad replacement and sanitizes error details', async () => {
  const a = source('a');
  let first = true;
  const controller = createPhotoEditorControllerV1({
    load: async () => {
      if (first) {
        first = false;
        return a;
      }
      throw new Error('PRIVATE PATH MUST NOT LEAK');
    },
    prepare: vi.fn(),
  });
  await controller.select(file());
  await controller.select(file());
  expect(controller.getSnapshot()).toMatchObject({ status: 'editing', source: a, error: 'decode' });
  expect(a.dispose).not.toHaveBeenCalled();
  controller.reset();
});
it('reports an explicit byte budget error without changing selected quality', async () => {
  const controller = createPhotoEditorControllerV1({
    load: async () => source('a'),
    prepare: async () => {
      throw new PhotoPreparationErrorV1('budget');
    },
  });
  await controller.select(file());
  await controller.prepare();
  expect(controller.getSnapshot()).toMatchObject({
    status: 'editing',
    error: 'budget',
    options: { quality: 0.92 },
  });
  controller.reset();
});
