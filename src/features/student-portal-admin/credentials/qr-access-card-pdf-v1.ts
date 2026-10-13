import { PDFDocument, PrintScaling, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { PhotoAdminClientErrorV1 } from '../../student-photos/admin-client-v1';
import { readCurrentPhotoV1 } from '../../student-photos/catalog-client-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import {
  QR_ACCESS_CARD_ART_V1,
  renderQrAccessCardBackgroundV1,
  renderQrAccessCardPrintV1,
} from './qr-access-card-render-v1';
import { QR_LAYOUT_V1, qrMatrixV1 } from './qr-artifacts-v1';
import { qrLayerPathsV1 } from './qr-shapes-v1';
import {
  QrArtifactErrorV1,
  validatePrintCardCollectionV1,
  type QrArtifactV1,
} from './qr-values-v1';

const ptPerMm = 72 / 25.4;
/** Cards keep the art's own proportion (93.5 × 59 mm, what fits the lamination pouch) and touch
 * each other, so one knife stroke separates two neighbours. No cut guide is printed.
 */
export const QR_ACCESS_CARD_PDF_LAYOUT_V1 = {
  pageWidth: QR_LAYOUT_V1.pageWidth,
  pageHeight: QR_LAYOUT_V1.pageHeight,
  cardWidth: ((59 * QR_ACCESS_CARD_ART_V1.width) / QR_ACCESS_CARD_ART_V1.height) * ptPerMm,
  cardHeight: 59 * ptPerMm,
  columnGap: 0,
  rowGap: 0,
  columns: 2,
  rows: 4,
  rulerLength: 50 * ptPerMm,
} as const;
// Production serves photos over HTTP/2: a whole class downloads in about one round trip.
const PHOTO_CONCURRENCY = 32;
const PHOTO_RETRY_DELAYS_MS = [400, 1_200] as const;

type CardPdfDependenciesV1 = {
  readPhoto: typeof readCurrentPhotoV1;
  renderCard: typeof renderQrAccessCardPrintV1;
  renderBackground: typeof renderQrAccessCardBackgroundV1;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};
const waitV1 = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
  });
const defaultDependencies: CardPdfDependenciesV1 = {
  readPhoto: readCurrentPhotoV1,
  renderCard: renderQrAccessCardPrintV1,
  renderBackground: renderQrAccessCardBackgroundV1,
  wait: waitV1,
};

/** Grid origin (PDF coordinates, bottom-left) centred on the page, away from printer margins. */
export function qrAccessCardSlotV1(slot: number) {
  const layout = QR_ACCESS_CARD_PDF_LAYOUT_V1;
  const gridWidth = layout.columns * layout.cardWidth + (layout.columns - 1) * layout.columnGap;
  const gridHeight = layout.rows * layout.cardHeight + (layout.rows - 1) * layout.rowGap;
  const left = (layout.pageWidth - gridWidth) / 2;
  const top = layout.pageHeight - (layout.pageHeight - gridHeight) / 2;
  const column = slot % layout.columns;
  const row = Math.floor(slot / layout.columns);
  return {
    x: left + column * (layout.cardWidth + layout.columnGap),
    y: top - layout.cardHeight - row * (layout.cardHeight + layout.rowGap),
  };
}

/** A missing or unreadable portrait still prints (owner decision); only lost access stops. */
async function readPhotoOrNoneV1(
  dependencies: CardPdfDependenciesV1,
  accountId: string,
  academicYear: number,
  signal: AbortSignal,
): Promise<Blob | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await dependencies.readPhoto(
        { source: 'portal', academicYear, accountIds: [accountId] },
        null,
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof PhotoAdminClientErrorV1 &&
        (error.code === 'unauthenticated' || error.code === 'forbidden')
      )
        throw new PortalClientErrorV1(error.code);
      const delay = PHOTO_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) return undefined;
      await dependencies.wait(delay, signal);
    }
  }
}

export type QrCardPhotoSourceV1 = (accountId: string) => Promise<Blob | undefined>;

/** Starts every portrait download at once (bounded), so they overlap the credential request.
 * Blobs stay in memory only for this batch; the signal stops downloads that are still queued.
 */
