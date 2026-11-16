import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the actual discovery/guard block, not a handwritten copy of its conditions.
const script = readFileSync('scripts/student-photos/codec-v1/build.sh', 'utf8');
const start = script.indexOf('mapfile -t webp');
const end = script.indexOf('\nemcc scripts/', start);
assert(start >= 0 && end > start, 'Archive guard block must be present');
const guard = script.slice(start, end);
let cases = 0;
for (const webp of [0, 1, 2])
  for (const yuv of [0, 1, 2]) {
    const directory = mkdtempSync(join(tmpdir(), 'photo-codec-guard-'));
    try {
      for (const [name, count] of [
        ['libwebp.a', webp],
        ['libsharpyuv.a', yuv],
      ]) {
        for (let index = 0; index < count; index++) {
          const path = join(directory, `${name}-${index}`);
          mkdirSync(path);
          writeFileSync(join(path, name), 'synthetic');
        }
      }
      const result = spawnSync(
        'bash',
        [
          '-c',
          'set -euo pipefail\nbuild_dir="$1"\n' + guard + '\nprintf accepted',
          '--',
          directory,
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status === 0, webp === 1 && yuv === 1, `Archive counts ${webp}/${yuv}`);
      assert.equal(result.stdout, webp === 1 && yuv === 1 ? 'accepted' : '');
      cases++;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
console.log(JSON.stringify({ event: 'codec-archive-guards-passed', cases }));
