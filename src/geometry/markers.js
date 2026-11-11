/**
 * Marker shapes shared by the scene builder and the renderers.
 *
 * A marker's outline is needed in two places: the renderer draws it, and the
 * scene builder clips route lines against it so the line is not drawn through
 * the inside of the symbol. Both read the outline from here, so the hole in the
 * line always matches the shape actually drawn.
 */

/**
 * Vertical inset of the TC triangle's apex, as a fraction of its half-width.
 * Keeping the apex slightly above the anchor centres the triangle's visual mass
 * on the point rather than pushing the shape down the line.
 */
export const TC_APEX_INSET = 0.35;

/**
 * Outline of a TC triangle, in pixel space, as three points.
 *
 * @param {{x: number, y: number, halfWidth: number, height: number}} tc TC primitive.
 * @returns {{x: number, y: number}[]} Apex, bottom-right, bottom-left.
 */
export function tcTriangleVertices(tc) {
  const { x, y, halfWidth, height } = tc;
  const top = y + halfWidth * TC_APEX_INSET;
  return [
    { x, y: top },
    { x: x + halfWidth, y: top + height },
    { x: x - halfWidth, y: top + height },
  ];
}

/**
 * The `points` attribute for a TC triangle, as the SVG renderer needs it.
 *
 * @param {{x: number, y: number, halfWidth: number, height: number}} tc TC primitive.
 * @param {(value: number) => string} [format] Number formatter.
 * @returns {string} A `points` attribute value.
 */
export function tcTrianglePoints(tc, format = (value) => String(value)) {
  return tcTriangleVertices(tc)
    .map((point) => `${format(point.x)},${format(point.y)}`)
    .join(' ');
}

/**
 * Outline of a feeder pillar box, in pixel space, as four points.
 *
 * The box is a rectangle centred on its anchor. Its size is derived from its
 * own label, so the four corners are read from the same FPB scene primitive the
 * renderers draw: `boxX`, `boxY`, `width` and `height`. Nothing here computes a
 * size of its own, so the hole left in the line and the rectangle actually
 * drawn can never disagree.
 *
 * The vertices are returned clockwise from the top-left corner.
 *
 * @param {{boxX: number, boxY: number, width: number, height: number}} fpb FPB primitive.
 * @returns {{x: number, y: number}[]} Top-left, top-right, bottom-right, bottom-left.
 */
export function fpbRectVertices(fpb) {
  const left = fpb.boxX;
  const top = fpb.boxY;
  const right = fpb.boxX + fpb.width;
  const bottom = fpb.boxY + fpb.height;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

/**
 * Segments of a segment that lie outside a convex polygon.
 *
 * Route lines run between two node centres, so a line touching a TC triangle
 * would be drawn across the symbol. This trims each such line to the polygon's
 * boundary so the inside of the marker stays empty, while the line still
 * visually meets the symbol. A line that does not touch the polygon is
 * returned unchanged, and a line lying wholly inside it is dropped.
 *
 * @param {number} x1 Start X.
 * @param {number} y1 Start Y.
 * @param {number} x2 End X.
 * @param {number} y2 End Y.
 * @param {{x: number, y: number}[]} vertices Convex polygon, in order.
 * @returns {{x1: number, y1: number, x2: number, y2: number}[]} Visible parts.
 */
export function clipSegmentOutsidePolygon(x1, y1, x2, y2, vertices) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length === 0 || vertices.length < 3) return [{ x1, y1, x2, y2 }];

  // Parameterize the segment as P(t) = start + t * (end - start), then collect
  // every t at which it crosses a polygon edge plus the ends, and keep the
  // stretches whose midpoint lies outside the polygon.
  const cuts = [0, 1];
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const t = segmentIntersectionT(x1, y1, x2, y2, a.x, a.y, b.x, b.y);
    if (t !== null) cuts.push(t);
  }
  cuts.sort((p, q) => p - q);

  const spans = [];
  let runStart = null;
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const t0 = cuts[i];
    const t1 = cuts[i + 1];
    if (t1 - t0 < 1e-9) continue;
    const midT = (t0 + t1) / 2;
    const mx = x1 + (x2 - x1) * midT;
    const my = y1 + (y2 - y1) * midT;
    const outside = !pointInPolygon(mx, my, vertices);
    if (outside && runStart === null) {
      runStart = t0;
    } else if (!outside && runStart !== null) {
      spans.push([runStart, t0]);
      runStart = null;
    }
  }
  if (runStart !== null) spans.push([runStart, 1]);

  return spans
    .map(([t0, t1]) => ({
      x1: x1 + (x2 - x1) * t0,
      y1: y1 + (y2 - y1) * t0,
      x2: x1 + (x2 - x1) * t1,
      y2: y1 + (y2 - y1) * t1,
    }))
    .filter((part) => Math.hypot(part.x2 - part.x1, part.y2 - part.y1) > 1e-6);
}

/**
 * Parameter along AB where it crosses CD, or null when the two do not cross.
 *
 * @returns {number|null} The parameter on AB, in [0, 1].
 */
function segmentIntersectionT(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-12) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denominator;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

/**
 * Whether a point lies inside a polygon, by the even-odd rule.
 *
 * @returns {boolean} True when inside.
 */
function pointInPolygon(x, y, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const xi = vertices[i].x;
    const yi = vertices[i].y;
    const xj = vertices[j].x;
    const yj = vertices[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
