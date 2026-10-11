import {
  adminCommandV1,
  type AdminCommandV1,
} from '../../../../shared/student-portal-contracts/admin-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import {
  validatePrintCardsV1,
  validatePrintCardCollectionV1,
  type PrintCardV1,
  type QrArtifactV1,
} from './qr-values-v1';
import { copyQrImageV1, createQrDownloadsV1, pngDataUrlV1 } from './qr-browser-v1';

export type QrCommandV1 = Extract<
  AdminCommandV1,
  { operation: 'qr-issue' | 'qr-reprint' | 'qr-batch' }
>;
export type QrOperationStateV1 =
  | { state: 'idle' | 'cancelled' | 'expired' }
  | { state: 'requesting'; count: number; completed: number }
  | { state: 'rendering'; completed: number; total: number }
  | {
      state: 'ready';
      format: 'pdf' | 'png';
      count: number;
      pages: number;
      copy: 'none' | 'pending' | 'copied' | 'download-required';
      downloadFailed: boolean;
    }
  | {
      state: 'error';
      stage: 'request' | 'render';
      error: PortalClientErrorV1;
      retryable: boolean;
      retryAt: number;
    };
export type QrRendererV1 = (
  cards: PrintCardV1[],
  format: 'pdf' | 'png',
  signal: AbortSignal,
  progress: (completed: number, total: number) => void,
) => Promise<QrArtifactV1>;
const defaultRenderer: QrRendererV1 = async (cards, format, signal, progress) => {
  const render = await import('./qr-artifacts-v1');
  signal.throwIfAborted();
  return format === 'pdf'
    ? render.renderQrPdfV1(cards, signal, progress)
    : render.renderQrPngV1(cards[0]!.qr, signal);
};
function orderedCardsV1(received: PrintCardV1[], captured: QrCommandV1, responseVersion: number) {
  const ids = captured.operation === 'qr-batch' ? captured.accountIds : [captured.accountId];
  const mode = captured.operation === 'qr-batch' ? captured.mode : 'qr-only';
  const byId = new Map(received.map((card) => [card.accountId.toLowerCase(), card]));
  const missing = ids.some((id) => !byId.has(id.toLowerCase()));
  const wrongMode = received.some((card) => card.mode !== mode);
  if (
    received.length !== ids.length ||
    missing ||
    wrongMode ||
    responseVersion < captured.expectedVersion
  )
    throw new PortalClientErrorV1('invalid-response');
  return ids.map((id) => byId.get(id.toLowerCase())!);
}

function artifactValidV1(artifact: QrArtifactV1, format: 'pdf' | 'png', expectedCount: number) {
  const expectedType = format === 'pdf' ? 'application/pdf' : 'image/png';
  return (
    artifact.format === format &&
    artifact.count === expectedCount &&
    artifact.blob.size > 0 &&
    artifact.blob.type === expectedType
  );
}

