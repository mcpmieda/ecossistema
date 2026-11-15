import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SOURCE_CONTRACT_V2 } from '../../../shared/gradebook-contracts/source/source-contract-v2';
import { importWorkbookBatch } from '../../../src/features/gradebook/import/import-batch';
import type {
  SheetJs,
  Workbook,
} from '../../../src/features/gradebook/import/spreadsheet-recognizer';

const fixedNow = new Date('2026-08-31T18:00:00.000Z');
const modifiedAt = new Date('2026-08-30T12:30:00.000Z');
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function syntheticFile(name: string, bytes: readonly number[], events: string[] = []): File {
  return {
    name,
    type: mime,
    size: bytes.length,
    lastModified: modifiedAt.getTime(),
    arrayBuffer: async () => {
      events.push(`read-bytes:${name}`);
      return Uint8Array.from(bytes).buffer;
    },
  } as unknown as File;
}

function unreadableFile(name: string, events: string[]): File {
  return {
    name,
    type: mime,
    size: 3,
    lastModified: modifiedAt.getTime(),
    arrayBuffer: async () => {
      events.push(`read-failed:${name}`);
      throw new Error('Falha sintética de leitura.');
    },
  } as unknown as File;
}

function workbook(): Workbook {
  return {
    SheetNames: ['6A1º'],
    Sheets: {
      '6A1º': {
        '!ref': 'A1:K4',
        K2: { v: 'Componente sintético' },
        K3: { v: '6A' },
        K4: { v: '1º trimestre' },
      },
    },
  };
}

function sheetJs(events: string[] = []): SheetJs {
  return {
    version: 'synthetic-parser-1.0.0',
    read: (data) => {
      const marker = new Uint8Array(data)[0];
      events.push(`recognize:${marker}`);
      return marker === 9 ? { SheetNames: [], Sheets: {} } : workbook();
    },
    utils: {
      decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 3, c: 10 } }),
    },
  };
}

const now = () => fixedNow;

