import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@heroui/react';
import { Pencil, Trash2, RotateCw } from 'lucide-react';
import type { PhotoAdminSubjectV1, PhotoByteImagesV1 } from '../../../shared/student-photos/admin-http-v1';
import { clearPhotoBytesV1 } from '../../../shared/student-photos/admin-http-v1';
import { photoSubjectKeyV1, type PhotoCatalogStateV1 } from '../../../shared/student-photos/catalog-v1';
import type { PhotoWriteCommandV1 } from '../../../shared/student-photos/write-v1';
import { photoQualitiesV1, type PhotoPreviewApprovalV1 } from '../../../shared/student-photos/preview-v1';
import { createPhotoAdminClientV1, PhotoAdminClientErrorV1 } from './admin-client-v1';
import { readPhotoCatalogV1, readCurrentPhotoV1, recoverPhotoWriteV1, announcePhotoChangeV1 } from './catalog-client-v1';
import { LinkedStudentPhotoAvatarV1 } from './linked-student-photo-avatar-v1';
import type { PhotoDraftV1 } from './browser-v1';
import './student-photo-panel-v1.css';

const Editor = lazy(() => import('./student-photo-editor-v1').then(module => ({ default: module.StudentPhotoEditorV1 })));
interface Confirmation {
  command: PhotoWriteCommandV1;
  approval: PhotoPreviewApprovalV1 | null;
  source: PhotoByteImagesV1;
  portraitUrl?: string;
  avatarUrl?: string;
}
export interface StudentPhotoPanelPropsV1 { subject: PhotoAdminSubjectV1; canWrite?: boolean; showAvatar?: boolean }
function dispose(value: Confirmation | null) {
  if (!value) return;
  clearPhotoBytesV1(value.source);
  if (value.portraitUrl) URL.revokeObjectURL(value.portraitUrl);
  if (value.avatarUrl) URL.revokeObjectURL(value.avatarUrl);
}
function messageFor(error: unknown) {
  if (error instanceof PhotoAdminClientErrorV1) {
    if (error.code === 'forbidden') return 'Sua permissão não permite alterar esta foto.';
    if (error.code === 'unauthenticated') return 'Sua sessão precisa ser renovada para alterar a foto.';
    if (error.code === 'too-large') return 'O WebP final ficou grande demais. Escolha 600 px ou outra qualidade no editor.';
    if (error.code === 'conflict' || error.code === 'busy') return 'A foto mudou ou existe uma operação pendente. Atualize os dados antes de continuar.';
  }
  return 'Não foi possível confirmar a operação. A foto anterior não será substituída sem confirmação do servidor.';
}

/** Removing a photo asks first; closing it while nothing runs cancels. */
function RemovePhotoModalV1({ busy, message, onCancel, onRemove }: Readonly<{
  busy: boolean; message: string; onCancel: () => void; onRemove: () => void;
}>) {
  return <Modal.Backdrop isOpen isDismissable={false} onOpenChange={open => { if (!open && !busy) onCancel(); }}>
    <Modal.Container size="sm"><Modal.Dialog aria-label="Remover foto do aluno">
      <Modal.Header><Modal.Heading>Remover foto?</Modal.Heading></Modal.Header>
      <Modal.Body><p>A foto principal e o avatar deixarão de aparecer no sistema. Os arquivos salvos no Portal serão excluídos permanentemente.</p>
        {message ? <p><output className="contents">{message}</output></p> : null}</Modal.Body>
      <Modal.Footer><Button variant="secondary" isDisabled={busy} onPress={onCancel}>Cancelar</Button>
        <Button isDisabled={busy} onPress={onRemove}>{busy ? 'Removendo…' : 'Remover foto'}</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}

