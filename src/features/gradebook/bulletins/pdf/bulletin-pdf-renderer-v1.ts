/// <reference lib="dom" />

import {
  isBulletinArtifactPayloadSafeV1,
  isBulletinSnapshotCoherentV1,
  type BulletinAnnualResultV1,
  type BulletinComparedApplicabilityV1,
  type BulletinComparedGradeValueV1,
  type BulletinPdfInputV1,
  type BulletinSnapshotV1,
} from '../../../../../shared/gradebook-contracts/bulletins/bulletin-contract-v1';
import {
  bulletinAcademicStateLabelV1,
  bulletinApplicabilityLabelV1,
  bulletinCoverageLabelV1,
  bulletinEmissionDateLabelV1,
  bulletinFinalDecisionLabelV1,
  bulletinGradeValueLabelV1,
  bulletinModelLabelV1,
  bulletinPeriodLabelV1,
} from '../bulletin-presentation-v1';

export const BULLETIN_PDF_LIMITS_V1 = Object.freeze({
  maxSubjects: 32,
  maxTerms: 96,
  maxAssessments: 320,
  maxTextCharacters: 160_000,
  maxPages: 24,
  maxOutputBytes: 12 * 1024 * 1024,
  concurrentDocuments: 1,
  canvasWidthPixels: 1191,
  canvasHeightPixels: 1684,
});

const PDF_PAGE_WIDTH_POINTS = 595.28;
const PDF_PAGE_HEIGHT_POINTS = 841.89;
const PDF_FONT_FAMILY = 'Geist Variable';
const PDF_LEFT = 84;
const PDF_RIGHT = 84;
const PDF_TOP = 74;
const PDF_BOTTOM = 70;
const PDF_CONTENT_WIDTH = BULLETIN_PDF_LIMITS_V1.canvasWidthPixels - PDF_LEFT - PDF_RIGHT;

export type BulletinPdfInputReadinessV1 =
  | { readonly status: 'ready' }
  | { readonly status: 'invalid-input' | 'bounds-exceeded'; readonly reason: string };

export type BulletinPdfLineV1 =
  | {
      readonly kind: 'text';
      readonly role: 'title' | 'section' | 'subsection' | 'body' | 'meta';
      readonly text: string;
      readonly indent?: number;
    }
  | { readonly kind: 'space'; readonly height: number }
  | { readonly kind: 'rule' };

export interface BulletinPdfRasterPageV1 {
  readonly jpeg: Uint8Array;
  readonly widthPixels: number;
  readonly heightPixels: number;
}

export interface BulletinPdfArtifactV1 {
  readonly blob: Blob;
  readonly byteLength: number;
  readonly pageCount: number;
}

export class BulletinPdfRendererErrorV1 extends Error {
  constructor(
    readonly code: 'invalid-input' | 'bounds-exceeded' | 'renderer-unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'BulletinPdfRendererErrorV1';
  }
}

function withoutControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  }).join('');
}

function visibleText(value: string): string {
  return withoutControlCharacters(value.normalize('NFC')).replace(/\s+/gu, ' ').trim();
}

function contentCounts(snapshot: BulletinSnapshotV1) {
  const model = snapshot.model;
  let termCount = 0;
  let assessmentCount = 0;
  if (model.modelKind === 'composition') {
    for (const subject of model.subjects) termCount += subject.terms.length;
  }
  if (model.modelKind === 'detailed') {
    for (const subject of model.subjects) {
      termCount += subject.terms.length;
      for (const term of subject.terms) assessmentCount += term.assessments.length;
    }
  }
  return {
    subjects: model.subjects.length,
    terms: termCount,
    assessments: assessmentCount,
    textCharacters: JSON.stringify(model).length,
  };
}

