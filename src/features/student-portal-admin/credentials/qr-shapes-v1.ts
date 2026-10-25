/** QR geometry only. No URLs, labels, logos or credentials are embedded as metadata. */
export type QrShapeV1 = {
  x: number;
  y: number;
  width: number;
  height: number;
  radii: readonly [number, number, number, number];
  dark: boolean;
};
type Matrix = { size: number; get: (row: number, column: number) => number };
/** A lone module corner is rounded only where neither neighbour on that corner is dark. */
function moduleRadiiV1(
  up: boolean,
  right: boolean,
  down: boolean,
  left: boolean,
): QrShapeV1['radii'] {
  return [
    !up && !left ? 0.42 : 0,
    !up && !right ? 0.42 : 0,
    !down && !right ? 0.42 : 0,
    !down && !left ? 0.42 : 0,
  ];
}
/** The three 7x7 finder patterns are drawn as nested squares, not as modules. */
function inFinderV1(finders: readonly (readonly [number, number])[], x: number, y: number) {
  return finders.some(([left, top]) => x >= left && x < left + 7 && y >= top && y < top + 7);
}
export function qrShapesV1(matrix: Matrix, quiet = 4): QrShapeV1[] {
  const shapes: QrShapeV1[] = [];
  const finders = [
    [0, 0],
    [matrix.size - 7, 0],
    [0, matrix.size - 7],
  ] as const;
  const dark = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < matrix.size && y < matrix.size && Boolean(matrix.get(y, x));
  for (let y = 0; y < matrix.size; y++)
    for (let x = 0; x < matrix.size; x++) {
      if (!dark(x, y) || inFinderV1(finders, x, y)) continue;
      shapes.push({
        x: x + quiet,
        y: y + quiet,
        width: 1,
        height: 1,
        radii: moduleRadiiV1(dark(x, y - 1), dark(x + 1, y), dark(x, y + 1), dark(x - 1, y)),
        dark: true,
      });
    }
  for (const [x, y] of finders) {
    shapes.push(
      { x: x + quiet, y: y + quiet, width: 7, height: 7, radii: [1, 1, 1, 1], dark: true },
      {
        x: x + quiet + 1,
        y: y + quiet + 1,
        width: 5,
        height: 5,
        radii: [0.65, 0.65, 0.65, 0.65],
        dark: false,
      },
      {
        x: x + quiet + 2,
        y: y + quiet + 2,
        width: 3,
        height: 3,
        radii: [0.5, 0.5, 0.5, 0.5],
        dark: true,
      },
    );
  }
  return shapes;
}
export function qrShapePathV1(shape: QrShapeV1): string {
  const {
    x,
    y,
    width: w,
    height: h,
    radii: [a, b, c, d],
  } = shape;
  // Square corners need no curve; skipping them keeps PDF content streams small.
  const corner = (radius: number, curve: string) => (radius ? curve : '');
  return (
    `M${x + a} ${y}H${x + w - b}` +
    corner(b, `Q${x + w} ${y} ${x + w} ${y + b}`) +
    `V${y + h - c}` +
    corner(c, `Q${x + w} ${y + h} ${x + w - c} ${y + h}`) +
    `H${x + d}` +
    corner(d, `Q${x} ${y + h} ${x} ${y + h - d}`) +
    `V${y + a}` +
    corner(a, `Q${x} ${y} ${x + a} ${y}`) +
    'Z'
  );
}
export function paintQrShapeV1(
  context: CanvasRenderingContext2D,
  shape: QrShapeV1,
  scale: number,
): void {
  const x = shape.x * scale,
    y = shape.y * scale,
    w = shape.width * scale,
    h = shape.height * scale;
  const [a, b, c, d] = shape.radii.map((radius) => radius * scale) as [
    number,
    number,
    number,
    number,
  ];
  context.beginPath();
  context.moveTo(x + a, y);
  context.lineTo(x + w - b, y);
  context.quadraticCurveTo(x + w, y, x + w, y + b);
  context.lineTo(x + w, y + h - c);
  context.quadraticCurveTo(x + w, y + h, x + w - c, y + h);
  context.lineTo(x + d, y + h);
  context.quadraticCurveTo(x, y + h, x, y + h - d);
  context.lineTo(x, y + a);
  context.quadraticCurveTo(x, y, x + a, y);
  context.closePath();
  context.fillStyle = shape.dark ? '#000000' : '#ffffff';
  context.fill();
}

/** Dark single modules touching in a row become one shape: their shared corners are square, so
 * the outline is unchanged while PDF path operators drop by more than half.
 */
function mergedRowsV1(shapes: QrShapeV1[]): QrShapeV1[] {
  const merged: QrShapeV1[] = [];
  for (const shape of shapes) {
    const prior = merged.at(-1);
    if (
      prior?.dark &&
      shape.dark &&
      prior.height === 1 &&
      shape.height === 1 &&
      shape.width === 1 &&
      prior.y === shape.y &&
      prior.x + prior.width === shape.x &&
      prior.radii[1] === 0 &&
      prior.radii[2] === 0 &&
      shape.radii[0] === 0 &&
      shape.radii[3] === 0
    )
      merged[merged.length - 1] = {
        ...prior,
        width: prior.width + 1,
        radii: [prior.radii[0], shape.radii[1], shape.radii[2], prior.radii[3]],
      };
    else merged.push(shape);
  }
  return merged;
}
export function qrLayerPathsV1(matrix: Matrix, quiet = 4): { path: string; dark: boolean }[] {
  const groups: { parts: string[]; dark: boolean }[] = [];
  for (const shape of mergedRowsV1(qrShapesV1(matrix, quiet))) {
    const prior = groups.at(-1);
    if (prior?.dark === shape.dark) prior.parts.push(qrShapePathV1(shape));
    else groups.push({ dark: shape.dark, parts: [qrShapePathV1(shape)] });
  }
  return groups.map(({ parts, dark }) => ({ path: parts.join(''), dark }));
}