describe('manifesto e proveniência do lote de importação', () => {
  it('IMP-006: calcula SHA-256 com Web Crypto e preenche o contrato do manifesto', async () => {
    const file = syntheticFile('fonte-sintetica.xlsx', [97, 98, 99]);

    const result = await importWorkbookBatch([file], sheetJs(), () => undefined, { now });
    const manifest = result.successes[0]?.manifest;

    expect(manifest).toEqual({
      id: `source-file-manifest:${'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'}`,
      fileName: 'fonte-sintetica.xlsx',
      extension: 'xlsx',
      reportedMimeType: mime,
      sizeBytes: 3,
      lastModifiedAt: modifiedAt.toISOString(),
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      sourceContractVersion: SOURCE_CONTRACT_V2.version,
      parserVersion: 'synthetic-parser-1.0.0',
      readAt: fixedNow.toISOString(),
    });
    expect(result.batch.files[0]?.manifest).toEqual(manifest);
    expect(result.batch.status).toBe('approved');
    expect(manifest).not.toHaveProperty('path');
    expect(manifest).not.toHaveProperty('localPath');
  });

  it('mantém o hash como identidade do conteúdo e o nome como metadado separado', async () => {
    const files = [
      syntheticFile('primeiro-nome.xlsx', [1, 2, 3]),
      syntheticFile('nome-alterado.xlsx', [1, 2, 3]),
    ];

    const result = await importWorkbookBatch(files, sheetJs(), () => undefined, { now });
    const [first, renamed] = result.successes.map(({ manifest }) => manifest);

    expect(first?.sha256).toBe(renamed?.sha256);
    expect(first?.id).toBe(renamed?.id);
    expect(first?.fileName).toBe('primeiro-nome.xlsx');
    expect(renamed?.fileName).toBe('nome-alterado.xlsx');
  });

  it('fornece hashes diferentes apenas como evidência, sem inferir outra fonte lógica', async () => {
    const files = [
      syntheticFile('versao-a.xlsx', [1, 2, 3]),
      syntheticFile('versao-b.xlsx', [1, 2, 4]),
    ];

    const result = await importWorkbookBatch(files, sheetJs(), () => undefined, { now });
    const manifests = result.successes.map(({ manifest }) => manifest);

    expect(manifests[0]?.sha256).not.toBe(manifests[1]?.sha256);
    for (const manifest of manifests) {
      expect(manifest).not.toHaveProperty('logicalSourceId');
      expect(manifest).not.toHaveProperty('sourceVersion');
    }
  });

  it('IMP-009: diferencia preparação/hash e reconhecimento, nessa ordem', async () => {
    const events: string[] = [];
    const progress: string[] = [];
    const file = syntheticFile('etapas-sinteticas.xlsx', [4, 5, 6], events);

    await importWorkbookBatch([file], sheetJs(events), () => undefined, {
      now,
      digestSha256: async (data) => {
        events.push('hash');
        return globalThis.crypto.subtle.digest('SHA-256', data);
      },
      onStageProgress: ({ stage, current, total }) => {
        progress.push(`${stage}:${current}/${total}`);
      },
      yieldBeforeRecognition: async () => {
        events.push('yield-to-interface');
      },
    });

    expect(events).toEqual([
      'read-bytes:etapas-sinteticas.xlsx',
      'hash',
      'yield-to-interface',
      'recognize:4',
    ]);
    expect(progress).toEqual(['preparing:1/1', 'recognizing:1/1']);
  });

  it('IMP-003: isola falha de hash e continua reconhecendo os demais arquivos', async () => {
    const files = [
      syntheticFile('valido-a.xlsx', [1]),
      syntheticFile('hash-invalido.xlsx', [2]),
      syntheticFile('valido-b.xlsx', [3]),
    ];

    const result = await importWorkbookBatch(files, sheetJs(), () => undefined, {
      now,
      digestSha256: async (data) => {
        if (new Uint8Array(data)[0] === 2) throw new Error('Falha sintética de hash.');
        return globalThis.crypto.subtle.digest('SHA-256', data);
      },
    });

    expect(result.successes.map(({ manifest }) => manifest.fileName)).toEqual([
      'valido-a.xlsx',
      'valido-b.xlsx',
    ]);
    expect(result.failures).toEqual([
      { fileName: 'hash-invalido.xlsx', message: 'Falha sintética de hash.' },
    ]);
    expect(result.failureDetails[0]).toMatchObject({
      stage: 'preparation',
      manifest: null,
      diagnostic: {
        code: 'FILE-HASH-FAILED',
        severity: 'blocking-error',
        location: { kind: 'file' },
      },
    });
    expect(result.batch.status).toBe('review-required');
    expect(result.batch.summary).toMatchObject({
      totalFileCount: 3,
      processedFileCount: 3,
      approvedFileCount: 2,
      failedFileCount: 1,
      blockingErrorCount: 1,
    });
  });

  it('IMP-003: isola falha de leitura antes do hash e continua o lote', async () => {
    const events: string[] = [];
    const files = [
      unreadableFile('leitura-invalida.xlsx', events),
      syntheticFile('leitura-valida.xlsx', [7], events),
    ];

    const result = await importWorkbookBatch(files, sheetJs(events), () => undefined, { now });

    expect(result.failures).toEqual([
      { fileName: 'leitura-invalida.xlsx', message: 'Falha sintética de leitura.' },
    ]);
    expect(result.failureDetails[0]?.diagnostic.code).toBe('FILE-READ-FAILED');
    expect(result.successes[0]?.manifest.fileName).toBe('leitura-valida.xlsx');
    expect(events).toEqual([
      'read-failed:leitura-invalida.xlsx',
      'read-bytes:leitura-valida.xlsx',
      'recognize:7',
    ]);
  });

  it('preserva o manifesto quando a falha acontece apenas no reconhecimento', async () => {
    const file = syntheticFile('estrutura-invalida.xlsx', [9]);

    const result = await importWorkbookBatch([file], sheetJs(), () => undefined, { now });
    const failure = result.failureDetails[0];

    expect(failure).toMatchObject({
      fileName: 'estrutura-invalida.xlsx',
      stage: 'recognition',
      diagnostic: {
        code: 'WORKBOOK-RECOGNITION-FAILED',
        sourceFileManifestId: failure?.manifest?.id,
      },
    });
    expect(failure?.manifest?.sha256).toHaveLength(64);
    expect(result.batch.files[0]?.manifest).toEqual(failure?.manifest);
  });

  it('IMP-010: lê uma vez, não altera o arquivo e não envia nem persiste bytes', async () => {
    const events: string[] = [];
    const file = syntheticFile('somente-leitura.xlsx', [10, 20, 30], events);
    const descriptorBefore = {
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
    };

    await importWorkbookBatch([file], sheetJs(events), () => undefined, { now });

    expect(events.filter((event) => event.startsWith('read-bytes:'))).toHaveLength(1);
    expect({
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
    }).toEqual(descriptorBefore);

    const root = process.cwd();
    const source = ['file-manifest.ts', 'import-batch.ts', 'workbook-reader.ts']
      .map((path) => readFileSync(join(root, 'src/features/gradebook/import', path), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(
      /\bfetch\s*\(|localStorage|sessionStorage|indexedDB|CacheStorage|\.write\s*\(/u,
    );
  });

  it('SEC-006/UI: apresenta as etapas e uma linha por planilha, sem caminho local', () => {
    const root = process.cwd();
    const panel = readFileSync(
      join(root, 'src/features/gradebook/import/import-panel.tsx'),
      'utf8',
    );

    expect(panel).toContain("from '@heroui/react'");
    expect(panel).toContain('Preparando e calculando SHA-256');
    expect(panel).toContain('Reconhecendo estrutura');
    expect(panel).toContain('result.manifest.fileName');
    expect(panel).not.toMatch(/localPath|file\.path/u);
  });
});
