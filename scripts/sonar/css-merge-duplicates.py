"""Merge repeated CSS rules (top level and inside each @media) of the CSS file given into their first occurrence.

Later declarations win (as in the cascade) and are moved up to the first rule's place; the later
rule (and its comment) disappears. Reports any rule between the two with the same selector
specificity that sets one of the moved properties and shares a class with it: those would change.
Usage: python scripts/sonar/css-merge-duplicates.py <file.css> [--write]   (then validate with lightningcss and compare computed styles in the browser)
"""
import re
import sys

from repo_files import inside_root


PATH = inside_root(sys.argv[1])
src = open(PATH, encoding='utf-8').read()
# Optional: a JSON list of [selector, selector] pairs measured in the browser as never matching the
# same element (no element matched both across the preview pages and states that were visited).
MEASURED = set()
if '--disjoint' in sys.argv:
    import json
    with open(inside_root(sys.argv[sys.argv.index('--disjoint') + 1]), encoding='utf-8') as handle:
        MEASURED = {frozenset(pair) for pair in json.load(handle)}


def closing_brace(text, brace):
    """Index of the brace that closes the one at `brace`."""
    depth = 0
    j = brace
    while True:
        if text[j] == '{':
            depth += 1
        elif text[j] == '}':
            depth -= 1
            if depth == 0:
                return j
        j += 1


def blocks(text):
    """Top-level items: (kind, start, end, selector, body). Comments directly before a rule belong to it."""
    out = []
    i = 0
    pending = None
    while i < len(text):
        if text[i].isspace():
            i += 1
            continue
        if text.startswith('/*', i):
            pending = i if pending is None else pending
            i = text.index('*/', i) + 2
            continue
        start = pending if pending is not None else i
        pending = None
        brace = text.index('{', i)
        sel = text[i:brace].strip()
        j = closing_brace(text, brace)
        out.append((start, j + 1, ' '.join(sel.split()), text[brace + 1:j], i))
        i = j + 1
    return out


def decls(body):
    items = []
    # Comments first: one may contain ';' (it would split a declaration in two).
    body = re.sub(r'/\*.*?\*/', '', body, flags=re.S)
    for part in body.split(';'):
        part = part.strip()
        if not part or part.startswith('/*'):
            continue
        part = re.sub(r'/\*.*?\*/', '', part, flags=re.S).strip()
        if ':' not in part:
            continue
        prop, value = part.split(':', 1)
        items.append((prop.strip(), value.strip()))
    return items


def spec(sel):
    return (len(re.findall(r'#', sel)), len(re.findall(r'[.\[]|:(?!:)', sel)), len(re.findall(r'(^|[\s>+~])[a-z]', sel)))


def last(sel):
    return re.split(r'[\s>+~]+', sel.strip())[-1]


def nth_fixed(x):
    return int(x) if re.fullmatch(r'\d+', x) else None


def nth_from(x):
    m = re.fullmatch(r'n\s*\+\s*(\d+)', x)
    return int(m.group(1)) if m else None


def nth_disjoint(a, b):
    """Different fixed :nth-child positions, or a fixed position before an `n+k` range."""
    na, nb = re.findall(r':nth-child\(([^)]*)\)', a), re.findall(r':nth-child\(([^)]*)\)', b)
    if not (na and nb and len(na) == len(nb)):
        return False
    if na != nb and all(re.fullmatch(r'\d+', x) for x in na + nb):
        return True
    for x, y in zip(na, nb):
        fx, fy, kx, ky = nth_fixed(x), nth_fixed(y), nth_from(x), nth_from(y)
        if (fx is not None and ky is not None and fx < ky) or (fy is not None and kx is not None and fy < kx):
            return True
    return False


def disjoint(a, b):
    """True when the two selectors can never match the same element (heuristic, conservative)."""
    if frozenset((a, b)) in MEASURED:
        return True
    la, lb = last(a), last(b)
    ta, tb = re.match(r'^[a-z][\w-]*', la), re.match(r'^[a-z][\w-]*', lb)
    if ta and tb and ta.group(0) != tb.group(0):
        return True
    # Different classes do NOT prove different elements (.card and .card--positive share one).
    if nth_disjoint(a, b):
        return True
    aa = dict(re.findall(r"\[([\w-]+)='([^']*)'\]", a))
    ab = dict(re.findall(r"\[([\w-]+)='([^']*)'\]", b))
    if any(k in ab and ab[k] != v for k, v in aa.items()):
        return True
    return False


LONGHANDS = {
    'padding': r'padding-(top|right|bottom|left|inline|block)(-start|-end)?',
    'margin': r'margin-(top|right|bottom|left|inline|block)(-start|-end)?',
    'border': r'border-((top|right|bottom|left)(-(width|style|color))?|width|style|color)',
    'border-top': r'border-top-(width|style|color)',
    'border-bottom': r'border-bottom-(width|style|color)',
    'border-left': r'border-left-(width|style|color)',
    'border-right': r'border-right-(width|style|color)',
    'background': r'background-(color|image|position|size|repeat|attachment|origin|clip)',
    'font': r'font-(style|variant|weight|stretch|size|family)|line-height',
    'gap': r'(row|column)-gap',
    'outline': r'outline-(width|style|color)',
    'overflow': r'overflow-(x|y)',
    'flex': r'flex-(grow|shrink|basis)',
    'inset': r'top|right|bottom|left',
    'animation': r'animation-[a-z-]+',
    'transition': r'transition-[a-z-]+',
    'text-decoration': r'text-decoration-(line|style|color|thickness)',
    'list-style': r'list-style-(type|position|image)',
    'border-radius': r'border-(top|bottom)-(left|right)-radius',
}


