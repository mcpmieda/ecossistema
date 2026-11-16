import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { StudentPhotoEditorV1 } from '../../src/features/student-photos/student-photo-editor-v1';
import { StudentPhotoAvatarV1 } from '../../src/features/student-photos/student-photo-avatar-v1';
import type { PhotoEditorMediaV1 } from '../../src/features/student-photos/draft-controller-v1';
import type { PhotoDraftV1, PhotoSourceV1 } from '../../src/features/student-photos/browser-v1';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const source = (name = 'synthetic'): PhotoSourceV1 => ({
  src: 'blob:' + name,
  image: {} as CanvasImageSource,
  width: 300,
  height: 400,
  dispose: vi.fn(),
});
const file = () => new File(['synthetic source'], 'synthetic.webp', { type: 'image/webp' });
it('mounts the official editor, keeps the file input stable, and prepares only after an explicit action', async () => {
  const user = userEvent.setup(),
    photo = source(),
    prepared = vi.fn(),
    cancelled = vi.fn();
  const prepare = vi
    .fn<PhotoEditorMediaV1['prepare']>()
    .mockResolvedValue({ quality: 0.92 } as PhotoDraftV1);
  const media: PhotoEditorMediaV1 = { load: async () => photo, prepare };
  render(
    <StrictMode>
      <StudentPhotoEditorV1
        ownerKey="synthetic-a"
        media={media}
        onPrepared={prepared}
        onCancel={cancelled}
      />
    </StrictMode>,
  );
  const input = screen.getByLabelText('Escolher foto');
  await user.upload(input, file());
  expect(await screen.findByAltText('Prévia: Foto 3×4')).toBeTruthy();
  expect(screen.getByAltText('Prévia: Avatar')).toBeTruthy();
  expect(screen.getByLabelText('Escolher foto')).toBe(input);
  expect(screen.getAllByRole('slider')).toHaveLength(6);
  expect(screen.getByRole('group', { name: 'Resolução da foto' }).tagName).toBe('FIELDSET');
  expect(screen.getByRole('group', { name: 'Qualidade WebP' }).tagName).toBe('FIELDSET');
  expect(prepare).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '600 px' }));
  await user.click(screen.getByRole('button', { name: '86%' }));
  await user.click(screen.getByRole('button', { name: 'Salvar foto' }));
  await waitFor(() => expect(prepared).toHaveBeenCalledOnce());
  expect(prepare.mock.calls[0]?.[1]).toMatchObject({ portraitWidth: 600, quality: 0.86 });
  expect(screen.queryByText('Alteração salva.')).toBeNull();
  expect(cancelled).not.toHaveBeenCalled();
});
it('wipes the draft when the student changes and does not retain another person under a new heading', async () => {
  const user = userEvent.setup(),
    photo = source(),
    onPrepared = vi.fn(),
    onCancel = vi.fn();
  const media: PhotoEditorMediaV1 = { load: async () => photo, prepare: vi.fn() };
  const view = render(
    <StudentPhotoEditorV1
      ownerKey="synthetic-a"
      media={media}
      onPrepared={onPrepared}
      onCancel={onCancel}
    />,
  );
  await user.upload(screen.getByLabelText('Escolher foto'), file());
  await screen.findByAltText('Prévia: Foto 3×4');
  view.rerender(
    <StudentPhotoEditorV1
      ownerKey="synthetic-b"
      media={media}
      onPrepared={onPrepared}
      onCancel={onCancel}
    />,
  );
  expect(screen.queryByAltText('Prévia: Foto 3×4')).toBeNull();
  expect(photo.dispose).toHaveBeenCalledOnce();
  expect(onPrepared).not.toHaveBeenCalled();
});
it('cancel while encoding prevents a late callback from applying the draft', async () => {
  const user = userEvent.setup(),
    photo = source(),
    onPrepared = vi.fn(),
    onCancel = vi.fn();
  let finish!: (value: PhotoDraftV1) => void;
  const pending = new Promise<PhotoDraftV1>((resolve) => {
    finish = resolve;
  });
  const media: PhotoEditorMediaV1 = { load: async () => photo, prepare: () => pending };
  render(
    <StudentPhotoEditorV1
      ownerKey="synthetic-a"
      media={media}
      onPrepared={onPrepared}
      onCancel={onCancel}
    />,
  );
  await user.upload(screen.getByLabelText('Escolher foto'), file());
  await screen.findByAltText('Prévia: Foto 3×4');
  await user.click(screen.getByRole('button', { name: 'Salvar foto' }));
  expect(screen.getByText('Preparando enquadramentos…').tagName).toBe('OUTPUT');
  await user.click(screen.getByRole('button', { name: 'Cancelar' }));
  finish({} as PhotoDraftV1);
  await waitFor(() => expect(photo.dispose).toHaveBeenCalledOnce());
  expect(onPrepared).not.toHaveBeenCalled();
  expect(onCancel).toHaveBeenCalledOnce();
});
it('preserves a stable colored fallback and rejects media from another owner or an external host', () => {
  const view = render(<StudentPhotoAvatarV1 identityKey="synthetic-a" />);
  const circle = screen.getByRole('img', { name: 'Foto do aluno' });
  const color = circle.style.backgroundColor;
  const fallback = circle.querySelector<HTMLElement>('[aria-hidden="true"]');
  expect(fallback).not.toBeNull();
  expect(fallback!.style.backgroundColor).toBe(color);
  expect(circle.style.borderRadius).toBe('50%');
  view.rerender(
    <StudentPhotoAvatarV1
      identityKey="synthetic-a"
      photo={{ identityKey: 'synthetic-b', src: 'blob:other' }}
    />,
  );
  expect(view.container.querySelector('img')).toBeNull();
  expect(screen.getByRole('img', { name: 'Foto do aluno' }).style.backgroundColor).toBe(color);
  view.rerender(
    <StudentPhotoAvatarV1
      identityKey="synthetic-a"
      photo={{ identityKey: 'synthetic-a', src: 'https://other.invalid/file' }}
    />,
  );
  expect(view.container.querySelector('img')).toBeNull();
});
it('uses the Portal gradient fallback without an overriding solid color', () => {
  render(
    <StudentPhotoAvatarV1
      identityKey="synthetic-a"
      className="pa-student-avatar"
      fallbackTone={3}
    />,
  );
  const circle = screen.getByRole('img', { name: 'Foto do aluno' });
  const fallback = circle.querySelector<HTMLElement>('[data-slot="avatar-fallback"]');
  expect(fallback?.dataset.tone).toBe('3');
  expect(circle.style.backgroundColor).toBe('');
  expect(fallback?.style.backgroundColor).toBe('');
});
it('paints an image over its fallback at once, then an actual error, then a new source without a conditional assertion', async () => {
  const preloaders: HTMLImageElement[] = [];
  vi.stubGlobal(
    'Image',
    class SyntheticImage {
      constructor() {
        const element = document.createElement('img');
        preloaders.push(element);
        return element;
      }
    },
  );
  const view = render(
    <StudentPhotoAvatarV1
      identityKey="synthetic-a"
      photo={{ identityKey: 'synthetic-a', src: 'blob:first' }}
    />,
  );
  // No second, hidden download decides whether the visible image may appear.
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:first');
  expect(preloaders).toHaveLength(0);
  expect(view.container.querySelector('img')?.style.objectFit).toBe('cover');
  const circle = screen.getByRole('img', { name: 'Foto do aluno' });
  expect(circle.querySelector('[data-slot="avatar-fallback"]')).not.toBeNull();
  fireEvent.error(view.container.querySelector('img')!);
  await waitFor(() => expect(view.container.querySelector('img')).toBeNull());
  const fallback = circle.querySelector<HTMLElement>('[aria-hidden="true"]');
  expect(fallback).not.toBeNull();
  expect(fallback!.style.backgroundColor).toBe(circle.style.backgroundColor);
  view.rerender(
    <StudentPhotoAvatarV1
      identityKey="synthetic-a"
      photo={{ identityKey: 'synthetic-a', src: 'blob:second' }}
    />,
  );
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:second');
  expect(preloaders).toHaveLength(0);
});
