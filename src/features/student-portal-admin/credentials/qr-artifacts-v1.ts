import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { canvasBlobSyncV1 } from './canvas-encode-v1';
import { paintQrShapeV1, qrLayerPathsV1, qrShapesV1 } from './qr-shapes-v1';
import { qrUrlV1 } from '../../../../shared/student-portal-contracts/auth-v1';
import {
  QrArtifactErrorV1,
  validatePrintCardCollectionV1,
  type PrintCardV1,
  type QrArtifactV1,
} from './qr-values-v1';
export const QR_LAYOUT_V1 = {
  pageWidth: 595.28,
  pageHeight: 841.89,
  margin: (72 * 0.5) / 2.54,
  gap: 0,
  columns: 3,
  qrSize: 108,
  quietModules: 4,
} as const;
export function qrMatrixV1(qr: string) {
  if (!qrUrlV1.safeParse(qr).success) throw new QrArtifactErrorV1('invalid-cards');
  return QRCode.create(qr, { errorCorrectionLevel: 'M' }).modules;
}
export function qrSvgV1(qr: string): string {
  const matrix = qrMatrixV1(qr),
    size = matrix.size + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 8}" height="${size * 8}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="white"/>${qrLayerPathsV1(
    matrix,
  )
    .map((shape) => `<path d="${shape.path}" fill="${shape.dark ? 'black' : 'white'}"/>`)
    .join('')}</svg>`;
}
// A task boundary keeps cancellation responsive without background-tab timer throttling.
const yieldToBrowser = () =>
  new Promise<void>((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
function canvasV1(width: number, height: number) {
  if (typeof document === 'undefined') throw new QrArtifactErrorV1('render-unavailable');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new QrArtifactErrorV1('render-unavailable');
  return { canvas, context };
}
function canvasBlobV1(canvas: HTMLCanvasElement, signal: AbortSignal) {
  signal.throwIfAborted();
  return canvasBlobSyncV1(canvas, 'image/png');
}
/** The bitmap contains only black/white QR modules and the four-module quiet zone. */
export async function renderQrPngV1(qr: string, signal: AbortSignal): Promise<QrArtifactV1> {
  signal.throwIfAborted();
  const matrix = qrMatrixV1(qr),
    scale = 8,
    quiet = QR_LAYOUT_V1.quietModules;
  const { canvas, context } = canvasV1(
    (matrix.size + quiet * 2) * scale,
    (matrix.size + quiet * 2) * scale,
  );
  try {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const shape of qrShapesV1(matrix, quiet)) paintQrShapeV1(context, shape, scale);
    return { blob: await canvasBlobV1(canvas, signal), format: 'png', count: 1, pages: 1 };
  } finally {
    canvas.width = canvas.height = 1;
  }
}
function cleanLabelV1(value: string) {
  return Array.from(value.normalize('NFC'), (character) => {
    const point = character.codePointAt(0)!;
    return point <= 31 || point === 127 ? ' ' : character;
  })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}
/** Wrap by measured glyphs, including words longer than the card; never truncate a name. */
export function wrapQrLabelV1(value: string, width: number, measure: (s: string) => number) {
  const lines: string[] = [];
  let line = '';
  const graphemes = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }).segment(
    cleanLabelV1(value),
  );
  for (const { segment } of graphemes) {
    if (measure(segment) > width) throw new QrArtifactErrorV1('text-does-not-fit');
    if (line && measure(line + segment) > width) {
      const space = line.lastIndexOf(' ');
      if (space > 0) {
        lines.push(line.slice(0, space));
        line = line.slice(space + 1) + segment;
      } else {
        lines.push(line.trimEnd());
        line = segment.trimStart();
      }
    } else line += segment;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}
function labelPartsV1(card: PrintCardV1, instruction = '') {
  const parts =
    card.mode === 'qr-only'
      ? []
      : [
          { text: cleanLabelV1(card.name), size: 9, leading: 11 },
          ...(card.mode === 'qr-name-class'
            ? [{ text: cleanLabelV1(card.classLabel), size: 8.5, leading: 10.5 }]
            : []),
        ];
  if (instruction.trim())
    parts.push({ text: cleanLabelV1(instruction).slice(0, 240), size: 8, leading: 10 });
  return parts;
}
type LabelPlanV1 = {
  supported: boolean;
  height: number;
  parts: { size: number; leading: number; lines: string[] }[];
};
function planLabelsV1(
  font: PDFFont,
  card: PrintCardV1,
  width: number,
  instruction = '',
): LabelPlanV1 {
  const parts = labelPartsV1(card, instruction);
  let supported = true;
  try {
    for (const part of parts) font.encodeText(part.text);
  } catch {
    supported = false;
  }
  const surface = supported ? null : canvasV1(1, 1);
  try {
    const planned = parts.map((part) => {
      if (surface) surface.context.font = `${part.size * 4}px Arial, sans-serif`;
      const lines = wrapQrLabelV1(part.text, width, (text) =>
        surface
          ? surface.context.measureText(text).width / 4
          : font.widthOfTextAtSize(text, part.size),
      );
      return { ...part, lines };
    });
    return {
      supported,
      parts: planned,
      height: planned.reduce((sum, part) => sum + part.lines.length * part.leading + 4, 0),
    };
  } finally {
    if (surface) surface.canvas.width = surface.canvas.height = 1;
  }
}
/** Where the labels go under a card's QR: left edge, top, width and the height they may use. */
type LabelBoxV1 = { x: number; top: number; width: number; maxHeight: number };

/** Labels the standard PDF font covers, drawn as text, each line centred. */
function drawTextLabelsV1(
  page: PDFPage,
  font: PDFFont,
  parts: LabelPlanV1['parts'],
  { x, top, width, maxHeight }: LabelBoxV1,
) {
  let used = 0;
  for (const part of parts) {
    for (const line of part.lines) {
      used += part.leading;
      if (used > maxHeight) throw new QrArtifactErrorV1('text-does-not-fit');
      page.drawText(line, {
        font,
        size: part.size,
        x: x + (width - font.widthOfTextAtSize(line, part.size)) / 2,
        y: top - used,
        color: rgb(0, 0, 0),
      });
    }
    used += 4;
  }
}

/** SVG coordinates increase downwards; pdf-lib's path operator applies the matching Y flip. */
function drawQrPathsV1(
  page: PDFPage,
  shapes: readonly { path: string; dark: boolean }[],
  x: number,
  y: number,
  unit: number,
) {
  for (const shape of shapes)
    page.drawSvgPath(shape.path, {
      x,
      y,
      scale: unit,
      color: shape.dark ? rgb(0, 0, 0) : rgb(1, 1, 1),
      borderWidth: 0,
    });
}

async function drawLabelsV1(
  pdf: PDFDocument,
  page: PDFPage,
  font: PDFFont,
  plan: LabelPlanV1,
  { x, top, width, maxHeight }: LabelBoxV1,
  signal: AbortSignal,
) {
  const { parts, supported } = plan;
  if (!parts.length) return;
  if (supported) {
    drawTextLabelsV1(page, font, parts, { x, top, width, maxHeight });
    return;
  }
  // Standard PDF fonts cover Portuguese. Other scripts use the browser's local fonts,
  // rasterized at 288dpi; no font/CDN request, character replacement or lost name.
  const scale = 4,
    { canvas, context } = canvasV1(Math.ceil(width * scale), Math.ceil(maxHeight * scale));
  try {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000';
    context.textAlign = 'center';
    context.textBaseline = 'alphabetic';
    let used = 0;
    for (const part of parts) {
      context.font = `${part.size * scale}px Arial, sans-serif`;
      for (const line of part.lines) {
        used += part.leading;
        if (used > maxHeight) throw new QrArtifactErrorV1('text-does-not-fit');
        context.fillText(line, canvas.width / 2, used * scale);
      }
      used += 4;
    }
    const png = await canvasBlobV1(canvas, signal);
    const image = await pdf.embedPng(await png.arrayBuffer());
    signal.throwIfAborted();
    page.drawImage(image, { x, y: top - maxHeight, width, height: maxHeight });
  } finally {
    canvas.width = canvas.height = 1;
  }
}
/** Dense A4 rows, three columns, four-module QR quiet zones and shared cut guides.
 * Row height expands for complete names rather than shrinking the QR or dropping text.
 */
export async function renderQrPdfV1(
  input: unknown,
  signal: AbortSignal,
  progress: (completed: number, total: number) => void = () => {},
  instruction = '',
): Promise<QrArtifactV1> {
  signal.throwIfAborted();
  const cards = validatePrintCardCollectionV1(input),
    layout = QR_LAYOUT_V1;
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.setTitle('Cartões de acesso');
  pdf.setCreator('Centro de Administração');
  const width = (layout.pageWidth - 2 * layout.margin) / layout.columns;
  let page: PDFPage | undefined,
    top = layout.pageHeight - layout.margin,
    completed = 0;
  progress(0, cards.length);
  for (let start = 0; start < cards.length; start += layout.columns) {
    await yieldToBrowser();
    signal.throwIfAborted();
    const row = cards.slice(start, start + layout.columns),
      plans = row.map((card) => planLabelsV1(font, card, width - 16, instruction));
    const height = Math.max(
      128,
      6 + layout.qrSize + 4 + Math.max(...plans.map((plan) => plan.height)) + 8,
    );
    if (height > layout.pageHeight - 2 * layout.margin)
      throw new QrArtifactErrorV1('text-does-not-fit');
    const newPage = !page || top - height < layout.margin;
    if (newPage) {
      page = pdf.addPage([layout.pageWidth, layout.pageHeight]);
      top = layout.pageHeight - layout.margin;
    }
    const drawGuide = (x1: number, y1: number, x2: number, y2: number) =>
      page!.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness: 0.4,
        color: rgb(0.6, 0.6, 0.6),
        dashArray: [2, 2],
      });
    if (newPage) drawGuide(layout.margin, top, layout.margin + row.length * width, top);
    drawGuide(layout.margin, top - height, layout.margin + row.length * width, top - height);
    for (let col = 0; col <= row.length; col++)
      drawGuide(layout.margin + col * width, top, layout.margin + col * width, top - height);
    for (const [column, card] of row.entries()) {
      signal.throwIfAborted();
      const x = layout.margin + column * width;
      const matrix = qrMatrixV1(card.qr),
        unit = layout.qrSize / (matrix.size + 2 * layout.quietModules);
      const qrX = x + (width - layout.qrSize) / 2,
        qrTop = top - 6;
      page!.drawRectangle({
        x: qrX,
        y: qrTop - layout.qrSize,
        width: layout.qrSize,
        height: layout.qrSize,
        color: rgb(1, 1, 1),
      });
      drawQrPathsV1(page!, qrLayerPathsV1(matrix, layout.quietModules), qrX, qrTop, unit);
      await drawLabelsV1(
        pdf,
        page!,
        font,
        plans[column]!,
        {
          x: x + 8,
          top: qrTop - layout.qrSize - 4,
          width: width - 16,
          maxHeight: height - 6 - layout.qrSize - 4 - 8,
        },
        signal,
      );
      signal.throwIfAborted();
      progress(++completed, cards.length);
    }
    top -= height;
  }
  await yieldToBrowser();
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
