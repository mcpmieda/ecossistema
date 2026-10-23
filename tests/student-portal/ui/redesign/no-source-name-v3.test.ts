import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Owner decision 23/10/2026: the Portal do Aluno never names the system the data comes from. Comments
// may (they explain where the data comes from); no text the student can see may.
const withoutComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`])\/\/.*$/gmu, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/gu, '');
const filesOf = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesOf(join(dir, entry.name)) : /\.(tsx?|css)$/u.test(entry.name) ? [join(dir, entry.name)] : [],
  );

it('no text of the Portal do Aluno names the source system', () => {
  const named = filesOf('src/features/student-portal').filter((file) =>
    /smecel/iu.test(withoutComments(readFileSync(file, 'utf8'))),
  );
  expect(named).toEqual([]);
});