export function prefetchQrCardPhotosV1(
  accountIds: readonly string[],
  academicYear: number,
  signal: AbortSignal,
  dependencies: CardPdfDependenciesV1 = defaultDependencies,
): QrCardPhotoSourceV1 {
  type Entry = {
    accountId: string;
    photo: Promise<Blob | undefined>;
    resolve: (photo: Blob | undefined) => void;
    reject: (error: unknown) => void;
  };
  const pending = new Map<string, Promise<Blob | undefined>>();
  const queue: Entry[] = [];
  for (const accountId of accountIds) {
    const key = accountId.toLowerCase();
    if (pending.has(key)) continue;
    const entry = { accountId } as Entry;
    entry.photo = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
    entry.photo.catch(() => {}); // Awaited in card order; a stopped batch must not leak rejections.
    pending.set(key, entry.photo);
    queue.push(entry);
  }
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const entry = queue[next++]!;
      // Queued portraits still settle after a stop, so no caller waits forever.
      if (signal.aborted) {
        entry.reject(signal.reason);
        continue;
      }
      try {
        entry.resolve(await readPhotoOrNoneV1(dependencies, entry.accountId, academicYear, signal));
      } catch (error) {
        entry.reject(error);
      }
    }
  };
  for (let index = 0; index < Math.min(PHOTO_CONCURRENCY, queue.length); index++) void worker();
  return (accountId) =>
    pending.get(accountId.toLowerCase()) ??
    readPhotoOrNoneV1(dependencies, accountId, academicYear, signal);
}

export type QrCardIdentityV1 = { accountId: string; name: string; classLabel: string };
export type QrCardArtSourceV1 = (card: QrCardIdentityV1) => Promise<Blob>;

/** Paints card art (portrait, name, class; the QR is vector) as portraits arrive, so the batch
 * can start at click time, while the server is still issuing the credentials.
 */
export function prepareQrCardArtV1(
  identities: readonly QrCardIdentityV1[],
  academicYear: number,
  signal: AbortSignal,
  dependencies: CardPdfDependenciesV1 = defaultDependencies,
): QrCardArtSourceV1 {
  const photoFor = prefetchQrCardPhotosV1(
    identities.map((card) => card.accountId),
    academicYear,
    signal,
    dependencies,
  );
  const paint = async (card: QrCardIdentityV1) => {
    const photo = await photoFor(card.accountId);
    signal.throwIfAborted();
    const identity = { name: card.name, classLabel: card.classLabel };
    try {
      return await dependencies.renderCard({ ...identity, photo }, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!photo) throw error;
      return dependencies.renderCard(identity, signal); // Undecodable portrait.
    }
  };
  const painted = new Map<string, QrCardIdentityV1 & { art: Promise<Blob> }>();
  let queue: Promise<unknown> = Promise.resolve();
  for (const card of identities) {
    const key = card.accountId.toLowerCase();
    if (painted.has(key)) continue;
    const art = queue.then(() => paint(card)); // One canvas at a time, in list order.
    art.catch(() => {}); // Awaited in card order; a stopped batch must not leak rejections.
    queue = art.catch(() => {});
    painted.set(key, { ...card, art });
  }
  return (card) => {
    const entry = painted.get(card.accountId.toLowerCase());
    // The server's name and class win: art painted from a stale list row is repainted.
    return entry?.name === card.name && entry.classLabel === card.classLabel
      ? entry.art
      : paint(card);
  };
}

function drawCalibrationV1(page: PDFPage, font: PDFFont) {
  const layout = QR_ACCESS_CARD_PDF_LAYOUT_V1;
  const color = rgb(0.45, 0.5, 0.58);
  const center = layout.pageWidth / 2;
  const y = 12 * ptPerMm;
  const start = center - layout.rulerLength / 2;
  const end = center + layout.rulerLength / 2;
  page.drawLine({ start: { x: start, y }, end: { x: end, y }, thickness: 0.5, color });
  for (const x of [start, end])
    page.drawLine({
      start: { x, y: y - 1.5 * ptPerMm },
      end: { x, y: y + 1.5 * ptPerMm },
      thickness: 0.5,
      color,
    });
  const text = 'Imprima em tamanho real (100%). A linha acima deve medir 5 cm.';
  const size = 7;
  page.drawText(text, {
    x: center - font.widthOfTextAtSize(text, size) / 2,
    y: 7 * ptPerMm,
    size,
    font,
    color,
  });
}

