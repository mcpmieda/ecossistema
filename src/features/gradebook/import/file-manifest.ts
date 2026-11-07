import type { SourceFileManifestV1 } from '../../../../shared/gradebook-contracts/imports/import-contract-v1';
import type { SourceFileManifestId } from '../../../../shared/gradebook-contracts/imports/import-ids-v1';
import { SOURCE_CONTRACT_V2 } from '../../../../shared/gradebook-contracts/source/source-contract-v2';
import type { SourceFileExtensionV1 } from '../../../../shared/gradebook-contracts/source/source-contract-v1';
import { fileExtension } from './spreadsheet-recognizer';

export interface FileManifestRuntime {
  readonly digestSha256?: (data: ArrayBuffer) => Promise<ArrayBuffer>;
  readonly now?: () => Date;
}

function asIsoTimestamp(value: number): string | null {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function toHexadecimal(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function digestWithWebCrypto(data: ArrayBuffer): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.digest('SHA-256', data);
}

async function calculateSha256(
  data: ArrayBuffer,
  digestSha256: (data: ArrayBuffer) => Promise<ArrayBuffer> = digestWithWebCrypto,
): Promise<string> {
  return toHexadecimal(await digestSha256(data));
}

export async function createSourceFileManifest(
  file: File,
  data: ArrayBuffer,
  parserVersion: string,
  runtime: FileManifestRuntime = {},
): Promise<SourceFileManifestV1> {
  const extension = fileExtension(file.name) as SourceFileExtensionV1;
  const sha256 = await calculateSha256(data, runtime.digestSha256);
  const readAt = (runtime.now?.() ?? new Date()).toISOString();

  return {
    id: `source-file-manifest:${sha256}` as SourceFileManifestId,
    fileName: file.name,
    extension,
    reportedMimeType: file.type || null,
    sizeBytes: file.size,
    lastModifiedAt: asIsoTimestamp(file.lastModified),
    sha256,
    sourceContractVersion: SOURCE_CONTRACT_V2.version,
    parserVersion,
    readAt,
  };
}

export function abbreviateSha256(sha256: string): string {
  return `${sha256.slice(0, 12)}…${sha256.slice(-8)}`;
}
