/**
 * BIFF12 (.xlsb) record stream: a record is a type (1–2 bytes, 7 bits each), a size (1–4 bytes,
 * 7 bits each) and the data. Excel writes both with the shortest encoding, so decoding and
 * encoding an unchanged record gives back the same bytes.
 */
export type Biff12RecordV1 = { readonly type: number; readonly data: Uint8Array };

/** The record header at `at`: its type, its data size and where the data starts. */
function readHeaderV1(
  bytes: Uint8Array,
  at: number,
): { type: number; size: number; start: number } {
  let next = at;
  const byteAt = (what: string) => {
    if (next >= bytes.length) throw new Error(`BIFF12 record ${what} is truncated`);
    return bytes[next++]!;
  };
  let type = byteAt('type');
  if (type & 0x80) type = (type & 0x7f) | (byteAt('type') << 7);
  let size = 0;
  for (let shift = 0; shift < 28; shift += 7) {
    const byte = byteAt('size');
    size |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
  }
  return { type, size, start: next };
}

/** Each record's type and data bounds, in order, without keeping them (large sheets). */
export function scanBiff12RecordsV1(
  bytes: Uint8Array,
  visit: (type: number, start: number, end: number) => void,
): void {
  let at = 0;
  while (at < bytes.length) {
    const { type, size, start } = readHeaderV1(bytes, at);
    if (start + size > bytes.length) throw new Error('BIFF12 record data is truncated');
    visit(type, start, start + size);
    at = start + size;
  }
}

export function readBiff12RecordsV1(bytes: Uint8Array): Biff12RecordV1[] {
  const records: Biff12RecordV1[] = [];
  scanBiff12RecordsV1(bytes, (type, start, end) => {
    records.push({ type, data: bytes.subarray(start, end) });
  });
  return records;
}

function headerV1(type: number, size: number): number[] {
  if (type < 0 || type >= 0x4000) throw new Error('BIFF12 record type out of range');
  const header = type < 0x80 ? [type] : [(type & 0x7f) | 0x80, type >> 7];
  let rest = size;
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    header.push(rest ? byte | 0x80 : byte);
  } while (rest);
  return header;
}

export function writeBiff12RecordsV1(records: readonly Biff12RecordV1[]): Uint8Array {
  const parts = records.map((record) => ({
    header: headerV1(record.type, record.data.length),
    data: record.data,
  }));
  const total = parts.reduce((sum, part) => sum + part.header.length + part.data.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part.header, at);
    at += part.header.length;
    out.set(part.data, at);
    at += part.data.length;
  }
  return out;
}
