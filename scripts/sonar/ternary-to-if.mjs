// Rewrite nested ternaries (Sonar S3358) that sit in a `return`, an arrow body or a `const`
// initializer into if/else statements, keeping the original text of every condition and value.
// Sites with a comment inside, destructuring, or `export const` are left alone.
// Usage: node scripts/sonar/ternary-to-if.mjs <file.ts|tsx>... [--write]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const ts = createRequire(import.meta.url)('typescript');
const write = process.argv.includes('--write');
const files = process.argv.slice(2).filter((a) => a !== '--write');

const strip = (node) => {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
};
const nested = (node) => {
  node = strip(node);
  return ts.isConditionalExpression(node) && (ts.isConditionalExpression(strip(node.whenTrue)) || ts.isConditionalExpression(strip(node.whenFalse)));
};

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const raw = (node) => text.slice(node.getStart(source), node.getEnd());
  const indentOf = (node) => {
    const start = node.getStart(source);
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    return /^[ \t]*/u.exec(text.slice(lineStart, start))[0];
  };
  const unit = /\n( +)\S/u.exec(text)?.[1]?.length >= 4 && !/\n {2}\S/u.test(text) ? '    ' : '  ';
  // if/else chain for a conditional; `sink(exprText)` is the statement for one value.
  // `returning`: every branch returns, so no `else` is needed after an `if`.
  const emit = (expr, sink, indent, returning = false) => {
    expr = strip(expr);
    if (!ts.isConditionalExpression(expr)) return `${indent}${sink(raw(expr))}`;
    const head = `${indent}if (${raw(expr.condition)}) {${nl}${emit(expr.whenTrue, sink, indent + unit, returning)}${nl}${indent}}`;
    const rest = strip(expr.whenFalse);
    if (returning) return `${head}${nl}${emit(rest, sink, indent, true)}`;
    if (ts.isConditionalExpression(rest)) return `${head} else ${emit(rest, sink, indent).trimStart()}`;
    return `${head} else {${nl}${emit(rest, sink, indent + unit)}${nl}${indent}}`;
  };
  // Texts of every value of a (nested) conditional when all are literals, otherwise null.
  const literalLeaves = (expr) => {
    expr = strip(expr);
    if (ts.isConditionalExpression(expr)) {
      const left = literalLeaves(expr.whenTrue);
      const right = literalLeaves(expr.whenFalse);
      return left && right ? [...left, ...right] : null;
    }
    const literal = ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) || ts.isNumericLiteral(expr) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(expr.kind) ||
      (ts.isIdentifier(expr) && expr.text === 'undefined') ||
      (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expr.operand));
    return literal ? [raw(expr)] : null;
  };
  const hasComment = (node) => /\/\/|\/\*/u.test(raw(node));
  const edits = [];
  // Each rewrite answers whether it handled the node (its children are then left alone).
  const rewriteReturn = (node) => {
    if (!(ts.isReturnStatement(node) && node.expression && nested(node.expression) && !hasComment(node))) return false;
    const indent = indentOf(node);
    // A `return` that is the whole body of an unbraced if/else/loop needs braces of its own.
    if (ts.isBlock(node.parent) || ts.isSourceFile(node.parent) || ts.isCaseClause(node.parent) || ts.isDefaultClause(node.parent)) {
      edits.push([node.getStart(source), node.getEnd(), emit(node.expression, (v) => `return ${v};`, indent, true).trimStart()]);
    } else {
      const inner = emit(node.expression, (v) => `return ${v};`, indent + unit, true);
      edits.push([node.getStart(source), node.getEnd(), `{${nl}${inner}${nl}${indent}}`]);
    }
    return true;
  };
  const rewriteArrow = (node) => {
    if (!(ts.isArrowFunction(node) && !ts.isBlock(node.body) && nested(node.body) && !hasComment(node.body))) return false;
    const indent = indentOf(node);
    const inner = emit(node.body, (v) => `return ${v};`, indent + unit, true);
    // The brace goes right after `=>`, even when the old body started on the next line.
    const arrowEnd = node.equalsGreaterThanToken.getEnd();
    if (/\/\/|\/\*/u.test(text.slice(arrowEnd, node.body.getStart(source)))) return true;
    edits.push([arrowEnd, node.body.getEnd(), ` {${nl}${inner}${nl}${indent}}`]);
    return true;
  };
  const rewriteVariable = (node) => {
    if (!ts.isVariableStatement(node) || node.modifiers?.length || node.declarationList.declarations.length !== 1) return false;
    const decl = node.declarationList.declarations[0];
    if (!(ts.isIdentifier(decl.name) && decl.initializer && nested(decl.initializer) && !hasComment(node))) return false;
    const indent = indentOf(node);
    // Without a declared type, `let` would widen literal values ('a' -> string); keep the union.
    const leaves = literalLeaves(decl.initializer);
    let type = '';
    if (decl.type) type = `: ${raw(decl.type)}`;
    else if (leaves) type = `: ${[...new Set(leaves)].join(' | ')}`;
    const name = decl.name.text;
    const body = emit(decl.initializer, (v) => `${name} = ${v};`, indent);
    edits.push([node.getStart(source), node.getEnd(), `let ${name}${type};${nl}${body}`]);
    return true;
  };
  const visit = (node) => {
    if (rewriteReturn(node) || rewriteArrow(node) || rewriteVariable(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!edits.length) continue;
  let out = text;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + replacement + out.slice(end);
  console.log(`${edits.length} ${file}`);
  if (write) writeFileSync(file, out);
}
