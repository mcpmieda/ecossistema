/**
 * BIFF12 (.xlsb) record stream: a record is a type (1–2 bytes, 7 bits each), a size (1–4 bytes,
 * 7 bits each) and the data. Excel writes both with the shortest encoding, so decoding and
 * encoding an unchanged record gives back the same bytes.
 */
export type Biff12RecordV1 = { readonly type: number; readonly data: Uint8Array };

export function readBiff12RecordsV1(bytes: Uint8Array): Biff12RecordV1[] {
  const records: Biff12RecordV1[] = [];
  let at = 0;
  while (at < bytes.length) {
    let type = bytes[at++]!;
    if (type & 0x80) {
      if (at >= bytes.length) throw new Error('BIFF12 record type is truncated');
      type = (type & 0x7f) | (bytes[at++]! << 7);
    }
    let size = 0;
    for (let shift = 0; shift < 28; shift += 7) {
      if (at >= bytes.length) throw new Error('BIFF12 record size is truncated');
      const byte = bytes[at++]!;
      size |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
    }
    if (at + size > bytes.length) throw new Error('BIFF12 record data is truncated');
    records.push({ type, data: bytes.subarray(at, at + size) });
    at += size;
  }
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