export function inspectBulletinPdfInputV1(input: BulletinPdfInputV1): BulletinPdfInputReadinessV1 {
  if (
    input === null ||
    typeof input !== 'object' ||
    !isBulletinArtifactPayloadSafeV1(input) ||
    !isBulletinSnapshotCoherentV1(input.snapshot)
  ) {
    return { status: 'invalid-input', reason: 'canonical-snapshot-required' };
  }

  const counts = contentCounts(input.snapshot);
  if (counts.subjects > BULLETIN_PDF_LIMITS_V1.maxSubjects) {
    return { status: 'bounds-exceeded', reason: 'subject-limit' };
  }
  if (counts.terms > BULLETIN_PDF_LIMITS_V1.maxTerms) {
    return { status: 'bounds-exceeded', reason: 'term-limit' };
  }
  if (counts.assessments > BULLETIN_PDF_LIMITS_V1.maxAssessments) {
    return { status: 'bounds-exceeded', reason: 'assessment-limit' };
  }
  if (counts.textCharacters > BULLETIN_PDF_LIMITS_V1.maxTextCharacters) {
    return { status: 'bounds-exceeded', reason: 'text-limit' };
  }
  return { status: 'ready' };
}

function assertReadyInput(input: BulletinPdfInputV1): void {
  const readiness = inspectBulletinPdfInputV1(input);
  if (readiness.status === 'ready') return;
  throw new BulletinPdfRendererErrorV1(readiness.status, readiness.reason);
}

function appendText(
  lines: BulletinPdfLineV1[],
  role: Extract<BulletinPdfLineV1, { readonly kind: 'text' }>['role'],
  text: string,
  indent = 0,
): void {
  lines.push({ kind: 'text', role, text: visibleText(text), ...(indent === 0 ? {} : { indent }) });
}

function appendComparedGrade(
  lines: BulletinPdfLineV1[],
  label: string,
  value: BulletinComparedGradeValueV1,
): void {
  appendText(
    lines,
    'body',
    `${label} — Importado: ${bulletinGradeValueLabelV1(value.imported)} · Calculado: ${bulletinGradeValueLabelV1(value.calculated)}`,
    20,
  );
}

function appendComparedApplicability(
  lines: BulletinPdfLineV1[],
  label: string,
  value: BulletinComparedApplicabilityV1,
): void {
  appendText(
    lines,
    'body',
    `${label} — Importado: ${bulletinApplicabilityLabelV1(value.imported)} · Calculado: ${bulletinApplicabilityLabelV1(value.calculated)}`,
    20,
  );
}

function appendAnnualResult(
  lines: BulletinPdfLineV1[],
  annualResult: BulletinAnnualResultV1 | null,
): void {
  if (annualResult === null) return;
  appendText(lines, 'subsection', 'Resultado anual');
  appendComparedGrade(lines, 'Total original', annualResult.originalTotal);
  appendComparedGrade(lines, 'Total pós-recuperação', annualResult.postRecoveryTotal);
  appendText(
    lines,
    'body',
    `Estado acadêmico — ${bulletinAcademicStateLabelV1(annualResult.academicState)}`,
    20,
  );
  appendText(
    lines,
    'body',
    `Decisão final — ${bulletinFinalDecisionLabelV1(annualResult.finalDecision)}`,
    20,
  );
  appendText(lines, 'meta', bulletinCoverageLabelV1(annualResult.coverage), 20);
}

