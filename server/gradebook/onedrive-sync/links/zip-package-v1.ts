/**
 * Minimal ZIP reader/rewriter for Office packages. Rewriting copies every unchanged entry byte for
 * byte (same compressed data, CRC and order) and only re-encodes the parts that were replaced, so
 * VBA, protection and everything else in the workbook stay exactly as Excel saved them.
 */
type ZipEntryV1 = {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly versionMadeBy: number;
  readonly versionNeeded: number;
  readonly flags: number;
  readonly method: number;
  readonly time: number;
  readonly date: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localExtra: Uint8Array;
  readonly centralExtra: Uint8Array;
  readonly comment: Uint8Array;
  readonly internalAttributes: number;
  readonly externalAttributes: number;
  readonly data: Uint8Array;
};

export type ZipPackageV1 = {
  readonly entries: readonly ZipEntryV1[];
  readonly comment: Uint8Array;
};

const EOCD_V1 = 0x06054b50;
const CENTRAL_V1 = 0x02014b50;
const LOCAL_V1 = 0x04034b50;

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(`Workbook package: ${message}`);
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function readZipPackageV1(bytes: Uint8Array): ZipPackageV1 {
  const dv = view(bytes);
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (dv.getUint32(at, true) === EOCD_V1) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError('end of central directory not found');
  const count = dv.getUint16(eocd + 10, true);
  const centralSize = dv.getUint32(eocd + 12, true);
  const centralOffset = dv.getUint32(eocd + 16, true);
  const commentLength = dv.getUint16(eocd + 20, true);
  if (count === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff)
    throw new ZipFormatError('ZIP64 is not supported');
  const entries: ZipEntryV1[] = [];
  let at = centralOffset;
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (dv.getUint32(at, true) !== CENTRAL_V1) throw new ZipFormatError('bad central entry');
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const entryCommentLength = dv.getUint16(at + 32, true);
    const localOffset = dv.getUint32(at + 42, true);
    const nameBytes = bytes.slice(at + 46, at + 46 + nameLength);
    const compressedSize = dv.getUint32(at + 20, true);
    if (dv.getUint32(localOffset, true) !== LOCAL_V1) throw new ZipFormatError('bad local entry');
    const localNameLength = dv.getUint16(localOffset + 26, true);
    const localExtraLength = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.length) throw new ZipFormatError('entry is truncated');
    entries.push({
      name: decoder.decode(nameBytes),
      nameBytes,
      versionMadeBy: dv.getUint16(at + 4, true),
      versionNeeded: dv.getUint16(at + 6, true),
      flags: dv.getUint16(at + 8, true),
      method: dv.getUint16(at + 10, true),
      time: dv.getUint16(at + 12, true),
      date: dv.getUint16(at + 14, true),
      crc32: dv.getUint32(at + 16, true),
      compressedSize,
      size: dv.getUint32(at + 24, true),
      localExtra: bytes.slice(
        localOffset + 30 + localNameLength,
        localOffset + 30 + localNameLength + localExtraLength,
      ),
      centralExtra: bytes.slice(at + 46 + nameLength, at + 46 + nameLength + extraLength),
      comment: bytes.slice(
        at + 46 + nameLength + extraLength,
        at + 46 + nameLength + extraLength + entryCommentLength,
      ),
      internalAttributes: dv.getUint16(at + 36, true),
      externalAttributes: dv.getUint32(at + 38, true),
      data: bytes.subarray(dataStart, dataStart + compressedSize),
    });
    at += 46 + nameLength + extraLength + entryCommentLength;
  }
  return { entries, comment: bytes.slice(eocd + 22, eocd + 22 + commentLength) };
}

async function streamBytesV1(
  input: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // Package bytes always live in a plain ArrayBuffer (never shared memory).
  const written = writer.write(input as Uint8Array<ArrayBuffer>).then(() => writer.close());
  const [out] = await Promise.all([new Response(transform.readable).arrayBuffer(), written]);
  return new Uint8Array(out);
}