/** Shared controls for real administrative sheets; changing student discards the entire local draft. */
export function StudentPhotoPanelV1(props: Readonly<StudentPhotoPanelPropsV1>) {
  return <PhotoPanelSessionV1 key={photoSubjectKeyV1(props.subject) + ":" + (props.canWrite !== false)} {...props} />;
}
function PhotoPanelSessionV1({ subject, canWrite: allowedByParent = true, showAvatar = true }: Readonly<StudentPhotoPanelPropsV1>) {
  const [catalog, setCatalog] = useState<PhotoCatalogStateV1>();
  const [canWrite, setCanWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(false);
  const [initialPhoto, setInitialPhoto] = useState<Blob>();
  const [kind, setKind] = useState<'replace' | 'avatar'>('replace');
  const [removing, setRemoving] = useState(false);
  const active = useRef(new AbortController());
  const working = useRef(false);
  const ownedConfirmation = useRef<Confirmation | null>(null);
  const client = useRef(createPhotoAdminClientV1());
  const picker = useRef<HTMLInputElement>(null);
  const subjectKey = photoSubjectKeyV1(subject);

  function discard() {
    dispose(ownedConfirmation.current); ownedConfirmation.current = null;
  }
  async function refresh(signal: AbortSignal, open = false) {
    const result = await readPhotoCatalogV1(subject, signal, open);
    signal.throwIfAborted();
    setCatalog(result.catalog); setCanWrite(result.canWrite && allowedByParent);
    return result.catalog;
  }
  useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    void readPhotoCatalogV1(subject, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setCatalog(result.catalog); setCanWrite(result.canWrite && allowedByParent);
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof PhotoAdminClientErrorV1 && error.code === 'forbidden') {
        setCanWrite(false);
        return;
      }
      setMessage(messageFor(error));
    });
    return () => { controller.abort(); dispose(ownedConfirmation.current); ownedConfirmation.current = null; };
  // The keyed parent fixes the subject for the lifetime of this session.
  }, [subjectKey, allowedByParent]);

  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    const signal = active.current.signal;
    working.current = true; setBusy(true); setMessage('');
    try { signal.throwIfAborted(); await operation(signal); }
    catch (error) { if (!signal.aborted) setMessage(messageFor(error)); }
    finally { working.current = false; if (!signal.aborted) setBusy(false); }
  }
  function openEditor(mode: 'replace' | 'avatar') {
    void run(async signal => {
      const current = await refresh(signal, true);
      if (current.pendingRequest) {
        setMessage('Há uma alteração anterior pendente. Use “Concluir operação” antes de iniciar outra.'); return;
      }
      const blob = current.hasPortrait ? await readCurrentPhotoV1(subject, current.revision, signal) : undefined;
      signal.throwIfAborted(); discard(); setInitialPhoto(blob); setKind(mode); setEditing(true);
    });
  }
  /** A student without a photo goes straight to the file picker; the editor opens with the choice. */
  function openWithFile(file: File) {
    void run(async signal => {
      const current = await refresh(signal, true);
      if (current.pendingRequest) {
        setMessage('Há uma alteração anterior pendente. Use “Concluir operação” antes de iniciar outra.'); return;
      }
      signal.throwIfAborted(); discard(); setInitialPhoto(file); setKind('replace'); setEditing(true);
    });
  }
  function prepared(draft: PhotoDraftV1) {
    void run(async signal => {
      if (!catalog) return;
      setEditing(false); setInitialPhoto(draft.portrait.blob);
      const source: PhotoByteImagesV1 = { portrait: null, avatar: null };
      let candidate: Confirmation | null = null;
      try {
        const [portraitBuffer, avatarBuffer] = await Promise.all([
          kind === 'replace' ? draft.portrait.blob.arrayBuffer() : Promise.resolve(null), draft.avatar.blob.arrayBuffer(),
        ]);
        source.portrait = portraitBuffer ? new Uint8Array(portraitBuffer) : null;
        source.avatar = new Uint8Array(avatarBuffer);
        signal.throwIfAborted();
        const command: PhotoWriteCommandV1 = { requestId: crypto.randomUUID(), expectedRevision: catalog.revision, kind };
        const quality = Math.round(draft.quality * 100);
        const qualities = photoQualitiesV1.parse({ portrait: kind === 'replace' ? quality : null, avatar: quality });
        const result = await client.current.preview(subject, command, qualities, source, signal);
        try {
          signal.throwIfAborted();
          candidate = { command, approval: result.approval, source };
          if (result.images.portrait) candidate.portraitUrl = URL.createObjectURL(new Blob([
            new Uint8Array(result.images.portrait).buffer], { type: 'image/webp' }));
          if (result.images.avatar) candidate.avatarUrl = URL.createObjectURL(new Blob([
            new Uint8Array(result.images.avatar).buffer], { type: 'image/webp' }));
          // The crop itself is the decision (owner request 29/09/2026): save without a second dialog.
          discard(); ownedConfirmation.current = candidate;
        } finally { clearPhotoBytesV1(result.images); }
        await persist(candidate, signal);
      } catch (error) {
        if (candidate !== ownedConfirmation.current) dispose(candidate);
        clearPhotoBytesV1(source);
        if (!signal.aborted) setEditing(true);
        throw error;
      }
    });
  }
  async function persist(value: Confirmation, signal: AbortSignal) {
      const result = await client.current.save(subject, value.command, value.approval, value.source, signal);
      if (result.state === 'pending') {
        setMessage('O envio ainda não foi confirmado. Use “Concluir operação” para terminar sem duplicar a foto.');
        await refresh(signal); return;
      }
      discard(); setRemoving(false); setEditing(false); setInitialPhoto(undefined);
      const current = await refresh(signal); announcePhotoChangeV1(subject, current);
      setMessage(result.cleanupPending ? 'Foto salva. Há uma finalização pendente; use “Concluir operação”.' : 'Foto atualizada.');
  }
  function remove() {
    void run(async signal => {
      const retry = ownedConfirmation.current?.command.kind === 'remove' ? ownedConfirmation.current : null;
      const current = retry ? catalog : await refresh(signal, true);
      if (!current || (!retry && current.pendingRequest)) {
        setMessage('Há uma alteração pendente. Use “Concluir operação” antes de remover a foto.');
        return;
      }
      const value: Confirmation = retry ?? {
        command: { requestId: crypto.randomUUID(), expectedRevision: current.revision, kind: 'remove' },
        approval: null, source: { portrait: null, avatar: null },
      };
      ownedConfirmation.current = value;
      await persist(value, signal);
    });
  }
  function recover() {
    void run(async signal => {
      if (!catalog?.pendingRequest) return;
      const result = await recoverPhotoWriteV1(subject, catalog.pendingRequest, signal);
      const current = await refresh(signal); announcePhotoChangeV1(subject, current);
      if (result.state === 'committed' && !result.cleanupPending) {
        discard(); setRemoving(false); setMessage('Operação concluída.');
      } else setMessage('A operação permanece pendente. Os dados foram preservados para uma nova tentativa.');
    });
  }

  return <section className="student-photo-panel" aria-label="Foto do aluno">
    <div className="student-photo-panel__identity">
      {showAvatar ? <LinkedStudentPhotoAvatarV1 subject={subject} studentUid={catalog?.studentUid} revision={catalog?.revision} size="lg" /> : null}
      <div className="student-photo-panel__actions">
        {canWrite ? <>
          {/* Straight to the explorer or gallery, with or without a current photo (29/09/2026). */}
          <Button size="sm" variant="secondary" isDisabled={busy || !!catalog?.pendingRequest} onPress={() => picker.current?.click()}>
            <Pencil size={15} aria-hidden="true" /> {catalog?.hasPortrait ? 'Trocar foto' : 'Adicionar foto'}
          </Button>
          <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-hidden="true" tabIndex={-1}
            onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) openWithFile(file); }} />
          {catalog?.hasPortrait ? <>
            <Button size="sm" variant="tertiary" isDisabled={busy || !!catalog.pendingRequest} onPress={() => openEditor('avatar')}>Ajustar avatar</Button>
            <Button size="sm" variant="tertiary" isDisabled={busy || !!catalog.pendingRequest} onPress={() => { discard(); setRemoving(true); }}>
              <Trash2 size={15} aria-hidden="true" /> Remover
            </Button>
          </> : null}
        </> : null}
        {canWrite && catalog?.pendingRequest ? <Button size="sm" isDisabled={busy} onPress={recover}>
          <RotateCw size={15} aria-hidden="true" /> Concluir operação
        </Button> : null}
        <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void run(async signal => { await refresh(signal); })} aria-label="Atualizar estado da foto">
          <RotateCw size={15} aria-hidden="true" />
        </Button>
      </div>
    </div>
    {busy ? <output aria-live="polite">Processando foto…</output> : null}
    {message ? <p className="student-photo-panel__message"><output className="contents">{message}</output></p> : null}
    {editing ? <Suspense fallback={<p><output className="contents">Abrindo editor…</output></p>}>
      {kind === 'avatar' ? <p>Este ajuste altera somente o avatar; a foto principal será preservada.</p> : null}
      <Editor ownerKey={subjectKey + ':' + kind} initialPhoto={initialPhoto} onCancel={() => { setEditing(false); setInitialPhoto(undefined); }} onPrepared={prepared} />
    </Suspense> : null}
    {removing ? <RemovePhotoModalV1 busy={busy} message={message} onCancel={() => { setRemoving(false); discard(); }} onRemove={remove} /> : null}
  </section>;
}
