/** Internal statement limits; requests larger than these are processed in the same transaction. */
export const IMPORT_JSON_STATEMENT_LIMITS_V1 = {
  maximumRows: 512,
  maximumBytes: 256 * 1024,
} as const;
export const IMPORT_PENDING_LIMITS_V1 = { maximumRows: 2048, maximumBytes: 1024 * 1024 } as const;

export interface SerializedJsonRecordV1 {
  readonly jsonText: string;
  readonly jsonBytes: number;
}

interface JsonRecordChunkV1 {
  readonly jsonText: string;
  readonly rows: number;
  readonly bytes: number;
}

interface JsonRecordLimitsV1 {
  readonly maximumRows: number;
  readonly maximumBytes: number;
}

export function serializeJsonRecordV1(record: object): SerializedJsonRecordV1 {
  const jsonText = JSON.stringify(record);
  if (typeof jsonText !== 'string') throw new Error('gradebook-import-json-record-invalid');
  return { jsonText, jsonBytes: new TextEncoder().encode(jsonText).byteLength };
}

/** Each record is serialized once. Byte accounting includes array brackets and commas. */
export function* jsonRecordChunksV1(
  records: Iterable<SerializedJsonRecordV1>,
  limits: JsonRecordLimitsV1 = IMPORT_JSON_STATEMENT_LIMITS_V1,
): Generator<JsonRecordChunkV1> {
  if (
    !Number.isSafeInteger(limits.maximumRows) ||
    limits.maximumRows < 1 ||
    !Number.isSafeInteger(limits.maximumBytes) ||
    limits.maximumBytes < 2
  ) {
    throw new Error('gradebook-import-json-limits-invalid');
  }
  let texts: string[] = [];
  let bytes = 2;
  for (const record of records) {
    if (record.jsonBytes + 2 > limits.maximumBytes)
      throw new Error('gradebook-import-json-record-exceeds-statement-limit');
    const extra = record.jsonBytes + (texts.length > 0 ? 1 : 0);
    if (
      texts.length > 0 &&
      (texts.length === limits.maximumRows || bytes + extra > limits.maximumBytes)
    ) {
      yield { jsonText: '[' + texts.join(',') + ']', rows: texts.length, bytes };
      texts = [];
      bytes = 2;
    }
    bytes += record.jsonBytes + (texts.length > 0 ? 1 : 0);
    texts.push(record.jsonText);
  }
  if (texts.length > 0) yield { jsonText: '[' + texts.join(',') + ']', rows: texts.length, bytes };
}
