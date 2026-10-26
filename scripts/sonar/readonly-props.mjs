// Wrap the props type of the components Sonar flags (S6759) in Readonly<…>.
// Usage: node readonly-props.mjs <repo> <issues.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [repo, issuesPath] = process.argv.slice(2);
const ts = createRequire(repo + '/package.json')('typescript');
const issues = JSON.parse(readFileSync(issuesPath, 'latin1')).filter((i) => i.rule === 'typescript:S6759');
const byFile = new Map();
for (const issue of issues) byFile.set(issue.file, [...(byFile.get(issue.file) ?? []), issue.line]);
let changed = 0;
const skipped = [];
for (const [file, lines] of byFile) {
  const path = `${repo}/${file}`;
  let text = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const visit = (node) => {
    const fn =
      ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? node : null;
    if (fn) {
      const line = source.getLineAndCharacterOfPosition(fn.getStart(source)).line + 1;
      const parentLine =
        ts.isVariableDeclaration(fn.parent) ? source.getLineAndCharacterOfPosition(fn.parent.getStart(source)).line + 1 : -1;
      if (lines.includes(line) || lines.includes(parentLine)) {
        const type = fn.parameters[0]?.type;
        if (type && !(ts.isTypeReferenceNode(type) && type.typeName.getText(source) === 'Readonly'))
          edits.push([type.getStart(source), type.getEnd()]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!edits.length) {
    skipped.push(file + ':' + lines.join(','));
    continue;
  }
  edits.sort((a, b) => b[0] - a[0]);
  for (const [start, end] of edits)
    text = text.slice(0, start) + 'Readonly<' + text.slice(start, end) + '>' + text.slice(end);
  writeFileSync(path, text);
  changed += edits.length;
}
console.log('wrapped', changed, 'of', issues.length);
if (skipped.length) console.log('not found:\n' + skipped.join('\n'));
