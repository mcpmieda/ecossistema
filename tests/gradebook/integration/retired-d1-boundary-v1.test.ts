import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createGradebookPostgresDatabaseFromSqlV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { lazyGradebookDatabaseV1 } from '../../../server/gradebook/persistence/postgres/lazy-gradebook-database-v1';

const root = process.cwd();
const archive = 'Aprendizados/RUNTIME-D1-RETIRADO-1079/';

function codeFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return codeFiles(path);
    return /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : [];
  });
}

function forbiddenImports(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const record = (specifier: ts.Node | undefined) => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    const target = relative(root, resolve(dirname(path), specifier.text)).replaceAll('\\', '/');
    if (target.startsWith('Aprendizados/') || target.includes('server/gradebook/persistence/d1/')) {
      found.push(specifier.text);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) record(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) record(node.argument.literal);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) record(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('retired D1 runtime boundary #1079', () => {
  it('keeps runtime modules archived and all active imports independent of historical memory', () => {
    expect(codeFiles(join(root, 'server/gradebook/persistence/d1'))).toEqual([]);
    expect(existsSync(join(root, archive, 'README.md'))).toBe(true);
    const violations = ['server', 'functions', 'src', 'shared', 'scripts', 'build', 'tests']
      .flatMap((directory) => codeFiles(join(root, directory)))
      .flatMap((path) => forbiddenImports(path, readFileSync(path, 'utf8'))
        .map((specifier) => `${relative(root, path)} -> ${specifier}`));
    expect(violations).toEqual([]);
  });

  it('detects value, type, reexport and lazy consumers but permits documentary string references', () => {
    const path = join(root, 'tests/retirement-probe.ts');
    const target = '../server/gradebook/persistence/d1/runtime/d1-runtime-v1';
    for (const statement of [
      `import { runtime } from '${target}';`,
      `import type { Runtime } from '${target}';`,
      `export * from '${target}';`,
      `type Runtime = import('${target}').Runtime;`,
      `import('${target}');`,
      `require('${target}');`,
      'import(`' + target + '`);',
      'require(`' + target + '`);',
    ]) expect(forbiddenImports(path, statement), statement).toEqual([target]);
    expect(forbiddenImports(path, `readFileSync('${target}');`)).toEqual([]);
    const archived = `../${archive}server/gradebook/persistence/d1/runtime/d1-runtime-v1`;
    expect(forbiddenImports(path, `import('${archived}');`)).toEqual([archived]);
    expect(forbiddenImports(path, 'import(`' + archived + '`);')).toEqual([archived]);
  });

  it('does not expose the retired protocol on root, transaction or lazy PostgreSQL ports', async () => {
    const unsafe = vi.fn(async () => []);
    const database = createGradebookPostgresDatabaseFromSqlV1({
      unsafe,
      begin: async (operation) => operation({ unsafe }),
    });
    const create = vi.fn(async () => database);
    const lazy = lazyGradebookDatabaseV1(create);
    const assertNativeOnly = (port: object) => {
      for (const method of ['prepare', 'exec', 'batch', 'execute']) {
        expect(method in port, method).toBe(false);
      }
      expect(port).toHaveProperty('query');
      expect(port).toHaveProperty('executeNative');
    };
    assertNativeOnly(database);
    assertNativeOnly(lazy);
    await database.transaction(async (transaction) => assertNativeOnly(transaction));
    expect(create).not.toHaveBeenCalled();
    expect(unsafe).not.toHaveBeenCalled();
    await lazy.close();
    await database.close();
  });
});
