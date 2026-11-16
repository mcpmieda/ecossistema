import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const directory = 'node_modules/.cache/student-photo-codec-v1';
const wasm = readFileSync(`${directory}/codec.wasm`);
const provenance = JSON.parse(readFileSync(`${directory}/provenance.json`, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(wasm), provenance.wasmSha256);
assert.equal(provenance.sourceCommit, '4fa21912338357f89e4fd51cf2368325b59e9bd9');
const module = await WebAssembly.compile(wasm); // Node test only; never done in the Worker.
const imports = WebAssembly.Module.imports(module);
assert.ok(
  imports.every(
    (item) =>
      item.module === 'wasi_snapshot_preview1' &&
      item.name === 'proc_exit' &&
      item.kind === 'function',
  ),
);
const instance = await WebAssembly.instantiate(module, {
  wasi_snapshot_preview1: {
    proc_exit: () => {
      throw new Error('codec-exit');
    },
  },
});
instance.exports._initialize?.();
assert.equal(instance.exports.photo_decoder_version(), 0x010600);
assert.equal(instance.exports.photo_encoder_version(), 0x010600);
assert.equal(instance.exports.memory.buffer.byteLength, 33554432);
assert.throws(() => instance.exports.memory.grow(1), RangeError);

const bundle = resolve('node_modules/.cache/student-photo-codec-proof');
const bundleFiles = readdirSync(bundle);
const entrypoints = bundleFiles.filter((name) => /\.(?:mjs|js)$/.test(name));
assert.equal(entrypoints.length, 1, `Expected one bundled entrypoint: ${bundleFiles.join(', ')}`);
const bundledWasm = bundleFiles.filter((name) => name.endsWith('.wasm'));
assert.equal(bundledWasm.length, 1);
assert.equal(sha256(readFileSync(resolve(bundle, bundledWasm[0]))), provenance.wasmSha256);
console.log(
  JSON.stringify({ event: 'codec-proof-bundle', entrypoint: entrypoints[0], wasm: bundledWasm[0] }),
);
let outbound = 0;
const mf = new Miniflare(
  convertV4MiniflareOptions({
    cf: false,
    workers: [
      {
        name: 'codec-proof',
        modulesRoot: bundle,
        modules: [
          { type: 'ESModule', path: resolve(bundle, entrypoints[0]) },
          { type: 'CompiledWasm', path: resolve(bundle, bundledWasm[0]) },
        ],
        compatibilityDate: '2026-09-11',
        outboundService: () => {
          outbound++;
          return new Response(null, { status: 403 });
        },
      },
    ],
  }),
);
let caller;
const cases = [];
async function check(name, work) {
  const start = performance.now();
  await work();
  const result = { name, elapsedMs: Math.round(performance.now() - start) };
  cases.push(result);
  console.log(JSON.stringify({ event: 'codec-proof-case-passed', ...result }));
}
function raster(width, height, alpha = 255) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 7 + y * 3) % 256;
      data[i + 1] = (x * 2 + y * 5) % 256;
      data[i + 2] = (x + y * 11) % 256;
      data[i + 3] = alpha;
    }
  return { data, raw: { width, height, channels: 4 } };
}
async function fixture(width, height, alpha = 255) {
  const image = raster(width, height, alpha);
  return sharp(image.data, { raw: image.raw }).webp({ lossless: true }).toBuffer();
}
async function request(bytes, variant = 'portrait', quality = 92) {
  return caller.fetch(`http://codec.test/?variant=${variant}&quality=${quality}`, {
    method: 'POST',
    body: bytes,
    signal: AbortSignal.timeout(15000),
  });
}
async function rejected(bytes, variant, quality, expected) {
  const response = await request(bytes, variant, quality);
  assert.equal(response.status, 422);
  assert.equal(await response.text(), expected);
}
function extraChunk(bytes, kind) {
  const data = Buffer.from('synthetic');
  const chunk = Buffer.alloc(8 + data.length + (data.length % 2));
  chunk.write(kind, 0, 4, 'ascii');
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  const result = Buffer.concat([bytes, chunk]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}
function extendedWithMetadata(bytes, kind, width, height) {
  const flags = { ICCP: 0x20, EXIF: 0x08, 'XMP ': 0x04 };
  const canvas = Buffer.alloc(18);
  canvas.write('VP8X', 0, 4, 'ascii');
  canvas.writeUInt32LE(10, 4);
  canvas[8] = flags[kind];
  canvas.writeUIntLE(width - 1, 12, 3);
  canvas.writeUIntLE(height - 1, 15, 3);
  const data = Buffer.from('synthetic');
  const chunk = Buffer.alloc(8 + data.length + (data.length % 2));
  chunk.write(kind, 0, 4, 'ascii');
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  const payload =
    kind === 'ICCP' ? [canvas, chunk, bytes.subarray(12)] : [canvas, bytes.subarray(12), chunk];
  const result = Buffer.concat([bytes.subarray(0, 12), ...payload]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}
async function normalized(bytes, variant, width, height, quality = 92) {
  const response = await request(bytes, variant, quality);
  assert.equal(response.status, 200, `normalize ${width}x${height}: ${response.status}`);
  const result = Buffer.from(await response.arrayBuffer());
  assert.ok(result.length <= (variant === 'portrait' ? 131072 : 65536));
  assert.equal(Number(response.headers.get('x-width')), width);
  assert.equal(Number(response.headers.get('x-height')), height);
  // Independent native decoder only in tests, not inside the Worker or upload service.
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.width, width);
  assert.equal(metadata.height, height);
  assert.equal(metadata.hasAlpha, false);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  assert.equal(metadata.xmp, undefined);
  await sharp(result).raw().toBuffer();
  return result;
}

try {
  caller = await mf.getWorker('codec-proof');
  const portrait = await fixture(30, 40),
    avatar = await fixture(32, 32);
  await check('full-lossless-decode-and-lossy-reencode', async () => {
    const output = await normalized(portrait, 'portrait', 30, 40);
    assert.notEqual(sha256(output), sha256(portrait));
    assert.equal(sha256(await normalized(portrait, 'portrait', 30, 40)), sha256(output));
  });
  await check('simultaneous-canonical-validation-and-normalization', async () => {
    const response = await caller.fetch('http://codec.test/validate-concurrency', {
      method: 'POST',
      body: portrait,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      unchanged: true,
      dimensions: [
        [30, 40],
        [30, 40],
        [30, 40],
      ],
    });
  });
  await check('explicit-qualities', async () => {
    for (const quality of [92, 86, 80]) await normalized(portrait, 'portrait', 30, 40, quality);
    for (const quality of [0, 79, 93, 100, 'missing'])
      await rejected(portrait, 'portrait', quality, 'input');
  });
  await check('avatar-and-no-resize', async () => {
    await normalized(avatar, 'avatar', 32, 32);
  });
  await check('maximum-dimensions', async () => {
    for (const [variant, width, height] of [
      ['portrait', 900, 1200],
      ['avatar', 320, 320],
    ]) {
      const bytes = await sharp({
        create: { width, height, channels: 3, background: { r: 20, g: 60, b: 100 } },
      })
        .webp({ lossless: true })
        .toBuffer();
      await normalized(bytes, variant, width, height);
    }
  });
  await check('reject-invalid-geometry', async () => {
    await rejected(await fixture(30, 41), 'portrait', 92, 'dimensions');
    await rejected(await fixture(321, 321), 'avatar', 92, 'dimensions');
    await rejected(await fixture(903, 1204), 'portrait', 92, 'dimensions');
  });
  await check('strip-standard-input-metadata-and-reject-unknown-chunks', async () => {
    for (const tag of ['EXIF', 'XMP ', 'ICCP'])
      await normalized(extendedWithMetadata(portrait, tag, 30, 40), 'portrait', 30, 40);
    await rejected(extraChunk(portrait, 'JUNK'), 'portrait', 92, 'metadata');
  });
  await check('reject-alpha-and-animation', async () => {
    await rejected(await fixture(30, 40, 120), 'portrait', 92, 'alpha');
    await rejected(extraChunk(portrait, 'ANIM'), 'portrait', 92, 'input');
  });
  await check('real-decoder-rejects-plausible-header', async () => {
    const lossy = await sharp(portrait).webp({ quality: 92 }).toBuffer();
    assert.equal(lossy.toString('ascii', 12, 16), 'VP8 ');
    const corrupt = Buffer.from(lossy.subarray(0, 30));
    corrupt.writeUInt32LE(corrupt.length - 8, 4);
    corrupt.writeUInt32LE(corrupt.length - 20, 16);
    await rejected(corrupt, 'portrait', 92, 'decode');
  });
  await check('reject-size-format-and-trailing-data', async () => {
    await rejected(Buffer.alloc(131073), 'portrait', 92, 'input');
    await rejected(Buffer.alloc(65537), 'avatar', 92, 'input');
    await rejected(Buffer.concat([portrait, Buffer.from([0, 0])]), 'portrait', 92, 'input');
    await rejected(await sharp(portrait).png().toBuffer(), 'portrait', 92, 'input');
  });
  await check('output-budget-no-silent-quality-fallback', async () => {
    const image = raster(600, 800);
    let seed = 123456789;
    for (let i = 0; i < image.data.length; i += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      image.data[i] = seed & 255;
      image.data[i + 1] = (seed >>> 8) & 255;
      image.data[i + 2] = (seed >>> 16) & 255;
    }
    let selected;
    for (const quality of [1, 5, 10, 20, 40]) {
      const candidate = await sharp(image.data, { raw: image.raw }).webp({ quality }).toBuffer();
      if (candidate.length > 131072) continue;
      const oracle = await sharp(candidate)
        .webp({ quality: 92, preset: 'photo', effort: 4 })
        .toBuffer();
      if (oracle.length > 131072) {
        selected = candidate;
        break;
      }
    }
    assert.ok(selected, 'A bounded synthetic output-budget fixture must exist');
    await rejected(selected, 'portrait', 92, 'output-size');
  });
  await check('recovery-after-rejection-and-repeated-isolation', async () => {
    for (let i = 0; i < 6; i++) {
      await rejected(Buffer.alloc(20), 'portrait', 92, 'input');
      await normalized(
        i % 2 ? avatar : portrait,
        i % 2 ? 'avatar' : 'portrait',
        i % 2 ? 32 : 30,
        i % 2 ? 32 : 40,
      );
    }
  });
  await check('final-preview-save-byte-equality-and-idempotency', async () => {
    const response = await caller.fetch('http://codec.test/edit-proof', {
      method: 'POST',
      body: JSON.stringify({ portrait: Array.from(portrait), avatar: Array.from(avatar) }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, 'Real codec edit composition must complete');
    const result = await response.json();
    assert.equal(result.state, 'passed');
    assert.equal(result.claims, 2);
    assert.equal(result.commits, 1);
    assert.equal(result.uploads, 2);
    assert.equal(result.changedPreviewRejected, true);
    for (const [variant, width, height] of [
      ['portrait', 30, 40],
      ['avatar', 32, 32],
    ]) {
      const bytes = Buffer.from(result[variant]);
      assert.equal(sha256(bytes), result.output[variant].sha256);
      assert.equal(bytes.length, result.output[variant].byteSize);
      const image = await sharp(bytes).metadata();
      assert.equal(image.width, width);
      assert.equal(image.height, height);
      assert.equal(image.hasAlpha, false);
      await sharp(bytes).raw().toBuffer();
    }
  });
  assert.equal(outbound, 0);
  const report = {
    ...provenance,
    kind: 'student-photo-codec-workerd-proof-v1',
    executedDecoderVersion: '1.6.0',
    executedEncoderVersion: '1.6.0',
    memoryGrowthDenied: true,
    outboundRequests: outbound,
    cases,
    productionApproved: false,
  };
  writeFileSync(`${directory}/proof.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await mf.dispose();
}
