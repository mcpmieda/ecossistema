"""Merge repeated CSS rules (top level and inside each @media) of the CSS file given into their first occurrence.

Later declarations win (as in the cascade) and are moved up to the first rule's place; the later
rule (and its comment) disappears. Reports any rule between the two with the same selector
specificity that sets one of the moved properties and shares a class with it: those would change.
Usage: python cssmerge.py [--write]
"""
import re
import sys

PATH = sys.argv[1]
src = open(PATH, encoding='utf-8').read()


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
            j = text.index('*/', i) + 2
            if pending is None:
                pending = i
            i = j
            continue
        start = pending if pending is not None else i
        pending = None
        brace = text.index('{', i)
        sel = text[i:brace].strip()
        depth = 0
        j = brace
        while True:
            if text[j] == '{':
                depth += 1
            elif text[j] == '}':
                depth -= 1
                if depth == 0:
                    break
            j += 1
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
    return re.split(r'\s*[\s>+~]\s*', sel.strip())[-1]


def disjoint(a, b):
    """True when the two selectors can never match the same element (heuristic, conservative)."""
    la, lb = last(a), last(b)
    ta, tb = re.match(r'^[a-z][\w-]*', la), re.match(r'^[a-z][\w-]*', lb)
    if ta and tb and ta.group(0) != tb.group(0):
        return True
    ca, cb = set(re.findall(r'\.[\w-]+', la)), set(re.findall(r'\.[\w-]+', lb))
    if ca and cb and not (ca & cb):
        return True
    na, nb = re.findall(r':nth-child\(([^)]*)\)', a), re.findall(r':nth-child\(([^)]*)\)', b)
    if na and nb and len(na) == len(nb) and na != nb and all(re.fullmatch(r'\d+', x) for x in na + nb):
        return True
    if na and nb and len(na) == len(nb):
        def fixed(x):
            return int(x) if re.fullmatch(r'\d+', x) else None
        def from_k(x):
            m = re.fullmatch(r'n\s*\+\s*(\d+)', x)
            return int(m.group(1)) if m else None
        for x, y in zip(na, nb):
            if (fixed(x) is not None and from_k(y) is not None and fixed(x) < from_k(y)) or (
                fixed(y) is not None and from_k(x) is not None and fixed(y) < from_k(x)):
                return True
    aa = dict(re.findall(r"\[([\w-]+)='([^']*)'\]", a))
    ab = dict(re.findall(r"\[([\w-]+)='([^']*)'\]", b))
    if any(k in ab and ab[k] != v for k, v in aa.items()):
        return True
    return False


def process(src, depth=0):
    items = blocks(src)
    if depth < 3:
        rebuilt = []
        cursor = 0
        for (start, end, sel, body_, sel_at) in items:
            if sel.startswith(('@media', '@supports', '@container', '@layer')):
                brace = src.index('{', sel_at)
                inner = process(src[brace + 1:end - 1], depth + 1)
                rebuilt.append(src[cursor:brace + 1] + inner + '}')
                cursor = end
        rebuilt.append(src[cursor:])
        src = ''.join(rebuilt)
        items = blocks(src)
    by_sel = {}
    for index, (start, end, sel, body, sel_at) in enumerate(items):
        if sel.startswith('@'):
            continue
        by_sel.setdefault(sel, []).append(index)

    remove = set()
    merged = {}
    warnings = []
    for sel, indexes in by_sel.items():
        if len(indexes) < 2:
            continue
        first = indexes[0]
        result = {}
        order = []
        for index in indexes:
            for prop, value in decls(items[index][3]):
                if prop not in result:
                    order.append(prop)
                result[prop] = value
        classes = set(re.findall(r'\.[\w-]+', sel))

        def conflicts(moved):
            found = []
            for between in range(first + 1, indexes[-1]):
                other = items[between]
                if between in indexes:
                    continue
                # Rules inside an @media/@supports block in between count too.
                inner = [(o[2], o[3]) for o in blocks(other[3])] if other[2].startswith('@') else [(other[2], other[3])]
                for osel, obody in inner:
                    if osel.startswith('@') or spec(osel) > spec(sel) or disjoint(sel, osel):
                        continue
                    if not (classes & set(re.findall(r'\.[\w-]+', osel))):
                        continue
                    props = {prop for prop, _ in decls(obody)} & moved
                    if props and (spec(osel) == spec(sel) or other[2].startswith('@')):
                        found.append(f'{sel}  <->  {osel}: {sorted(props)}')
            return found

        up = conflicts({prop for index in indexes[1:] for prop, _ in decls(items[index][3])})
        if not up:
            merged[first] = (sel, [(prop, result[prop]) for prop in order])
            remove.update(indexes[1:])
            continue
        last_props = {prop for prop, _ in decls(items[indexes[-1]][3])}
        down = conflicts({prop for index in indexes[:-1] for prop, _ in decls(items[index][3])} - last_props)
        if not down:
            merged[indexes[-1]] = (sel, [(prop, result[prop]) for prop in order])
            remove.update(indexes[:-1])
            continue
        warnings.extend(up + down)
        print('PULADO', sel, 'nivel', depth)

    print('nivel', depth, 'repetidas:', sum(1 for v in by_sel.values() if len(v) > 1), 'regras a remover:', len(remove))
    for w in warnings:
        print('ATENCAO', w)

    if True:
        out = []
        cursor = 0
        for index, (start, end, sel, body, sel_at) in enumerate(items):
            out.append(src[cursor:start])
            if index in remove:
                cursor = end
                # drop the blank line left behind
                while cursor < len(src) and src[cursor] == '\n' and src[cursor + 1:cursor + 2] == '\n':
                    cursor += 1
                continue
            if index in merged:
                sel_text = src[sel_at:src.index('{', sel_at)].rstrip()
                out.append(src[start:sel_at])
                lines = '\n'.join(f'  {prop}: {value};' for prop, value in merged[index][1])
                out.append(f'{sel_text} {{\n{lines}\n}}')
            else:
                out.append(src[start:end])
            cursor = end
        out.append(src[cursor:])
        return "".join(out)


result = process(src)
if '--write' in sys.argv:
    open(PATH, 'w', encoding='utf-8', newline=chr(10)).write(result)
    print('gravado')