/** Print complete cards only after an explicit batch request; private images stay in memory. */
export async function renderQrAccessCardsPdfV1(
  input: unknown,
  academicYear: number,
  signal: AbortSignal,
  progress: (completed: number, total: number) => void = () => {},
  dependencies: CardPdfDependenciesV1 = defaultDependencies,
  prepared?: QrCardArtSourceV1,
): Promise<QrArtifactV1> {
  signal.throwIfAborted();
  if (!Number.isInteger(academicYear) || academicYear < 1900 || academicYear > 9999)
    throw new QrArtifactErrorV1('invalid-cards');
  const cards = validatePrintCardCollectionV1(input).map((card) => {
    if (card.mode !== 'qr-name-class') throw new QrArtifactErrorV1('invalid-cards');
    return card;
  });
  const pdf = await PDFDocument.create();
  pdf.setTitle('Cartões de acesso');
  pdf.setCreator('Centro de Administração');
  // Viewers must not shrink the sheet to "fit": the card size is fixed by the pouch.
  pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const layout = QR_ACCESS_CARD_PDF_LAYOUT_V1;
  const art = QR_ACCESS_CARD_ART_V1;
  const perPage = layout.columns * layout.rows;
  const unit = layout.cardHeight / art.height; // Same scale on both axes: original proportion.
  // One shared background image for every card; each card adds only its student band.
  const background = pdf.embedJpg(
    await (await dependencies.renderBackground(signal)).arrayBuffer(),
  );
  background.catch(() => {}); // Awaited by the first card; a stopped batch must not leak it.
  const quiet = QR_LAYOUT_V1.quietModules;

  // Art is painted ahead (portraits in parallel) while earlier cards are embedded.
  const artController = new AbortController();
  const stopArt = () => artController.abort(signal.reason);
  signal.addEventListener('abort', stopArt, { once: true });
  const artFor =
    prepared ?? prepareQrCardArtV1(cards, academicYear, artController.signal, dependencies);

  let page: PDFPage | undefined;
  try {
    progress(0, cards.length);
    for (const [index, card] of cards.entries()) {
      signal.throwIfAborted();
      if (index % perPage === 0) {
        page = pdf.addPage([layout.pageWidth, layout.pageHeight]);
        drawCalibrationV1(page, font);
      }
      const artBlob = await artFor(card);
      signal.throwIfAborted();
      const image = await pdf.embedJpg(await artBlob.arrayBuffer());
      signal.throwIfAborted();

      const { x, y } = qrAccessCardSlotV1(index % perPage);
      page!.drawImage(await background, {
        x,
        y,
        width: layout.cardWidth,
        height: layout.cardHeight,
      });
      const band = art.student;
      page!.drawImage(image, {
        x: x + band.x * unit,
        y: y + layout.cardHeight - (band.y + band.height) * unit,
        width: band.width * unit,
        height: band.height * unit,
      });

      // Vector QR over the art's white QR box: crisp modules at any printer resolution.
      const matrix = qrMatrixV1(card.qr);
      const qrSize = art.qr.size * unit;
      const qrX = x + art.qr.x * unit;
      const qrTop = y + layout.cardHeight - art.qr.y * unit;
      page!.drawRectangle({
        x: qrX,
        y: qrTop - qrSize,
        width: qrSize,
        height: qrSize,
        color: rgb(1, 1, 1),
      });
      // SVG coordinates increase downwards; pdf-lib's path operator applies the matching Y flip.
      for (const shape of qrLayerPathsV1(matrix, quiet))
        page!.drawSvgPath(shape.path, {
          x: qrX,
          y: qrTop,
          scale: qrSize / (matrix.size + 2 * quiet),
          color: shape.dark ? rgb(0, 0, 0) : rgb(1, 1, 1),
          borderWidth: 0,
        });
      progress(index + 1, cards.length);
    }
  } finally {
    signal.removeEventListener('abort', stopArt);
    artController.abort();
  }
  signal.throwIfAborted();
  const bytes = await pdf.save({ objectsPerTick: 30 });
  signal.throwIfAborted();
  return {
    blob: new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
    format: 'pdf',
    count: cards.length,
    pages: pdf.getPageCount(),
  };
}
