#!/usr/bin/env bash
set -euo pipefail
# Only explicit, pinned source checkouts; no download during image requests.
root=$(git rev-parse --show-toplevel)
cd "$root"
source_dir="$root/node_modules/.cache/student-photo-codec-source"
build_dir="$root/node_modules/.cache/student-photo-codec-build"
out="$root/node_modules/.cache/student-photo-codec-v1"
source_sha=4fa21912338357f89e4fd51cf2368325b59e9bd9
[[ "$(git -C "$source_dir" rev-parse HEAD)" = "$source_sha" ]]
[[ -z "$(git -C "$source_dir" status --porcelain)" ]]
[[ "$(emcc -dumpversion)" = "4.0.15" ]]
mkdir -p "$out"
emcmake cmake -S "$source_dir" -B "$build_dir" \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DWEBP_ENABLE_SIMD=OFF -DWEBP_USE_THREAD=OFF \
  -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF -DWEBP_BUILD_DWEBP=OFF \
  -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF \
  -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF -DWEBP_BUILD_EXTRAS=OFF
cmake --build "$build_dir" --target webp --parallel 2
mapfile -t webp < <(find "$build_dir" -type f -name libwebp.a)
mapfile -t yuv < <(find "$build_dir" -type f -name libsharpyuv.a)
[[ "${#webp[@]}" = 1 ]]
[[ "${#yuv[@]}" = 1 ]]
emcc scripts/student-photos/codec-v1/bridge.c "${webp[0]}" "${yuv[0]}" \
  -I "$source_dir/src" -O2 -DNDEBUG --no-entry -s STANDALONE_WASM=1 \
  -s FILESYSTEM=0 -s MALLOC=emmalloc -s ABORTING_MALLOC=0 \
  -s ALLOW_MEMORY_GROWTH=0 -s INITIAL_MEMORY=33554432 -s STACK_SIZE=262144 \
  -s 'EXPORTED_FUNCTIONS=["_photo_clear","_photo_input_ptr","_photo_output_ptr","_photo_output_size","_photo_width","_photo_height","_photo_decoder_version","_photo_encoder_version","_photo_normalize","_photo_validate"]' \
  -o "$out/codec.wasm"
cp "$source_dir/COPYING" "$source_dir/PATENTS" "$source_dir/AUTHORS" "$out/"
SOURCE_SHA="$source_sha" node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const directory = 'node_modules/.cache/student-photo-codec-v1';
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const applicationCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const applicationTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
const applicationHeadCommit = process.env.PR_HEAD_SHA || null;
const applicationBaseCommit = process.env.PR_BASE_SHA || null;
const checkoutParents = execFileSync('git', ['cat-file', '-p', 'HEAD'], { encoding: 'utf8' })
  .split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
if (applicationHeadCommit !== null || applicationBaseCommit !== null || process.env.GITHUB_EVENT_NAME === 'pull_request') {
  // GitHub may advance main while a PR event retains its earlier base.sha.
  // Never weaken identity: the synthetic merge must contain EXACTLY the PR
  // head as second parent and the CURRENT fetched main as first parent.
  // The event base must be an ancestor of that main, not an unrelated ref.
  const currentMain = execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], { encoding: 'utf8' }).trim();
  const baseAncestor = /^[a-f0-9]{40}$/u.test(applicationBaseCommit ?? '')
    && execFileSync('git', ['merge-base', applicationBaseCommit, currentMain], { encoding: 'utf8' }).trim() === applicationBaseCommit;
  if (!/^[a-f0-9]{40}$/u.test(applicationHeadCommit ?? '')
    || !baseAncestor || checkoutParents.length !== 2
    || checkoutParents[0] !== currentMain || checkoutParents[1] !== applicationHeadCommit)
    throw new Error('student-photo-codec-provenance-mismatch');
}
const report = {
  kind: 'student-photo-codec-build-v1', applicationCommit, applicationTree, applicationHeadCommit, applicationBaseCommit, checkoutParents,
  sourceCommit: process.env.SOURCE_SHA,
  emsdkCommit: '389a68bc35dcff7ebae4614e1615099dafda00d1',
  emscriptenVersion: '4.0.15', libwebpVersion: '1.6.0',
  wasmSha256: digest(`${directory}/codec.wasm`),
  bridgeSha256: digest('scripts/student-photos/codec-v1/bridge.c'),
  buildScriptSha256: digest('scripts/student-photos/codec-v1/build.sh'),
  linearMemoryBytes: 33554432, productionApproved: false,
};
writeFileSync(`${directory}/provenance.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
JS