def dead(prop, later):
    """A longhand followed, in the same rule, by a shorthand that resets it (Sonar S4657)."""
    return any(short in LONGHANDS and re.fullmatch(LONGHANDS[short], prop) for short in later)


AT_RULES = ('@media', '@supports', '@container', '@layer')


def process_nested(src, items, depth):
    """Each @media/@supports/... block is processed on its own (up to three levels)."""
    rebuilt = []
    cursor = 0
    for (_start, end, sel, _body, sel_at) in items:
        if sel.startswith(AT_RULES):
            brace = src.index('{', sel_at)
            inner = process(src[brace + 1:end - 1], depth + 1)
            rebuilt.append(src[cursor:brace + 1] + inner + '}')
            cursor = end
    rebuilt.append(src[cursor:])
    return ''.join(rebuilt)


def merged_declarations(items, indexes):
    """Every declaration of the group in source order; the merged rule keeps each property at the
    place of its LAST declaration (the one that wins), so shorthand/longhand order holds."""
    seq = [(prop, value) for index in indexes for prop, value in decls(items[index][3])]
    position = {prop: k for k, (prop, _) in enumerate(seq)}
    result = dict(seq)
    order = sorted(position, key=position.get)
    order = [prop for k, prop in enumerate(order)
             if not (dead(prop, [o for o in order[k + 1:] if '!important' not in result[o]]) and '!important' not in result[prop])]
    return [(prop, result[prop]) for prop in order]


def inner_rules(other):
    """The rule itself, or the rules inside an @media/@supports block in between."""
    if other[2].startswith('@'):
        return [(o[2], o[3]) for o in blocks(other[3])]
    return [(other[2], other[3])]


def conflicts(items, sel, indexes, moved):
    found = []
    for between in range(indexes[0] + 1, indexes[-1]):
        if between in indexes:
            continue
        for osel, obody in inner_rules(items[between]):
            if osel.startswith('@') or spec(osel) != spec(sel) or disjoint(sel, osel):
                continue
            props = {prop for prop, _ in decls(obody)} & moved
            if props:
                found.append(f'{sel}  <->  {osel}: {sorted(props)}')
    return found


def plan_group(items, sel, indexes):
    """(index that keeps the merged rule, indexes removed, warnings): up into the first rule when
    nothing in between disagrees, otherwise down into the last, otherwise skipped."""
    up = conflicts(items, sel, indexes, {prop for index in indexes[1:] for prop, _ in decls(items[index][3])})
    if not up:
        return indexes[0], indexes[1:], []
    last_props = {prop for prop, _ in decls(items[indexes[-1]][3])}
    down = conflicts(items, sel, indexes, {prop for index in indexes[:-1] for prop, _ in decls(items[index][3])} - last_props)
    if not down:
        return indexes[-1], indexes[:-1], []
    return None, [], up + down


def rebuild(src, items, remove, merged):
    out = []
    cursor = 0
    for index, (start, end, _sel, _body, sel_at) in enumerate(items):
        out.append(src[cursor:start])
        cursor = end
        if index in remove:
            # drop the blank line left behind
            while cursor < len(src) and src[cursor] == '\n' and src[cursor + 1:cursor + 2] == '\n':
                cursor += 1
            continue
        if index in merged:
            sel_text = src[sel_at:src.index('{', sel_at)].rstrip()
            out.append(src[start:sel_at])
            lines = '\n'.join(f'  {prop}: {value};' for prop, value in merged[index])
            out.append(f'{sel_text} {{\n{lines}\n}}')
        else:
            out.append(src[start:end])
    out.append(src[cursor:])
    return ''.join(out)


def process(src, depth=0):
    items = blocks(src)
    if depth < 3:
        src = process_nested(src, items, depth)
        items = blocks(src)
    by_sel = {}
    for index, item in enumerate(items):
        if not item[2].startswith('@'):
            by_sel.setdefault(item[2], []).append(index)
    remove = set()
    merged = {}
    warnings = []
    for sel, indexes in by_sel.items():
        if len(indexes) < 2:
            continue
        keep, removed, found = plan_group(items, sel, indexes)
        if keep is None:
            warnings.extend(found)
            print('PULADO', sel, 'nivel', depth)
            continue
        merged[keep] = merged_declarations(items, indexes)
        remove.update(removed)
    print('nivel', depth, 'repetidas:', sum(1 for v in by_sel.values() if len(v) > 1), 'regras a remover:', len(remove))
    for w in warnings:
        print('ATENCAO', w)
    return rebuild(src, items, remove, merged)

result = process(src)
if '--write' in sys.argv:
    open(PATH, 'w', encoding='utf-8', newline=chr(10)).write(result)
    print('gravado')