export async function readZipEntryV1(pkg: ZipPackageV1, name: string): Promise<Uint8Array | null> {
  const entry = pkg.entries.find((candidate) => candidate.name === name);
  if (!entry) return null;
  if (entry.method === 0) return entry.data;
  if (entry.method !== 8) throw new ZipFormatError(`unsupported compression in ${name}`);
  const inflated = await streamBytesV1(entry.data, new DecompressionStream('deflate-raw'));
  if (inflated.length !== entry.size || crc32V1(inflated) !== entry.crc32)
    throw new ZipFormatError(`checksum mismatch in ${name}`);
  return inflated;
}

export function zipEntryNamesV1(pkg: ZipPackageV1): string[] {
  return pkg.entries.map((entry) => entry.name);
}

let crcTableV1: Uint32Array | null = null;

export function crc32V1(bytes: Uint8Array): number {
  if (!crcTableV1) {
    crcTableV1 = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTableV1[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTableV1[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A new package where the named parts get new content; every other entry is copied raw. */
export async function rewriteZipPackageV1(
  pkg: ZipPackageV1,
  replacements: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array> {
  for (const name of replacements.keys())
    if (!pkg.entries.some((entry) => entry.name === name))
      throw new ZipFormatError(`no part ${name} to replace`);
  const entries: ZipEntryV1[] = [];
  for (const entry of pkg.entries) {
    const content = replacements.get(entry.name);
    if (!content) {
      entries.push(entry);
      continue;
    }
    const deflated = await streamBytesV1(content, new CompressionStream('deflate-raw'));
    entries.push({
      ...entry,
      // Sizes go in the local header below, so the data-descriptor bit is cleared.
      flags: entry.flags & ~0x0008,
      method: 8,
      versionNeeded: Math.max(entry.versionNeeded, 20),
      crc32: crc32V1(content),
      compressedSize: deflated.length,
      size: content.length,
      data: deflated,
    });
  }
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const local = new Uint8Array(30 + entry.nameBytes.length + entry.localExtra.length);
    const ldv = view(local);
    ldv.setUint32(0, LOCAL_V1, true);
    ldv.setUint16(4, entry.versionNeeded, true);
    ldv.setUint16(6, entry.flags & ~0x0008, true);
    ldv.setUint16(8, entry.method, true);
    ldv.setUint16(10, entry.time, true);
    ldv.setUint16(12, entry.date, true);
    ldv.setUint32(14, entry.crc32, true);
    ldv.setUint32(18, entry.compressedSize, true);
    ldv.setUint32(22, entry.size, true);
    ldv.setUint16(26, entry.nameBytes.length, true);
    ldv.setUint16(28, entry.localExtra.length, true);
    local.set(entry.nameBytes, 30);
    local.set(entry.localExtra, 30 + entry.nameBytes.length);
    const central = new Uint8Array(
      46 + entry.nameBytes.length + entry.centralExtra.length + entry.comment.length,
    );
    const cdv = view(central);
    cdv.setUint32(0, CENTRAL_V1, true);
    cdv.setUint16(4, entry.versionMadeBy, true);
    cdv.setUint16(6, entry.versionNeeded, true);
    cdv.setUint16(8, entry.flags & ~0x0008, true);
    cdv.setUint16(10, entry.method, true);
    cdv.setUint16(12, entry.time, true);
    cdv.setUint16(14, entry.date, true);
    cdv.setUint32(16, entry.crc32, true);
    cdv.setUint32(20, entry.compressedSize, true);
    cdv.setUint32(24, entry.size, true);
    cdv.setUint16(28, entry.nameBytes.length, true);
    cdv.setUint16(30, entry.centralExtra.length, true);
    cdv.setUint16(32, entry.comment.length, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, entry.internalAttributes, true);
    cdv.setUint32(38, entry.externalAttributes, true);
    cdv.setUint32(42, offset, true);
    central.set(entry.nameBytes, 46);
    central.set(entry.centralExtra, 46 + entry.nameBytes.length);
    central.set(entry.comment, 46 + entry.nameBytes.length + entry.centralExtra.length);
    localParts.push(local, entry.data);
    centralParts.push(central);
    offset += local.length + entry.data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22 + pkg.comment.length);
  const edv = view(end);
  edv.setUint32(0, EOCD_V1, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, pkg.comment.length, true);
  end.set(pkg.comment, 22);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
