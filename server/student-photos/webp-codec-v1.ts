import { probePhotoSourceV1 } from '../../shared/student-photos/source-probe-v1';
import { STUDENT_PHOTO_MAX_BYTES_V1, STUDENT_PHOTO_MAX_WIDTH_V1, STUDENT_PHOTO_MAX_HEIGHT_V1 } from '../../shared/student-photos/portrait-v1';

export type WebpPhotoVariantV1 = 'portrait' | 'avatar';
export type WebpPhotoQualityV1 = 92 | 86 | 80;
export type WebpCodecFailureV1 = 'input' | 'dimensions' | 'metadata' | 'decode' | 'alpha' | 'encode' | 'output-size' | 'unavailable';
export class WebpCodecErrorV1 extends Error {
  constructor(readonly code: WebpCodecFailureV1) { super('student-photo-codec-' + code); }
}
interface CodecExportsV1 {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  photo_input_ptr(): number;
  photo_output_ptr(): number;
  photo_output_size(): number;
  photo_width(): number;
  photo_height(): number;
  photo_decoder_version(): number;
  photo_encoder_version(): number;
  photo_normalize(length: number, variant: number, quality: number): number;
  photo_validate(length: number, variant: number): number;
  photo_clear(): void;
}
const memoryBytes = 32 * 1024 * 1024;
const codecVersion = 0x010600;
const functions = ['photo_input_ptr','photo_output_ptr','photo_output_size','photo_width','photo_height',
  'photo_decoder_version','photo_encoder_version','photo_normalize','photo_validate','photo_clear'] as const;
const statuses: readonly WebpCodecFailureV1[] = ['unavailable','input','dimensions','decode','alpha','encode','output-size','unavailable'];
function maxBytes(variant: WebpPhotoVariantV1): number {
  return variant === 'portrait' ? STUDENT_PHOTO_MAX_BYTES_V1 : 64 * 1024;
}
function preflight(bytes: Uint8Array, variant: WebpPhotoVariantV1, allowInputMetadata = false) {
  let probe;
  try { probe = probePhotoSourceV1(bytes); }
  catch { throw new WebpCodecErrorV1('input'); }
  if (probe.type !== 'image/webp') throw new WebpCodecErrorV1('input');
  const { width, height } = probe;
  if (variant === 'portrait'
    ? width > STUDENT_PHOTO_MAX_WIDTH_V1 || height > STUDENT_PHOTO_MAX_HEIGHT_V1 || width * 4 !== height * 3
    : width > 320 || height > 320 || width !== height) throw new WebpCodecErrorV1('dimensions');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset < bytes.length;) {
    const tag = String.fromCodePoint(...bytes.subarray(offset, offset + 4));
    if (!['VP8 ','VP8L','VP8X','ALPH'].includes(tag)
      && !(allowInputMetadata && ['ICCP','EXIF','XMP '].includes(tag))) throw new WebpCodecErrorV1('metadata');
    if (tag === 'VP8X' && (bytes[offset + 8]! & ~(allowInputMetadata ? 0x3c : 0x10)) !== 0)
      throw new WebpCodecErrorV1('metadata');
    const length = view.getUint32(offset + 4, true);
    offset += 8 + length + (length % 2);
  }
  return { width, height };
}
function checkedExports(instance: WebAssembly.Instance): CodecExportsV1 {
  const raw = instance.exports;
  if (!(raw.memory instanceof WebAssembly.Memory) || functions.some(name => typeof raw[name] !== 'function'))
    throw new WebpCodecErrorV1('unavailable');
  const result = raw as unknown as CodecExportsV1;
  result._initialize?.();
  if (result.memory.buffer.byteLength !== memoryBytes || result.photo_decoder_version() !== codecVersion
    || result.photo_encoder_version() !== codecVersion) throw new WebpCodecErrorV1('unavailable');
  return result;
}
function memoryRange(api: CodecExportsV1, pointer: number, length: number): Uint8Array {
  if (!Number.isSafeInteger(pointer) || !Number.isSafeInteger(length) || pointer <= 0 || length <= 0
    || pointer + length > api.memory.buffer.byteLength) throw new WebpCodecErrorV1('unavailable');
  return new Uint8Array(api.memory.buffer, pointer, length);
}

