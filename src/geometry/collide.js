/**
 * Rectangle and segment overlap tests for annotation placement.
 *
 * Small, boring, and used by the layout pass for every candidate position, so it
 * has to be both cheap and exactly consistent between the preview and the exports.
 * A box is `{x1, y1, x2, y2}` with `x1 <= x2` and `y1 <= y2`; nothing here
 * normalises, because the boxes are built that way in one place.
 */

/**
 * Do two boxes overlap, allowing a margin around each?
 *
 * @param {object} a First box.
 * @param {object} b Second box.
 * @param {number} [margin] Required clear space between them, in px.
 * @returns {boolean} True when they touch or overlap.
 */
export function boxesOverlap(a, b, margin = 0) {
  if (!a || !b) return false;
  return !(
    a.x2 + margin <= b.x1 ||
    b.x2 + margin <= a.x1 ||
    a.y2 + margin <= b.y1 ||
    b.y2 + margin <= a.y1
  );
}

/**
 * Overlap area of two boxes, in square px.
 *
 * The layout pass uses the area to rank two positions that both collide: the one
 * that covers less of a symbol is the lesser evil.
 *
 * @param {object} a First box.
 * @param {object} b Second box.
 * @returns {number} Shared area, 0 when they do not overlap.
 */
export function overlapArea(a, b) {
  const width = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const height = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

/**
 * Does a line segment cross a box?
 *
 * Used so a callout does not land on top of a route it is not attached to. The
 * test is the Liang-Barsky clip: it either survives the four boundary checks or
 * it does not.
 *
 * @param {number} x1 Segment start x.
 * @param {number} y1 Segment start y.
 * @param {number} x2 Segment end x.
 * @param {number} y2 Segment end y.
 * @param {object} box Box to test.
 * @param {number} [margin] Grow the box by this much on every side.
 * @returns {boolean} True when any part of the segment is inside the box.
 */
export function segmentCrossesBox(x1, y1, x2, y2, box, margin = 0) {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;

  const left = box.x1 - margin;
  const right = box.x2 + margin;
  const top = box.y1 - margin;
  const bottom = box.y2 + margin;

  const checks = [
    [-dx, x1 - left],
    [dx, right - x1],
    [-dy, y1 - top],
    [dy, bottom - y1],
  ];

  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-12) {
      // Parallel to this edge: inside only if it starts inside.
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }

  return t0 <= t1;
}

/**
 * The box around a short line segment, widened to a stroke's width.
 *
 * A route line is not a rectangle, but an annotation must not sit on one, and a
 * stroked segment's extent is close enough to its bounding box for that purpose.
 *
 * @param {{x1: number, y1: number, x2: number, y2: number}} segment Segment.
 * @param {number} [width] Stroke width, in px.
 * @returns {object} Box.
 */
export function segmentBox(segment, width = 1) {
  const half = width / 2;
  return {
    x1: Math.min(segment.x1, segment.x2) - half,
    y1: Math.min(segment.y1, segment.y2) - half,
    x2: Math.max(segment.x1, segment.x2) + half,
    y2: Math.max(segment.y1, segment.y2) + half,
  };
}

/**
 * Expand a box by a fixed amount on every side.
 *
 * @param {object} box Box.
 * @param {number} amount Padding, in px.
 * @returns {object} Larger box.
 */
export function inflate(box, amount) {
  return {
    x1: box.x1 - amount,
    y1: box.y1 - amount,
    x2: box.x2 + amount,
    y2: box.y2 + amount,
  };
}

/**
 * Does a candidate annotation box clash with an obstacle under the clearance rule?
 *
 * @param {object} candidate Annotation box.
 * @param {object} obstacle Obstacle box.
 * @param {number} clearance Required clear space.
 * @returns {boolean} True on a clash.
 */
export function annotateCollides(candidate, obstacle, clearance) {
  return boxesOverlap(candidate, obstacle, clearance);
}
