/// <reference lib="dom" />

import type { RelationalBulletinSnapshotV2 } from '../../../../../shared/gradebook-contracts/bulletins/relational-bulletin-v2';

export type RelationalBulletinPdfActionV2 = 'download' | 'print';
export type RelationalBulletinPdfFailureV2 =
  | 'invalid-input'
  | 'bounds-exceeded'
  | 'renderer-unavailable'
  | 'download-unavailable'
  | 'print-unavailable';

export interface RelationalBulletinPdfActionResultV2 {
  readonly filename: string;
  readonly pageCount: number;
  readonly byteLength: number;
}

interface RendererModuleV2 {
  readonly renderRelationalBulletinPdfV2: (snapshot: RelationalBulletinSnapshotV2) => Promise<{
    readonly blob: Blob;
    readonly pageCount: number;
    readonly byteLength: number;
  }>;
}

export type RelationalBulletinPdfRendererImporterV2 = () => Promise<RendererModuleV2>;

export class RelationalBulletinPdfActionErrorV2 extends Error {
  constructor(
    readonly code: RelationalBulletinPdfFailureV2,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RelationalBulletinPdfActionErrorV2';
  }
}

function sanitize(value: string, fallback: string): string {
  const normalized = Array.from(value.normalize('NFC'), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  })
    .join('')
    .replaceAll(/[\\/<>:"|?*]/gu, '-')
    .replaceAll(/\s+/gu, ' ')
    .replaceAll(/\.{2,}/gu, '.')
    .trim()
    .replaceAll(/^[. -]+|[. -]+$/gu, '');
  return (
    Array.from(normalized || fallback)
      .slice(0, 72)
      .join('')
      .trim() || fallback
  );
}

export function relationalBulletinPdfFilenameV2(snapshot: RelationalBulletinSnapshotV2): string {
  const model = snapshot.model;
  const period = model.period.kind === 'annual' ? 'anual-rec' : `${model.period.term}-trimestre`;
  return `boletim-${sanitize(model.student.name, 'aluno')}-${sanitize(model.classGroup.name, 'turma')}-${period}-v${snapshot.snapshotVersion}.pdf`;
}

const defaultImporter: RelationalBulletinPdfRendererImporterV2 = async () => {
  const module = await import('./bulletin-pdf-renderer-v2');
  return { renderRelationalBulletinPdfV2: module.renderRelationalBulletinPdfV2 };
};

async function generate(
  snapshot: RelationalBulletinSnapshotV2,
  importer: RelationalBulletinPdfRendererImporterV2 = defaultImporter,
) {
  let renderer: RendererModuleV2;
  try {
    renderer = await importer();
    if (typeof renderer.renderRelationalBulletinPdfV2 !== 'function') {
      throw new TypeError('invalid-renderer-module');
    }
  } catch (cause) {
    throw new RelationalBulletinPdfActionErrorV2(
      'renderer-unavailable',
      'O gerador de PDF não pôde ser carregado.',
      { cause },
    );
  }
  try {
    return await renderer.renderRelationalBulletinPdfV2(snapshot);
  } catch (cause) {
    const code =
      cause !== null &&
      typeof cause === 'object' &&
      'code' in cause &&
      (cause.code === 'invalid-input' ||
        cause.code === 'bounds-exceeded' ||
        cause.code === 'renderer-unavailable')
        ? cause.code
        : 'renderer-unavailable';
    throw new RelationalBulletinPdfActionErrorV2(code, 'O PDF não pôde ser gerado.', { cause });
  }
}

function requireBrowser(action: RelationalBulletinPdfActionV2): void {
  if (
    typeof document === 'undefined' ||
    typeof window === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof URL.revokeObjectURL !== 'function'
  ) {
    throw new RelationalBulletinPdfActionErrorV2(
      action === 'download' ? 'download-unavailable' : 'print-unavailable',
      'A ação de PDF não está disponível neste navegador.',
    );
  }
}

export async function runRelationalBulletinPdfActionV2(
  action: RelationalBulletinPdfActionV2,
  snapshot: RelationalBulletinSnapshotV2,
  importer?: RelationalBulletinPdfRendererImporterV2,
): Promise<RelationalBulletinPdfActionResultV2> {
  requireBrowser(action);
  const artifact = await generate(snapshot, importer);
  const filename = relationalBulletinPdfFilenameV2(snapshot);
  const objectUrl = URL.createObjectURL(artifact.blob);
  if (action === 'download') {
    const anchor = document.createElement('a');
    try {
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.rel = 'noopener';
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
    } catch (cause) {
      throw new RelationalBulletinPdfActionErrorV2(
        'download-unavailable',
        'O download do PDF não pôde ser iniciado.',
        { cause },
      );
    } finally {
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
    return { filename, pageCount: artifact.pageCount, byteLength: artifact.byteLength };
  }

  const frame = document.createElement('iframe');
  frame.title = `Impressão de ${filename}`;
  frame.hidden = true;
  frame.src = objectUrl;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new RelationalBulletinPdfActionErrorV2(
            'print-unavailable',
            'Tempo limite da impressão do PDF.',
          ),
        );
      }, 15_000);
      frame.addEventListener(
        'load',
        () => {
          if (settled) return;
          try {
            if (!frame.contentWindow) throw new Error('print-window-unavailable');
            frame.contentWindow.focus();
            frame.contentWindow.print();
            settled = true;
            window.clearTimeout(timeout);
            resolve();
          } catch (cause) {
            settled = true;
            window.clearTimeout(timeout);
            reject(
              new RelationalBulletinPdfActionErrorV2(
                'print-unavailable',
                'A impressão do PDF não pôde ser iniciada.',
                { cause },
              ),
            );
          }
        },
        { once: true },
      );
      frame.addEventListener(
        'error',
        () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          reject(
            new RelationalBulletinPdfActionErrorV2(
              'print-unavailable',
              'O PDF não pôde ser aberto para impressão.',
            ),
          );
        },
        { once: true },
      );
      document.body.appendChild(frame);
    });
  } finally {
    window.setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(objectUrl);
    }, 1000);
  }
  return { filename, pageCount: artifact.pageCount, byteLength: artifact.byteLength };
}