/** One adapter per administrative isolate. The module is statically imported from
 * the source-built, hash-checked production artifact; never fetched during a request. */
export class StudentWebpCodecV1 {
  private busy = false;
  constructor(private readonly module: WebAssembly.Module) {
    const imports = WebAssembly.Module.imports(module);
    if (imports.some(item => item.module !== 'wasi_snapshot_preview1' || item.name !== 'proc_exit' || item.kind !== 'function'))
      throw new WebpCodecErrorV1('unavailable');
  }
  private async run<T>(input: Uint8Array, variant: WebpPhotoVariantV1, signal: AbortSignal,
    work: (api: CodecExportsV1, bytes: Uint8Array, size: { width: number; height: number }) => T,
    allowInputMetadata = false): Promise<T> {
    signal.throwIfAborted();
    if (!['portrait','avatar'].includes(variant) || !(input instanceof Uint8Array)
      || input.length < 20 || input.length > maxBytes(variant)) throw new WebpCodecErrorV1('input');
    if (this.busy) throw new WebpCodecErrorV1('unavailable');
    const bytes = new Uint8Array(input);
    this.busy = true;
    let api: CodecExportsV1 | undefined;
    try {
      const size = preflight(bytes, variant, allowInputMetadata);
      const instance = new WebAssembly.Instance(this.module, {
        wasi_snapshot_preview1: { proc_exit: () => { throw new WebpCodecErrorV1('unavailable'); } },
      });
      signal.throwIfAborted();
      api = checkedExports(instance);
      memoryRange(api, api.photo_input_ptr(), bytes.length).set(bytes);
      const result = work(api, bytes, size);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof WebpCodecErrorV1) throw error;
      throw new WebpCodecErrorV1('unavailable');
    } finally {
      bytes.fill(0);
      try { api?.photo_clear(); } finally { this.busy = false; }
    }
  }
  /** Fully decode an already canonical original without changing or recompressing it. */
  validate(input: Uint8Array, variant: WebpPhotoVariantV1, signal: AbortSignal): Promise<{ width: number; height: number }> {
    return this.run(input, variant, signal, (api, bytes, size) => {
      const status = api.photo_validate(bytes.length, variant === 'portrait' ? 0 : 1);
      if (status !== 0) throw new WebpCodecErrorV1(statuses[status] ?? 'unavailable');
      if (api.photo_width() !== size.width || api.photo_height() !== size.height) throw new WebpCodecErrorV1('dimensions');
      return size;
    });
  }
  /** Rebuild upload pixels at the explicit quality; never resize or silently retry. */
  normalize(input: Uint8Array, variant: WebpPhotoVariantV1, quality: WebpPhotoQualityV1, signal: AbortSignal):
    Promise<{ bytes: Uint8Array; width: number; height: number }> {
    if (![92,86,80].includes(quality)) return Promise.reject(new WebpCodecErrorV1('input'));
    return this.run(input, variant, signal, (api, bytes, size) => {
      const status = api.photo_normalize(bytes.length, variant === 'portrait' ? 0 : 1, quality);
      if (status !== 0) throw new WebpCodecErrorV1(statuses[status] ?? 'unavailable');
      const length = api.photo_output_size();
      if (length < 20 || length > maxBytes(variant)) throw new WebpCodecErrorV1('output-size');
      if (api.photo_width() !== size.width || api.photo_height() !== size.height) throw new WebpCodecErrorV1('dimensions');
      const output = new Uint8Array(memoryRange(api, api.photo_output_ptr(), length));
      try {
        const checked = preflight(output, variant);
        if (checked.width !== size.width || checked.height !== size.height) throw new WebpCodecErrorV1('dimensions');
        return { bytes: output, ...size };
      } catch (error) { output.fill(0); throw error; }
    }, true);
  }
}
