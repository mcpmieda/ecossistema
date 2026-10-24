import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card } from '@heroui/react';
import { useAccountsReadV1 } from '../accounts/accounts-read-v1';
import { AccountsErrorV1 } from '../accounts/accounts-presentation-v1';
import { accountPageMatchesV1 } from '../accounts/accounts-values-v1';
import type { StudentCredentialsPropsV1 } from './student-credentials-v1';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { createQrOperationV1, type QrOperationStateV1 } from './qr-operation-v1';
import { createQrPrintV1 } from './qr-print-v1';
import { qrFilenameV1 } from './qr-filename-v1';
import { copyQrImageV1, createQrDownloadsV1, pngDataUrlV1 } from './qr-browser-v1';
import { renderQrAccessCardV1 } from './qr-access-card-render-v1';
import type { QrArtifactV1 } from './qr-values-v1';
import {
  readCurrentPhotoV1,
  PHOTO_CHANGED_EVENT_V1,
  type PhotoChangedDetailV1,
} from '../../student-photos/catalog-client-v1';
import { photoSubjectKeyV1 } from '../../../../shared/student-photos/catalog-v1';
import { PhotoAdminClientErrorV1 } from '../../student-photos/admin-client-v1';

export function IndividualQrV1(
  props: StudentCredentialsPropsV1 & { scope: Extract<ScopeV1, { kind: 'account' }> },
) {
  const { client, reader, canWrite, scope, renderArtifact } = props;
  const [state, setState] = useState<QrOperationStateV1>({ state: 'idle' });
  const [notice, setNotice] = useState('');
  const [clock, setClock] = useState(Date.now);
  const [cardState, setCardState] = useState<'idle' | 'rendering' | 'ready' | 'error'>('idle');
  const [cardCopy, setCardCopy] = useState<'none' | 'pending' | 'copied' | 'download-required'>(
    'none',
  );
  const [cardDownloadFailed, setCardDownloadFailed] = useState(false);
  const [cardNoPhoto, setCardNoPhoto] = useState(false);
  const [cardRetry, setCardRetry] = useState(0);
  const [photoRevision, setPhotoRevision] = useState(0);
  const card = useRef<{ artifact: QrArtifactV1; imageUrl: string } | null>(null);
  const cardDownloads = useMemo(createQrDownloadsV1, []);
  const notify = useRef(props.onAuthorizationLost);
  notify.current = props.onAuthorizationLost;
  const load = useCallback(
    async (signal: AbortSignal) => {
      const value = await reader.query(
        { contractVersion: 2, operation: 'accounts-read', scope, page: { limit: 100 } },
        signal,
      );
      if (value.state !== 'accounts-read') throw new PortalClientErrorV1('invalid-response');
      accountPageMatchesV1(value, scope);
      return value.items[0] ?? null;
    },
    [reader, scope.accountId],
  );
  const read = useAccountsReadV1(load);
  const operation = useMemo(
    () =>
      createQrOperationV1({
        client,
        canWrite,
        publish: setState,
        render: renderArtifact,
        retainUntilClear: true,
        onAuthorizationLost: (error) => notify.current?.(error),
      }),
    [client, canWrite, renderArtifact],
  );
  const printer = useMemo(createQrPrintV1, []);
  const photoSubject = useMemo(
    () => ({
      source: 'portal' as const,
      academicYear: scope.academicYear,
      accountIds: [scope.accountId],
    }),
    [scope.accountId, scope.academicYear],
  );
  const requested = useRef<string | null>(null);
  useEffect(() => {
    const clear = () => {
      requested.current = null;
      operation.clear();
      printer.clear();
      card.current = null;
      cardDownloads.clear();
    };
    window.addEventListener('pagehide', clear);
    return () => {
      window.removeEventListener('pagehide', clear);
      clear();
    };
  }, [operation, printer, cardDownloads]);
  useEffect(() => {
    const subjectKey = photoSubjectKeyV1(photoSubject);
    const changed = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Partial<PhotoChangedDetailV1> | undefined;
      if (detail?.subjectKey === subjectKey) setPhotoRevision((value) => value + 1);
    };
    window.addEventListener(PHOTO_CHANGED_EVENT_V1, changed);
    return () => window.removeEventListener(PHOTO_CHANGED_EVENT_V1, changed);
  }, [photoSubject]);
  useEffect(() => {
    let failure;
    if (read.state.state === 'error') {
      failure = read.state.error;
    } else if (read.state.state === 'ready') {
      failure = read.state.refreshError;
    } else {
      failure = undefined;
    }
    if (failure && ['unauthenticated', 'forbidden'].includes(failure.state)) {
      operation.clear();
      printer.clear();
      notify.current?.(failure);
      return;
    }
    if (read.state.state !== 'ready' || !read.state.data || !canWrite) return;
    const account = read.state.data;
    if (!account.firstAccess.qrIssued) return;
    const key = account.accountId + ':' + account.version;
    if (requested.current === key) return;
    requested.current = key;
    operation.clear();
    void operation.submit(
      {
        contractVersion: 1,
        operation: 'qr-reprint',
        accountId: account.accountId,
        expectedVersion: account.version,
        idempotencyKey: crypto.randomUUID(),
      },
      'png',
    );
  }, [read.state, canWrite, operation, printer]);
  useEffect(() => {
    if (state.state !== 'error') return;
    setClock(Date.now());
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, state.retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state]);
  const account = read.state.state === 'ready' ? read.state.data : null;
  useEffect(() => {
    card.current = null;
    setCardCopy('none');
    setCardDownloadFailed(false);
    if (state.state !== 'ready' || !account) {
      setCardState('idle');
      return;
    }
    const qr = operation.imageBlob();
    if (!qr) {
      setCardState('idle');
      return;
    }
    const controller = new AbortController();
    setCardState('rendering');
    void (async () => {
      const photo = await readCurrentPhotoV1(photoSubject, null, controller.signal);
      const artifact = await renderQrAccessCardV1(
        {
          qr,
          photo,
          name: account.name || 'Nome indisponível',
          classLabel: account.classLabel || 'Turma não resolvida',
        },
        controller.signal,
      );
      const imageUrl = await pngDataUrlV1(artifact.blob);
      controller.signal.throwIfAborted();
      card.current = { artifact, imageUrl };
      setCardNoPhoto(!photo);
      setCardState('ready');
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (
        error instanceof PhotoAdminClientErrorV1 &&
        (error.code === 'unauthenticated' || error.code === 'forbidden')
      ) {
        operation.clear();
        printer.clear();
        cardDownloads.clear();
        notify.current?.(new PortalClientErrorV1(error.code));
        return;
      }
      setCardState('error');
    });
    return () => {
      controller.abort();
      card.current = null;
    };
  }, [
    state.state,
    account?.accountId,
    account?.version,
    account?.name,
    account?.classLabel,
    operation,
    printer,
    cardDownloads,
    photoSubject,
    photoRevision,
    cardRetry,
  ]);
  const imageUrl = state.state === 'ready' ? operation.imageUrl() : null;
  function downloadCard() {
    if (!card.current) return;
    try {
      const filename = qrFilenameV1(account?.name, 'png').replace(
        /^QR DO /u,
        'CARTÃO DE ACESSO - ',
      );
      cardDownloads.download(card.current.artifact, filename);
      setCardDownloadFailed(false);
    } catch {
      setCardDownloadFailed(true);
    }
  }
  async function copyCard() {
    const current = card.current;
    if (!current || cardCopy === 'pending') return;
    setCardCopy('pending');
    const result = await copyQrImageV1(current.artifact);
    if (card.current === current) setCardCopy(result);
  }
  function printCard() {
    if (!card.current) return;
    void printer.print(card.current.imageUrl).then((ok) => {
      if (!ok)
        setNotice(
          'Não foi possível imprimir o cartão. Baixe a imagem para imprimir pelo navegador.',
        );
    });
  }
  return (
    <Card className="pa-individual-qr" aria-label="QR atual do aluno">
      <Card.Content>
        {!canWrite ? (
          <p role="status">Somente operadores autorizados podem consultar o QR.</p>
        ) : null}
        {read.state.state === 'error' ? (
          <AccountsErrorV1
            error={read.state.error}
            canReload={read.canReload}
            onReload={read.reload}
          />
        ) : null}
        {canWrite && read.state.state === 'ready' && !read.state.data?.firstAccess.qrIssued ? (
          <p role="status">
            Nenhum QR emitido. Use a emissão pela turma; abrir esta ficha não cria nem troca
            credenciais.
          </p>
        ) : null}
        {state.state === 'requesting' ||
        state.state === 'rendering' ||
        read.state.state === 'loading' ? (
          <p role="status">Carregando QR atual…</p>
        ) : null}
        {imageUrl ? (
          <div className="pa-individual-qr-variants">
            <div className="pa-individual-qr-variant">
              <h4>QR puro</h4>
              <div className="pa-individual-qr-layout">
                <img src={imageUrl} alt="QR atual de acesso" width={224} height={224} />
                <div className="pa-individual-qr-actions">
                  <Button onPress={() => operation.download(qrFilenameV1(account?.name, 'png'))}>
                    Baixar QR
                  </Button>
                  <Button
                    variant="secondary"
                    onPress={() => void operation.copy()}
                    isDisabled={state.state === 'ready' && state.copy === 'pending'}
                  >
                    Copiar QR
                  </Button>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      void printer.print(imageUrl).then((ok) => {
                        if (!ok)
                          setNotice(
                            'Não foi possível imprimir o QR. Baixe a imagem para imprimir pelo navegador.',
                          );
                      });
                    }}
                  >
                    Imprimir QR
                  </Button>
                </div>
              </div>
            </div>
            <div className="pa-individual-qr-variant">
              <h4>Cartão completo</h4>
              {cardState === 'rendering' && <p role="status">Preparando cartão…</p>}
              {cardState === 'error' && (
                <div role="alert">
                  <p>Não foi possível preparar o cartão.</p>
                  <Button variant="secondary" onPress={() => setCardRetry((value) => value + 1)}>
                    Tentar novamente
                  </Button>
                </div>
              )}
              {cardState === 'ready' && card.current && (
                <>
                  <img
                    className="pa-individual-qr-card-image"
                    src={card.current.imageUrl}
                    alt="Cartão completo de acesso"
                    width={856}
                    height={540}
                  />
                  {cardNoPhoto && <p role="status">Cartão sem foto cadastrada.</p>}
                  <div className="pa-credentials-actions">
                    <Button onPress={downloadCard}>Baixar cartão</Button>
                    <Button
                      variant="secondary"
                      isDisabled={cardCopy === 'pending'}
                      onPress={() => void copyCard()}
                    >
                      Copiar cartão
                    </Button>
                    <Button variant="secondary" onPress={printCard}>
                      Imprimir cartão
                    </Button>
                  </div>
                </>
              )}
              {cardCopy === 'copied' && <p role="status">Cartão copiado.</p>}
              {cardCopy === 'download-required' && (
                <p role="alert">Cópia indisponível neste navegador. Use Baixar cartão.</p>
              )}
              {cardDownloadFailed && (
                <p role="alert">O download do cartão não começou. Tente novamente.</p>
              )}
            </div>
          </div>
        ) : null}
        {state.state === 'ready' && state.copy === 'copied' ? (
          <p role="status">Imagem copiada.</p>
        ) : null}
        {state.state === 'ready' && state.copy === 'download-required' ? (
          <p role="alert">Cópia indisponível neste navegador. Use Baixar QR.</p>
        ) : null}
        {state.state === 'ready' && state.downloadFailed ? (
          <p role="alert">O download não começou. Tente novamente.</p>
        ) : null}
        {state.state === 'error' ? (
          <div role="alert">
            <p>
              {state.stage === 'render'
                ? 'O QR foi consultado, mas a imagem não ficou pronta. A nova tentativa não troca o QR.'
                : 'Não foi possível consultar o QR atual.'}
            </p>
            {state.retryable ? (
              <Button
                variant="secondary"
                isDisabled={clock < state.retryAt}
                onPress={() => void operation.retry()}
              >
                Tentar novamente
              </Button>
            ) : (
              <Button
                variant="secondary"
                isDisabled={clock < state.retryAt}
                onPress={() => {
                  requested.current = null;
                  read.reload();
                }}
              >
                Recarregar QR atual
              </Button>
            )}
          </div>
        ) : null}
        {notice ? <p role="alert">{notice}</p> : null}
      </Card.Content>
    </Card>
  );
}
