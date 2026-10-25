// Sonar S6819: an HTML element with role="status" | "group" | "region" | "list" | "listitem" becomes
// the native element that already has that role, keeping the layout:
//   <p|span role="status">  → the same p or span with its content inside <output className="contents">
//                             (CSS that selects p or span keeps applying, and with display: contents
//                             the children stay items of a flex or grid p, with the same gaps)
//   <div role="status">     → <output className="block …">  (output is inline by default)
//   <div|span role="group"> → <fieldset className="min-w-auto …"> (a fieldset shrinks to min-content)
//   <div role="region">     → <section>  (named by its aria-label, as before)
//   <div role="list">       → <ul>, <span role="listitem"> → <li>
// The block or min-w-auto class is not added when the className already sets a display or a minimum
// width. Tailwind's preflight already removes the margins, padding and borders of p, ul and fieldset.
// Usage: node scripts/sonar/native-roles.mjs <file.tsx>... [--write]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const ts = createRequire(import.meta.url)('typescript');
const write = process.argv.includes('--write');
const files = process.argv.slice(2).filter((a) => a !== '--write');

const TARGET = {
  status: { p: 'wrap', div: 'output', span: 'wrap' },
  group: { div: 'fieldset', span: 'fieldset' },
  region: { div: 'section' },
  list: { div: 'ul' },
  listitem: { span: 'li', div: 'li' },
};
const DISPLAY = /(^|\s)(block|inline|inline-block|inline-flex|inline-grid|flex|grid|hidden|contents|table|flow-root|sr-only)(\s|$)/u;

/** The role and its aria-* attributes move to an <output className="contents"> around the content. */
function wrapEdits(node, roleAttr, tag, source, edits, skipped) {
  // The role and the aria-* attributes that belong to it move to an <output> around the content.
  const moved = node.attributes.properties.filter(
    (a) => ts.isJsxAttribute(a) && /^aria-(?!hidden)/u.test(a.name.getText(source)),
  );
  for (const attribute of [roleAttr, ...moved]) edits.push([attribute.getFullStart(), attribute.getEnd(), '']);
  const own = moved.map((a) => ' ' + a.getText(source)).join('');
  if (ts.isJsxOpeningElement(node)) {
    edits.push([node.getEnd(), node.getEnd(), `<output className="contents"${own}>`]);
    edits.push([node.parent.closingElement.getStart(source), node.parent.closingElement.getStart(source), '</output>']);
  } else skipped.push(`empty ${tag} @${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
}

/** The extra class goes into a literal className (unless one already sets that display or width). */
function classEdits(node, classAttr, extra, source, edits, skipped) {
  if (!classAttr) {
    edits.push([node.tagName.getEnd(), node.tagName.getEnd(), ` className="${extra}"`]);
  } else if (classAttr.initializer && ts.isStringLiteral(classAttr.initializer)) {
    const value = classAttr.initializer.text;
    const clash = extra === 'block' ? DISPLAY.test(value) : /(^|\s)min-w-/u.test(value);
    if (!clash) edits.push([classAttr.initializer.getStart(source) + 1, classAttr.initializer.getStart(source) + 1, `${extra} `]);
  } else {
    skipped.push(`dynamic className, ${extra} not added @${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
  }
}

/** The element becomes the native tag; an <output> other than a span is a block, a fieldset keeps
 * its width. */
function renameEdits(node, roleAttr, next, tag, source, edits, skipped) {
  const classAttr = node.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(source) === 'className');
  let extra = '';
  if (next === 'output' && tag !== 'span') extra = 'block';
  if (next === 'fieldset') extra = 'min-w-auto';
  // Role attribute out (with the whitespace before it).
  let start = roleAttr.getFullStart();
  edits.push([start, roleAttr.getEnd(), '']);
  if (extra) classEdits(node, classAttr, extra, source, edits, skipped);
  edits.push([node.tagName.getStart(source), node.tagName.getEnd(), next]);
  if (ts.isJsxOpeningElement(node)) {
    const closing = node.parent.closingElement.tagName;
    edits.push([closing.getStart(source), closing.getEnd(), next]);
  }
}

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const skipped = [];
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      const roleAttr = node.attributes.properties.find(
        (a) => ts.isJsxAttribute(a) && a.name.getText(source) === 'role' && a.initializer && ts.isStringLiteral(a.initializer),
      );
      const role = roleAttr?.initializer.text;
      const next = role && TARGET[role]?.[tag];
      if (roleAttr && role in TARGET && !next) skipped.push(`${tag} role=${role} @${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      if (next === 'wrap') wrapEdits(node, roleAttr, tag, source, edits, skipped);
      else if (next) renameEdits(node, roleAttr, next, tag, source, edits, skipped);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (skipped.length) console.log(`  ${file}: ${skipped.join('; ')}`);
  if (!edits.length) continue;
  let out = text;
  edits.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (const [s, e, r] of edits) out = out.slice(0, s) + r + out.slice(e);
  console.log(`${edits.length} ${file}`);
  if (write) writeFileSync(file, out);
}
