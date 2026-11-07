import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';
import { Button, Label, Modal } from '@heroui/react';
import { initialPhotoCropV1 } from '../../../shared/student-photos/crop-v1';
import { createPhotoEditorControllerV1, type PhotoEditorMediaV1 } from './draft-controller-v1';
import { PhotoCropPanelV1 } from './crop-panel-v1';
import type { PhotoDraftV1 } from './browser-v1';
import './student-photos-v1.css';

interface StudentPhotoEditorPropsV1 {
  ownerKey: string;
  onCancel(): void;
  /** Receives a local draft only. The caller owns server validation, CAS and persistence. */
  onPrepared(draft: PhotoDraftV1): void;
  initialPhoto?: Blob;
  media?: PhotoEditorMediaV1;
}
const errorText = {
  format: 'Escolha uma foto JPG, PNG ou WebP sem animação.',
  size: 'A foto deve ter até 12 MB.',
  dimensions: 'O enquadramento é pequeno demais ou a imagem é muito grande.',
  decode: 'Não foi possível abrir essa foto. Escolha outro arquivo.',
  encode: 'Não foi possível gerar o WebP. Tente outro arquivo ou navegador.',
  budget: 'A foto ultrapassou o limite. Escolha 600 px ou outra qualidade e tente novamente.',
  unsupported: 'Este navegador não oferece as ferramentas necessárias para editar a foto.',
} as const;

/** Mount lazily from an authorized administrative sheet; changing owner destroys the whole draft. */
export function StudentPhotoEditorV1({ ownerKey, ...session }: Readonly<StudentPhotoEditorPropsV1>) {
  return <PhotoEditorSessionV1 key={ownerKey} {...session} />;
}
function PhotoEditorSessionV1({ onCancel, onPrepared, initialPhoto, media }: Readonly<Omit<StudentPhotoEditorPropsV1, 'ownerKey'>>) {
  const controller = useMemo(() => createPhotoEditorControllerV1(media), [media]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (initialPhoto) void controller.select(initialPhoto);
    return () => controller.reset();
  }, [controller, initialPhoto]);
  const busy = state.status === 'loading' || state.status === 'preparing';
  const cancel = () => { controller.reset(); onCancel(); };
  return <Modal.Backdrop isOpen isDismissable={false} onOpenChange={open => { if (!open) cancel(); }}>
    <Modal.Container size="lg"><Modal.Dialog aria-label="Editar foto do aluno" className="student-photo-editor">
      <Modal.Header><Modal.Heading>Editar foto do aluno</Modal.Heading></Modal.Header>
      <Modal.Body>
        {/* Opened with a photo already chosen, the native file control stays out of the way. */}
        <div className="student-photo-picker" hidden={initialPhoto !== undefined}>
          <Label htmlFor={inputId}>Escolher foto</Label>
          <input ref={input} id={inputId} type="file" accept="image/jpeg,image/png,image/webp" disabled={state.status === 'preparing'}
            onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
              if (file) void controller.select(file); }} />
        </div>
        {busy ? <output aria-live="polite">{state.status === 'loading' ? 'Abrindo foto…' : 'Preparando enquadramentos…'}</output> : null}
        {state.error ? <p role="alert">{errorText[state.error]}</p> : null}
        {state.source ? <>
          <div className="student-photo-grid">
            {(['portrait', 'avatar'] as const).map(kind => <PhotoCropPanelV1 key={kind} source={state.source!} kind={kind}
              controls={state.options[kind]} portraitWidth={state.options.portraitWidth} disabled={busy}
              onChange={controls => controller.change(kind, controls)} />)}
          </div>
          <fieldset className="student-photo-options" aria-label="Resolução da foto" disabled={busy}>
            <legend>Largura máxima</legend>
            {([900, 600] as const).map(width => <Button key={width} type="button" size="sm" isDisabled={busy}
              variant={state.options.portraitWidth === width ? 'primary' : 'secondary'}
              aria-pressed={state.options.portraitWidth === width} onPress={() => controller.output(width, state.options.quality)}>{width} px</Button>)}
          </fieldset>
          <fieldset className="student-photo-options" aria-label="Qualidade WebP" disabled={busy}>
            <legend>Qualidade</legend>
            {[0.92, 0.86, 0.8].map(quality => <Button key={quality} type="button" size="sm" isDisabled={busy}
              variant={state.options.quality === quality ? 'primary' : 'secondary'} aria-pressed={state.options.quality === quality}
              onPress={() => controller.output(state.options.portraitWidth, quality)}>{Math.round(quality * 100)}%</Button>)}
          </fieldset>
          <div className="student-photo-editor__tools">
            {initialPhoto !== undefined ? <Button type="button" variant="tertiary" isDisabled={busy} onPress={() => input.current?.click()}>
              Escolher outra foto</Button> : null}
            <Button type="button" variant="tertiary" isDisabled={busy} onPress={() => {
              controller.change('portrait', initialPhotoCropV1('portrait')); controller.change('avatar', initialPhotoCropV1('avatar'));
            }}>Reiniciar enquadramentos</Button>
          </div>
        </> : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="secondary" onPress={cancel}>Cancelar</Button>
        <Button type="button" isDisabled={!state.source || busy} onPress={() => {
          void controller.prepare().then(draft => { if (draft) onPrepared(draft); });
        }}>Salvar foto</Button>
      </Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}
