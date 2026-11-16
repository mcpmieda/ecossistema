import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requiredCases = [
  'full-lossless-decode-and-lossy-reencode',
  'explicit-qualities',
  'avatar-and-no-resize',
  'maximum-dimensions',
  'reject-invalid-geometry',
  'strip-standard-input-metadata-and-reject-unknown-chunks',
  'reject-alpha-and-animation',
  'real-decoder-rejects-plausible-header',
  'reject-size-format-and-trailing-data',
  'output-budget-no-silent-quality-fallback',
  'recovery-after-rejection-and-repeated-isolation',
  'final-preview-save-byte-equality-and-idempotency',
  'simultaneous-canonical-validation-and-normalization',
];

/** Verify the concrete artifact, source inputs and complete proof, not a mutable approval flag. */
export function verifyPhotoCodecArtifactV1({ directory, root, tree, head, base }) {
  assert.match(tree, /^[a-f0-9]{40}$/u);
  const provenance = JSON.parse(readFileSync(resolve(directory, 'provenance.json'), 'utf8'));
  const proof = JSON.parse(readFileSync(resolve(directory, 'proof.json'), 'utf8'));
  assert.equal(provenance.kind, 'student-photo-codec-build-v1');
  assert.equal(proof.kind, 'student-photo-codec-workerd-proof-v1');
  assert.equal(provenance.applicationTree, tree);
  if (head) assert.equal(provenance.applicationHeadCommit, head);
  if (base) assert.equal(provenance.applicationBaseCommit, base);
  assert.equal(provenance.sourceCommit, '4fa21912338357f89e4fd51cf2368325b59e9bd9');
  assert.equal(provenance.emsdkCommit, '389a68bc35dcff7ebae4614e1615099dafda00d1');
  assert.equal(provenance.emscriptenVersion, '4.0.15');
  assert.equal(provenance.libwebpVersion, '1.6.0');
  assert.equal(provenance.linearMemoryBytes, 33554432);
  assert.equal(provenance.wasmSha256, digest(readFileSync(resolve(directory, 'codec.wasm'))));
  assert.equal(
    provenance.bridgeSha256,
    digest(readFileSync(resolve(root, 'scripts/student-photos/codec-v1/bridge.c'))),
  );
  assert.equal(
    provenance.buildScriptSha256,
    digest(readFileSync(resolve(root, 'scripts/student-photos/codec-v1/build.sh'))),
  );
  for (const key of Object.keys(provenance).filter((key) => key !== 'kind'))
    assert.deepEqual(proof[key], provenance[key]);
  assert.equal(proof.executedDecoderVersion, '1.6.0');
  assert.equal(proof.executedEncoderVersion, '1.6.0');
  assert.equal(proof.memoryGrowthDenied, true);
  assert.equal(proof.outboundRequests, 0);
  assert.deepEqual(new Set(proof.cases.map((test) => test.name)), new Set(requiredCases));
  for (const notice of ['COPYING', 'PATENTS', 'AUTHORS'])
    assert.ok(readFileSync(resolve(directory, notice)).length > 0);
  return { tree, wasmSha256: provenance.wasmSha256, cases: proof.cases.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.cwd();
  const tree =
    process.env.FINAL_TREE_SHA ||
    execFileSync('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const result = verifyPhotoCodecArtifactV1({
    root,
    directory: resolve(root, 'node_modules/.cache/student-photo-codec-v1'),
    tree,
    head: process.env.PR_HEAD_SHA,
    base: process.env.PR_BASE_SHA,
  });
  console.log(JSON.stringify({ state: 'verified', ...result }));
}