/** Presentation-only projection over the canonical snapshot. No academic value is derived here. */
export function buildBulletinPdfLinesV1(input: BulletinPdfInputV1): readonly BulletinPdfLineV1[] {
  assertReadyInput(input);
  const { snapshot } = input;
  const { model } = snapshot;
  const lines: BulletinPdfLineV1[] = [];

  appendText(lines, 'title', `Boletim escolar — ${bulletinModelLabelV1(model.modelKind)}`);
  appendText(lines, 'meta', `Aluno: ${model.student.displayName}`);
  appendText(lines, 'meta', `Turma: ${model.classGroup.code}`);
  appendText(lines, 'meta', `Período: ${bulletinPeriodLabelV1(model.period)}`);
  appendText(lines, 'meta', `Autoridade acadêmica: ${model.authorityMode}`);
  appendText(
    lines,
    'meta',
    `Snapshot: ${snapshot.snapshotId} · versão ${snapshot.snapshotVersion} · modelVersion ${snapshot.modelVersion}`,
  );
  appendText(
    lines,
    'meta',
    `Emitido em: ${bulletinEmissionDateLabelV1(snapshot.emittedAt, snapshot.presentation.locale, snapshot.presentation.dateStyle)}`,
  );
  lines.push({ kind: 'space', height: 16 }, { kind: 'rule' }, { kind: 'space', height: 16 });

  if (model.modelKind === 'synthetic') {
    for (const { subject, result } of model.subjects) {
      appendText(lines, 'section', subject.displayName);
      if (result.kind === 'term') {
        appendText(lines, 'subsection', bulletinPeriodLabelV1({ kind: 'term', term: result.term }));
        appendComparedGrade(lines, 'Nota oficial', result.officialGrade);
        appendComparedGrade(lines, 'Percentual', result.percentage);
      } else {
        appendText(lines, 'subsection', 'Resultado anual');
        appendComparedGrade(lines, 'Total original', result.originalTotal);
        appendComparedGrade(lines, 'Total pós-recuperação', result.postRecoveryTotal);
        appendText(
          lines,
          'body',
          `Estado acadêmico — ${bulletinAcademicStateLabelV1(result.academicState)}`,
          20,
        );
        appendText(
          lines,
          'body',
          `Decisão final — ${bulletinFinalDecisionLabelV1(result.finalDecision)}`,
          20,
        );
      }
      appendText(lines, 'meta', bulletinCoverageLabelV1(result.coverage), 20);
      lines.push({ kind: 'space', height: 12 }, { kind: 'rule' }, { kind: 'space', height: 12 });
    }
    return lines;
  }

  for (const subject of model.subjects) {
    appendText(lines, 'section', subject.subject.displayName);
    for (const term of subject.terms) {
      appendText(lines, 'subsection', bulletinPeriodLabelV1({ kind: 'term', term: term.term }));
      appendComparedGrade(lines, 'Quantitativo original', term.quantitative.original);
      appendComparedGrade(lines, 'Recuperação paralela', term.quantitative.parallelRecovery);
      appendComparedApplicability(
        lines,
        'Aplicabilidade da recuperação paralela',
        term.quantitative.parallelRecoveryApplicability,
      );
      appendComparedGrade(lines, 'Quantitativo considerado', term.quantitative.considered);
      appendComparedGrade(lines, 'Qualitativo operacional', term.qualitativeOperational);
      appendComparedGrade(lines, 'Nota oficial', term.officialGrade);
      appendComparedGrade(lines, 'Percentual', term.percentage);
      appendText(lines, 'meta', bulletinCoverageLabelV1(term.coverage), 20);

      if ('assessments' in term) {
        appendText(lines, 'subsection', 'Avaliações', 20);
        if (term.assessments.length === 0) {
          appendText(lines, 'meta', 'Nenhuma avaliação no modelo canônico.', 36);
        }
        for (const assessment of term.assessments) {
          appendText(lines, 'body', assessment.name, 36);
          appendText(
            lines,
            'meta',
            `Tipo: ${assessment.type} · Aplicabilidade: ${bulletinApplicabilityLabelV1(assessment.applicability)}`,
            52,
          );
          appendComparedGrade(lines, 'Valor', assessment.value);
        }
      }
      lines.push({ kind: 'space', height: 12 });
    }
    appendAnnualResult(lines, subject.annualResult);
    lines.push({ kind: 'space', height: 12 }, { kind: 'rule' }, { kind: 'space', height: 12 });
  }

  return lines;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** Minimal PDF envelope: every page is a canvas-generated JPEG and /Info metadata is omitted. */
export function assembleBulletinRasterPdfV1(pages: readonly BulletinPdfRasterPageV1[]): Uint8Array {
  if (pages.length === 0 || pages.length > BULLETIN_PDF_LIMITS_V1.maxPages) {
    throw new BulletinPdfRendererErrorV1('bounds-exceeded', 'page-limit');
  }

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let byteOffset = 0;
  const objectCount = 2 + pages.length * 3;
  const appendBytes = (bytes: Uint8Array) => {
    chunks.push(bytes);
    byteOffset += bytes.length;
  };
  const appendAscii = (value: string) => appendBytes(encoder.encode(value));
  const beginObject = (id: number) => {
    offsets[id] = byteOffset;
    appendAscii(`${id} 0 obj\n`);
  };
  const endObject = () => appendAscii('endobj\n');

  appendBytes(
    new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
    ]),
  );

  beginObject(1);
  appendAscii('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObject();

  beginObject(2);
  const pageObjectIds = pages.map((_, index) => 3 + index * 3);
  appendAscii(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectIds.map((id) => id + ' 0 R').join(' ')}] >>\n`,
  );
  endObject();

  pages.forEach((page, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const imageName = `Im${index + 1}`;

    beginObject(pageId);
    appendAscii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH_POINTS} ${PDF_PAGE_HEIGHT_POINTS}] /Resources << /XObject << /${imageName} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\n`,
    );
    endObject();

    beginObject(imageId);
    appendAscii(
      `<< /Type /XObject /Subtype /Image /Width ${page.widthPixels} /Height ${page.heightPixels} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
    );
    appendBytes(page.jpeg);
    appendAscii('\nendstream\n');
    endObject();

    const content = `q\n${PDF_PAGE_WIDTH_POINTS} 0 0 ${PDF_PAGE_HEIGHT_POINTS} 0 0 cm\n/${imageName} Do\nQ\n`;
    const contentBytes = encoder.encode(content);
    beginObject(contentId);
    appendAscii(`<< /Length ${contentBytes.length} >>\nstream\n`);
    appendBytes(contentBytes);
    appendAscii('endstream\n');
    endObject();
  });

  const xrefOffset = byteOffset;
  appendAscii(`xref\n0 ${objectCount + 1}\n`);
  appendAscii('0000000000 65535 f \n');
  for (let id = 1; id <= objectCount; id += 1) {
    appendAscii(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  appendAscii(
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  const output = concatBytes(chunks);
  if (output.length > BULLETIN_PDF_LIMITS_V1.maxOutputBytes) {
    throw new BulletinPdfRendererErrorV1('bounds-exceeded', 'output-byte-limit');
  }
  return output;
}

function styleFor(role: Extract<BulletinPdfLineV1, { readonly kind: 'text' }>['role']) {
  switch (role) {
    case 'title':
      return { size: 38, weight: 700, lineHeight: 48, after: 12 };
    case 'section':
      return { size: 28, weight: 650, lineHeight: 36, after: 8 };
    case 'subsection':
      return { size: 22, weight: 650, lineHeight: 30, after: 5 };
    case 'body':
      return { size: 19, weight: 450, lineHeight: 27, after: 3 };
    case 'meta':
      return { size: 16, weight: 450, lineHeight: 23, after: 2 };
  }
}

function setCanvasFont(
  context: CanvasRenderingContext2D,
  style: ReturnType<typeof styleFor>,
): void {
  context.font = `${style.weight} ${style.size}px "${PDF_FONT_FAMILY}"`;
  context.fillStyle = '#111111';
  context.textBaseline = 'top';
}

function splitLongToken(
  context: CanvasRenderingContext2D,
  token: string,
  maximumWidth: number,
): readonly string[] {
  const pieces: string[] = [];
  let current = '';
  for (const character of Array.from(token)) {
    const candidate = `${current}${character}`;
    if (current.length > 0 && context.measureText(candidate).width > maximumWidth) {
      pieces.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces.length === 0 ? [''] : pieces;
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maximumWidth: number,
): readonly string[] {
  if (text.length === 0) return [''];
  const output: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const tokens =
      context.measureText(word).width <= maximumWidth
        ? [word]
        : splitLongToken(context, word, maximumWidth);
    for (const token of tokens) {
      const candidate = current.length === 0 ? token : `${current} ${token}`;
      if (current.length > 0 && context.measureText(candidate).width > maximumWidth) {
        output.push(current);
        current = token;
      } else {
        current = candidate;
      }
    }
  }
  if (current.length > 0) output.push(current);
  return output.length === 0 ? [''] : output;
}

/** Synchronous JPEG encoding. In the admin app Chromium delivers PNG/JPEG `toBlob` results about
 * 1 s late even when idle (measured 26/09/2026; WebP is unaffected), i.e. one extra second per
 * bulletin page. `toDataURL` encodes the same bytes in milliseconds.
 */
function canvasToJpegBytes(canvas: HTMLCanvasElement): Uint8Array {
  if (typeof canvas.toDataURL !== 'function') {
    throw new BulletinPdfRendererErrorV1('renderer-unavailable', 'canvas-to-blob-unavailable');
  }
  const prefix = 'data:image/jpeg;base64,';
  const url = canvas.toDataURL('image/jpeg', 0.9);
  // A browser that cannot encode JPEG silently returns PNG; never embed it as a JPEG page.
  if (!url.startsWith(prefix)) {
    throw new BulletinPdfRendererErrorV1('renderer-unavailable', 'canvas-encode-failed');
  }
  const binary = atob(url.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.codePointAt(index)!;
  return bytes;
}

async function requireBundledGeistFont(lines: readonly BulletinPdfLineV1[]): Promise<void> {
  if (typeof document === 'undefined' || document.fonts === undefined) {
    throw new BulletinPdfRendererErrorV1('renderer-unavailable', 'font-api-unavailable');
  }
  const characters = new Set<string>();
  for (const line of lines) {
    if (line.kind !== 'text') continue;
    for (const character of Array.from(line.text)) {
      characters.add(character);
      if (characters.size >= 512) break;
    }
    if (characters.size >= 512) break;
  }
  const probe = Array.from(characters).join('') || 'Boletim ÁÉÍÓÚ ÃÕ Ç 1º';
  const regular = `450 16px "${PDF_FONT_FAMILY}"`;
  const bold = `700 16px "${PDF_FONT_FAMILY}"`;
  try {
    await Promise.all([document.fonts.load(regular, probe), document.fonts.load(bold, probe)]);
  } catch {
    throw new BulletinPdfRendererErrorV1('renderer-unavailable', 'bundled-font-load-failed');
  }
  if (!document.fonts.check(regular, probe) || !document.fonts.check(bold, probe)) {
    throw new BulletinPdfRendererErrorV1('renderer-unavailable', 'bundled-font-unavailable');
  }
}

function createCanvasPage(): {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
} {
  if (typeof document === 'undefined') {
    throw new BulletinPdfRendererErrorV1('renderer-unavailable', 'browser-document-unavailable');
  }
  const canvas = document.createElement('canvas');
  canvas.width = BULLETIN_PDF_LIMITS_V1.canvasWidthPixels;
  canvas.height = BULLETIN_PDF_LIMITS_V1.canvasHeightPixels;
  const context = canvas.getContext('2d', { alpha: false });
  if (context === null) {
    throw new BulletinPdfRendererErrorV1('renderer-unavailable', 'canvas-context-unavailable');
  }
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, context };
}

async function renderLinesToRasterPages(
  lines: readonly BulletinPdfLineV1[],
  snapshotVersion: number,
): Promise<readonly BulletinPdfRasterPageV1[]> {
  await requireBundledGeistFont(lines);
  const pages: BulletinPdfRasterPageV1[] = [];
  let encodedBytes = 0;
  let current = createCanvasPage();
  let y = PDF_TOP;

  const drawContinuationHeader = () => {
    const style = styleFor('meta');
    setCanvasFont(current.context, style);
    current.context.fillText(
      `Boletim · continuação · snapshot v${snapshotVersion}`,
      PDF_LEFT,
      y,
      PDF_CONTENT_WIDTH,
    );
    y += style.lineHeight + 12;
    current.context.strokeStyle = '#111111';
    current.context.lineWidth = 1;
    current.context.beginPath();
    current.context.moveTo(PDF_LEFT, y);
    current.context.lineTo(BULLETIN_PDF_LIMITS_V1.canvasWidthPixels - PDF_RIGHT, y);
    current.context.stroke();
    y += 16;
  };

  const flush = async (): Promise<void> => {
    const jpeg = canvasToJpegBytes(current.canvas);
    encodedBytes += jpeg.length;
    if (encodedBytes > BULLETIN_PDF_LIMITS_V1.maxOutputBytes) {
      current.canvas.width = 1;
      current.canvas.height = 1;
      throw new BulletinPdfRendererErrorV1('bounds-exceeded', 'output-byte-limit');
    }
    pages.push({
      jpeg,
      widthPixels: BULLETIN_PDF_LIMITS_V1.canvasWidthPixels,
      heightPixels: BULLETIN_PDF_LIMITS_V1.canvasHeightPixels,
    });
    current.canvas.width = 1;
    current.canvas.height = 1;
  };

  const nextPage = async (): Promise<void> => {
    await flush();
    if (pages.length >= BULLETIN_PDF_LIMITS_V1.maxPages) {
      throw new BulletinPdfRendererErrorV1('bounds-exceeded', 'page-limit');
    }
    current = createCanvasPage();
    y = PDF_TOP;
    drawContinuationHeader();
  };

  const ensureHeight = async (height: number): Promise<void> => {
    if (y + height <= BULLETIN_PDF_LIMITS_V1.canvasHeightPixels - PDF_BOTTOM) return;
    await nextPage();
  };

  for (const line of lines) {
    if (line.kind === 'space') {
      await ensureHeight(line.height);
      y += line.height;
      continue;
    }
    if (line.kind === 'rule') {
      await ensureHeight(12);
      current.context.strokeStyle = '#111111';
      current.context.lineWidth = 1;
      current.context.beginPath();
      current.context.moveTo(PDF_LEFT, y + 4);
      current.context.lineTo(BULLETIN_PDF_LIMITS_V1.canvasWidthPixels - PDF_RIGHT, y + 4);
      current.context.stroke();
      y += 12;
      continue;
    }

    const style = styleFor(line.role);
    setCanvasFont(current.context, style);
    const indent = line.indent ?? 0;
    const maximumWidth = Math.max(100, PDF_CONTENT_WIDTH - indent);
    const fragments = wrapCanvasText(current.context, line.text, maximumWidth);
    for (const fragment of fragments) {
      await ensureHeight(style.lineHeight);
      setCanvasFont(current.context, style);
      current.context.fillText(fragment, PDF_LEFT + indent, y, maximumWidth);
      y += style.lineHeight;
    }
    y += style.after;
  }

  await flush();
  return pages;
}

/** Shared browser-only layout primitive for canonical bulletin snapshot versions. */
export async function renderBulletinPdfLinesV1(
  lines: readonly BulletinPdfLineV1[],
  snapshotVersion: number,
): Promise<BulletinPdfArtifactV1> {
  if (
    !Number.isSafeInteger(snapshotVersion) ||
    snapshotVersion <= 0 ||
    lines.length === 0 ||
    lines.reduce((total, line) => total + (line.kind === 'text' ? line.text.length : 0), 0) >
      BULLETIN_PDF_LIMITS_V1.maxTextCharacters
  ) {
    throw new BulletinPdfRendererErrorV1('bounds-exceeded', 'line-input-limit');
  }
  const pages = await renderLinesToRasterPages(lines, snapshotVersion);
  const bytes = assembleBulletinRasterPdfV1(pages);
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return {
    blob: new Blob([arrayBuffer], { type: 'application/pdf' }),
    byteLength: bytes.length,
    pageCount: pages.length,
  };
}

/**
 * Browser-only official renderer. Input is exactly BulletinPdfInputV1 ({ snapshot }); no fetch,
 * academic read, recalculation, remote font, persistent browser storage or metadata side channel.
 */
export async function renderBulletinPdfV1(
  input: BulletinPdfInputV1,
): Promise<BulletinPdfArtifactV1> {
  assertReadyInput(input);
  const lines = buildBulletinPdfLinesV1(input);
  return renderBulletinPdfLinesV1(lines, input.snapshot.snapshotVersion);
}
