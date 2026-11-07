import type { PhotoAdminSubjectV1 } from '../../../shared/student-photos/admin-http-v1';
import { initialPhotoCropV1 } from '../../../shared/student-photos/crop-v1';
import { photoQualitiesV1 } from '../../../shared/student-photos/preview-v1';
import type { PhotoWriteCommandV1 } from '../../../shared/student-photos/write-v1';
import { createPhotoAdminClientV1, PhotoAdminClientErrorV1 } from './admin-client-v1';
import { loadPhotoSourceV1, prepareAvatarDraftV1 } from './browser-v1';
import { readCurrentPhotoV1, readPhotoCatalogV1, recoverPhotoWriteV1 } from './catalog-client-v1';

/**
 * Avatar for a student whose saved photo has only the portrait (photos adopted from the previous
 * storage). It is the "Ajustar avatar" operation with the standard framing: the same preview and
 * save boundaries, the same journal and the same checks. The portrait is never touched.
 */
export type AvatarBackfillOutcomeV1 = 'created' | 'present' | 'no-portrait' | 'pending' | 'failed';
export interface AvatarBackfillPortsV1 {
  catalog: typeof readPhotoCatalogV1;
  portrait: typeof readCurrentPhotoV1;
  load: typeof loadPhotoSourceV1;
  prepare: typeof prepareAvatarDraftV1;
  client: Pick<ReturnType<typeof createPhotoAdminClientV1>, 'preview' | 'save'>;
  recover: typeof recoverPhotoWriteV1;
  requestId(): string;
}
const QUALITY_V1 = 0.86;
const defaultPortsV1 = (): AvatarBackfillPortsV1 => ({
  catalog: readPhotoCatalogV1,
  portrait: readCurrentPhotoV1,
  load: loadPhotoSourceV1,
  prepare: prepareAvatarDraftV1,
  client: createPhotoAdminClientV1(),
  recover: recoverPhotoWriteV1,
  requestId: () => crypto.randomUUID(),
});
const accessLostV1 = (error: unknown) =>
  error instanceof PhotoAdminClientErrorV1 &&
  (error.code === 'unauthenticated' || error.code === 'forbidden');

/** Finishes a durable write of this operator; anything still open stays for the student's sheet. */
async function concludeV1(
  subject: PhotoAdminSubjectV1,
  requestId: string,
  signal: AbortSignal,
  ports: AvatarBackfillPortsV1,
) {
  try {
    const result = await ports.recover(subject, requestId, signal);
    return result.state === 'committed' && !result.cleanupPending;
  } catch (error) {
    if (signal.aborted || accessLostV1(error)) throw error;
    return false;
  }
}

/** One student. Access loss is thrown so a batch stops; any other failure is this student's alone. */
export async function deriveMissingAvatarV1(
  subject: PhotoAdminSubjectV1,
  signal: AbortSignal,
  ports: AvatarBackfillPortsV1 = defaultPortsV1(),
): Promise<AvatarBackfillOutcomeV1> {
  signal.throwIfAborted();
  let { catalog, canWrite } = await ports.catalog(subject, signal);
  if (!canWrite) throw new PhotoAdminClientErrorV1('forbidden');
  if (catalog.pendingRequest) {
    // Another operator's unfinished change is theirs to conclude.
    if (!catalog.ownPending || !(await concludeV1(subject, catalog.pendingRequest, signal, ports)))
      return 'pending';
    ({ catalog, canWrite } = await ports.catalog(subject, signal));
    if (!canWrite) throw new PhotoAdminClientErrorV1('forbidden');
    if (catalog.pendingRequest) return 'pending';
  }
  if (!catalog.initialized || !catalog.hasPortrait) return 'no-portrait';
  if (catalog.hasAvatar) return 'present';
  const blob = await ports.portrait(subject, catalog.revision, signal);
  if (!blob) return 'no-portrait';
  const source = await ports.load(blob, signal);
  let bytes: Uint8Array;
  try {
    const avatar = await ports.prepare(source, initialPhotoCropV1('avatar'), QUALITY_V1, signal);
    bytes = new Uint8Array(await avatar.blob.arrayBuffer());
  } finally {
    source.dispose();
  }
  const images = { portrait: null, avatar: bytes };
  try {
    signal.throwIfAborted();
    const command: PhotoWriteCommandV1 = {
      requestId: ports.requestId(),
      expectedRevision: catalog.revision,
      kind: 'avatar',
    };
    const qualities = photoQualitiesV1.parse({
      portrait: null,
      avatar: Math.round(QUALITY_V1 * 100),
    });
    const preview = await ports.client.preview(subject, command, qualities, images, signal);
    preview.images.avatar?.fill(0);
    const saved = await ports.client.save(subject, command, preview.approval, images, signal);
    if (saved.state === 'committed' && !saved.cleanupPending) return 'created';
    // The write is durable; finish it once here rather than leaving it for the student's sheet.
    return (await concludeV1(subject, command.requestId, signal, ports)) ? 'created' : 'pending';
  } finally {
    bytes.fill(0);
  }
}

export type AvatarBackfillSummaryV1 = Record<AvatarBackfillOutcomeV1, number> & {
  done: number;
  total: number;
};
const emptyAvatarBackfillV1 = (total: number): AvatarBackfillSummaryV1 => ({
  created: 0,
  present: 0,
  'no-portrait': 0,
  pending: 0,
  failed: 0,
  done: 0,
  total,
});

/** Two students at a time; stops at once when the session or the permission is lost. */
export async function backfillAvatarsV1(
  subjects: readonly PhotoAdminSubjectV1[],
  options: {
    signal: AbortSignal;
    onProgress?(summary: AvatarBackfillSummaryV1): void;
    ports?: AvatarBackfillPortsV1;
  },
): Promise<AvatarBackfillSummaryV1> {
  const ports = options.ports ?? defaultPortsV1();
  const summary = emptyAvatarBackfillV1(subjects.length);
  const stop = new AbortController();
  const abort = () => stop.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) stop.abort();
  let next = 0;
  let denied: unknown;
  const worker = async () => {
    while (!stop.signal.aborted && next < subjects.length) {
      const subject = subjects[next++]!;
      let outcome: AvatarBackfillOutcomeV1;
      try {
        outcome = await deriveMissingAvatarV1(subject, stop.signal, ports);
      } catch (error) {
        if (stop.signal.aborted) return;
        if (accessLostV1(error)) {
          denied = error;
          stop.abort();
          return;
        }
        outcome = 'failed';
      }
      summary[outcome] += 1;
      summary.done += 1;
      options.onProgress?.({ ...summary });
    }
  };
  try {
    await Promise.all([worker(), worker()]);
  } finally {
    options.signal.removeEventListener('abort', abort);
  }
  if (denied) throw denied;
  options.signal.throwIfAborted();
  return summary;
}