/** Credentials/blobs never enter React state, errors, URLs or persistent storage. */
export function createQrOperationV1({
  client,
  publish,
  canWrite,
  render = defaultRenderer,
  now = Date.now,
  onAuthorizationLost,
  retainUntilClear = false,
}: Readonly<{
  retainUntilClear?: boolean;
  client: PortalAdminClientV1;
  publish: (state: QrOperationStateV1) => void;
  canWrite: boolean;
  render?: QrRendererV1;
  now?: () => number;
  onAuthorizationLost?: (error: PortalClientErrorV1) => void;
}>) {
  let state: QrOperationStateV1 = { state: 'idle' };
  let generation = 0;
  let active: AbortController | undefined;
  let prepared: ReturnType<PortalAdminClientV1['prepareCommand']> | undefined;
  let command: QrCommandV1 | undefined;
  let queue: QrCommandV1[] = [];
  let format: 'pdf' | 'png' = 'pdf';
  let cards: PrintCardV1[] | undefined;
  let artifact: QrArtifactV1 | undefined;
  let previewUrl: string | undefined;
  let startedAt = 0;
  let expires: ReturnType<typeof setTimeout> | undefined;
  const downloads = createQrDownloadsV1();

  function emit(next: QrOperationStateV1) {
    state = next;
    publish(next);
  }

  function clear(next: 'idle' | 'cancelled' | 'expired' = 'idle') {
    generation++;
    active?.abort();
    active = undefined;
    clearTimeout(expires);
    expires = undefined;
    previewUrl = undefined;
    prepared = command = cards = artifact = undefined;
    queue = [];
    downloads.clear();
    emit({ state: next });
  }

  async function requestCards(current: number, controller: AbortController) {
    while (command && prepared) {
      const captured = command!;
      emit({
        state: 'requesting',
        count:
          (cards?.length ?? 0) +
          (captured.operation === 'qr-batch' ? captured.accountIds.length : 1) +
          queue.reduce(
            (total, next) => total + (next.operation === 'qr-batch' ? next.accountIds.length : 1),
            0,
          ),
        completed: cards?.length ?? 0,
      });
      const response = await prepared!.execute(controller.signal);
      if (current !== generation || controller.signal.aborted) return false;
      if (response.state !== 'qr') throw new PortalClientErrorV1('invalid-response');

      let received: PrintCardV1[];
      try {
        received = validatePrintCardsV1(response.cards);
      } catch {
        throw new PortalClientErrorV1('invalid-response');
      }
      cards = [...(cards ?? []), ...orderedCardsV1(received, captured, response.version)];
      prepared = command = undefined;
      const next = queue.shift();
      if (next) {
        command = { ...next, expectedVersion: response.version };
        prepared = client.prepareCommand(command);
      }
    }
    cards = validatePrintCardCollectionV1(cards);
    return true;
  }

  async function renderCards(current: number, controller: AbortController) {
    const currentCards = cards!;
    emit({ state: 'rendering', completed: 0, total: currentCards.length });
    const result = await render(currentCards, format, controller.signal, (completed, total) => {
      if (current === generation && !controller.signal.aborted)
        emit({ state: 'rendering', completed, total });
    });
    if (current !== generation || controller.signal.aborted) return;
    if (!artifactValidV1(result, format, currentCards.length))
      throw new Error('artifact-unavailable');
    const preview = format === 'png' ? await pngDataUrlV1(result.blob) : undefined;
    if (current !== generation || controller.signal.aborted) return;

    artifact = result;
    previewUrl = preview;
    cards = undefined;
    emit({
      state: 'ready',
      format,
      count: result.count,
      pages: result.pages,
      copy: 'none',
      downloadFailed: false,
    });
    if (!retainUntilClear) expires = setTimeout(() => clear('expired'), 5 * 60_000);
  }

  function handleFailure(
    error: unknown,
    stage: 'request' | 'render',
    current: number,
    controller: AbortController,
  ) {
    if (current !== generation || controller.signal.aborted) return;
    const failure =
      error instanceof PortalClientErrorV1 ? error : new PortalClientErrorV1('unavailable');
    if (failure.state === 'unauthenticated' || failure.state === 'forbidden') {
      clear();
      emit({ state: 'error', stage, error: failure, retryable: false, retryAt: 0 });
      onAuthorizationLost?.(failure);
      return;
    }
    const retryable =
      stage === 'render' ||
      ['network-error', 'invalid-response', 'unavailable', 'rate-limited'].includes(failure.state);
    if (!retryable) {
      prepared = command = cards = undefined;
      queue = [];
    }
    emit({
      state: 'error',
      stage,
      error: failure,
      retryable,
      retryAt: now() + (failure.retryAfterSeconds ?? 0) * 1000,
    });
  }

  async function run() {
    if (active || (!prepared && !cards) || (state.state === 'error' && now() < state.retryAt))
      return;
    if (prepared && now() - startedAt >= 23 * 3_600_000) {
      clear('expired');
      return;
    }

    const current = ++generation;
    const controller = new AbortController();
    active = controller;
    let stage: 'request' | 'render' = prepared ? 'request' : 'render';
    try {
      if (prepared) {
        if (!(await requestCards(current, controller))) return;
        stage = 'render';
      }
      await renderCards(current, controller);
    } catch (error) {
      handleFailure(error, stage, current, controller);
    } finally {
      if (current === generation) active = undefined;
    }
  }

  return {
    async submit(input: QrCommandV1, requestedFormat: 'pdf' | 'png') {
      if (!canWrite || active || prepared || cards || artifact) return;
      const chunks: QrCommandV1[] = [];
      if (input.operation === 'qr-batch') {
        if (
          !input.accountIds.length ||
          new Set(input.accountIds.map((id) => id.toLowerCase())).size !== input.accountIds.length
        )
          throw new PortalClientErrorV1('invalid-request');
        for (let offset = 0; offset < input.accountIds.length; offset += 4)
          chunks.push({
            ...input,
            accountIds: input.accountIds.slice(offset, offset + 4),
            idempotencyKey: offset === 0 ? input.idempotencyKey : crypto.randomUUID(),
          });
      } else chunks.push(input);
      const parsed = adminCommandV1.safeParse(chunks[0]);
      if (
        !parsed.success ||
        chunks.some((chunk) => !adminCommandV1.safeParse(chunk).success) ||
        !['qr-issue', 'qr-reprint', 'qr-batch'].includes(parsed.data.operation) ||
        (requestedFormat === 'png' && input.operation === 'qr-batch') ||
        (requestedFormat === 'pdf' && input.operation !== 'qr-batch')
      )
        throw new PortalClientErrorV1('invalid-request');
      command = parsed.data as QrCommandV1;
      queue = chunks.slice(1);
      format = requestedFormat;
      prepared = client.prepareCommand(command);
      startedAt = now();
      await run();
    },
    retry: run,
    async copy() {
      if (!artifact || state.state !== 'ready' || state.copy === 'pending') return;
      const current = generation;
      const ready = state;
      emit({ ...ready, copy: 'pending' });
      const result = await copyQrImageV1(artifact);
      if (current === generation) emit({ ...ready, copy: result });
    },
    imageUrl() {
      if (!artifact || state.state !== 'ready' || artifact.format !== 'png') return null;
      return previewUrl ?? null;
    },
    imageBlob() {
      if (!artifact || state.state !== 'ready' || artifact.format !== 'png') return null;
      return artifact.blob;
    },
    download(filename?: string) {
      if (!artifact || state.state !== 'ready') return;
      try {
        downloads.download(artifact, filename);
        emit({ ...state, downloadFailed: false });
      } catch {
        emit({ ...state, downloadFailed: true });
      }
    },
    cancel: () => clear('cancelled'),
    clear: () => clear(),
  };
}
