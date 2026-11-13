/**
 * Annotation layout: where a load callout and a span length label are drawn.
 *
 * This is the only place that decides annotation positions. The SVG, PDF and
 * print renderers each draw what the scene tells them, so a callout points at the
 * same pole and reads the same text in all three, and no renderer can drift from
 * the others.
 *
 * The algorithm, per annotation:
 *
 *   1. Work out the annotation's own size from its text.
 *   2. Try a ranked list of candidate positions around its node (or beside its
 *      span's midpoint), nearest and most conventional first.
 *   3. Take the first candidate that hits nothing: no marker, no line, no other
 *      annotation, no label, and inside the drawing's bounds.
 *   4. If every candidate collides, keep the one with the least overlap rather
 *      than giving up. An annotation in a slightly awkward place is readable; an
 *      annotation that disappeared is a number nobody can check.
 *
 * A manual offset from the user wins over all of this: it is applied to the
 * chosen candidate, so dragging a callout is remembered as a nudge from the
 * automatic place rather than as an absolute position that a later edit could
 * leave stranded.
 *
 * Everything here is pure: no DOM, no renderer, no clock.
 *
 * Where the collision question is answered changed with finding F13: instead of walking
 * every obstacle for every candidate, the caller hands in a per-scene index
 * ([spatial_index.js](./spatial_index.js)) and this module asks it. The rule is untouched -
 * the index only narrows the candidates, and `annotateCollides` still decides each one.
 */

import { collisionCounter } from './spatial_index.js';

/** Half the width of the leader arrow's approach at the node, in px. */
const NODE_APPROACH = 1;

/**
 * Candidate callout positions for a load group, in preference order.
 *
 * A callout is placed by its node-relative direction. East and west come before
 * north and south because a route drawing is usually wider than it is tall, so a
 * side placement has more room, and right before left because a leader leaving to
 * the right reads more naturally.
 *
 * @param {object} node Node asset with a pixel position.
 * @param {{width: number, height: number}} size Callout text block size.
 * @param {object} config Drawing configuration.
 * @returns {Array<{side: string, dx: number, dy: number}>} Ordered placements.
 */
export function loadCandidates(node, size, config) {
  const reach = config.annotOffset;
  const halfW = size.width / 2;
  const halfH = size.height / 2;

  // The offsets place the callout's centre relative to the node. Each side's
  // offset accounts for its own half extent, so the near edge sits `reach` away
  // from the pole whatever the text's size.
  return [
    { side: 'right', dx: reach + halfW, dy: 0 },
    { side: 'left', dx: -(reach + halfW), dy: 0 },
    { side: 'above', dx: 0, dy: -(reach + halfH) },
    { side: 'below', dx: 0, dy: reach + halfH },
    { side: 'right-above', dx: reach + halfW, dy: -(reach + halfH) },
    { side: 'right-below', dx: reach + halfW, dy: reach + halfH },
    { side: 'left-above', dx: -(reach + halfW), dy: -(reach + halfH) },
    { side: 'left-below', dx: -(reach + halfW), dy: reach + halfH },
    // A second ring, for a dense junction where the first eight all collide.
    { side: 'far-right', dx: reach + halfW + config.spanLength, dy: 0 },
    { side: 'far-left', dx: -(reach + halfW + config.spanLength), dy: 0 },
    { side: 'far-above', dx: 0, dy: -(reach + halfH + config.spanLength) },
    { side: 'far-below', dx: 0, dy: reach + halfH + config.spanLength },
  ];
}

/**
 * The rectangular box a callout occupies, given a centre.
 *
 * @param {{x: number, y: number}} center Callout centre.
 * @param {{width: number, height: number}} size Callout size.
 * @returns {{x1: number, y1: number, x2: number, y2: number}} Box.
 */
export function boxAround(center, size) {
  return {
    x1: center.x - size.width / 2,
    y1: center.y - size.height / 2,
    x2: center.x + size.width / 2,
    y2: center.y + size.height / 2,
  };
}

/**
 * Build the leader line from a node to a callout, ending at the callout's edge.
 *
 * The line stops at the near edge of the callout box rather than its centre, so it
 * touches the text block instead of running underneath it. The arrow sits at the
 * node end, where it points at the pole.
 *
 * @param {{x: number, y: number}} node Node pixel position.
 * @param {{x: number, y: number}} center Callout centre.
 * @param {{width: number, height: number}} size Callout size.
 * @param {object} config Drawing configuration.
 * @returns {{x1: number, y1: number, x2: number, y2: number, tipX: number, tipY: number,
 *   angle: number}} Leader geometry, running node to callout.
 */
export function buildLeader(node, center, size, config) {
  const box = boxAround(center, size);
  // Clip the node-to-centre segment to the box's boundary, so the visible leader
  // is the part outside the text block.
  const dx = center.x - node.x;
  const dy = center.y - node.y;
  let t = 1;
  if (Math.abs(dx) > 1e-9) {
    const limitX = Math.abs(dx) > 1e-9 ? (size.width / 2) / Math.abs(dx) : Infinity;
    t = Math.min(t, limitX);
  }
  if (Math.abs(dy) > 1e-9) {
    const limitY = (size.height / 2) / Math.abs(dy);
    t = Math.min(t, limitY);
  }
  t = Math.max(0, Math.min(1, t));

  const stopX = center.x - dx * t;
  const stopY = center.y - dy * t;

  // The arrow tip points at the node, so the direction is measured from the
  // callout towards the pole.
  const angle = Math.atan2(node.y - stopY, node.x - stopX);

  return {
    x1: stopX,
    y1: stopY,
    x2: node.x,
    y2: node.y,
    tipX: node.x,
    tipY: node.y,
    angle,
    box,
    offset: { dx: dx * t, dy: dy * t },
  };
}

/**
 * The arrowhead polygon for a leader ending at a node.
 *
 * The tip sits a short distance off the node's centre so the arrow touches the
 * pole symbol rather than burying itself in it, and the two barbs trail back along
 * the leader.
 *
 * @param {{x1: number, y1: number, x2: number, y2: number}} leader Leader geometry.
 * @param {object} config Drawing configuration.
 * @returns {{points: Array<{x: number, y: number}>, tipX: number, tipY: number}}
 */
export function arrowHead(leader, config) {
  const size = config.annotArrowSize;
  const angle = leader.angle;
  const tipX = leader.tipX;
  const tipY = leader.tipY;
  const back = angle + Math.PI;

  return {
    tipX,
    tipY,
    points: [
      { x: tipX, y: tipY },
      { x: tipX + Math.cos(back - 0.42) * size, y: tipY + Math.sin(back - 0.42) * size },
      { x: tipX + Math.cos(back + 0.42) * size, y: tipY + Math.sin(back + 0.42) * size },
    ],
  };
}

/**
 * Candidate positions for a span length label, in preference order.
 *
 * The label sits just off its span's midpoint on the side that does not touch the
 * line, and the side depends on the span's orientation: above or below a
 * horizontal span, left or right of a vertical one. Above and left come first,
 * which is where a draughtsman would put them.
 *
 * @param {{x1: number, y1: number, x2: number, y2: number}} span Span endpoints in pixels.
 * @param {{width: number, height: number}} size Label size.
 * @param {object} config Drawing configuration.
 * @returns {Array<{side: string, dx: number, dy: number}>} Ordered placements relative
 *   to the span midpoint.
 */
export function spanCandidates(span, size, config) {
  const midX = (span.x1 + span.x2) / 2;
  const midY = (span.y1 + span.y2) / 2;
  const gap = config.annotSpanGap;
  const horizontal = Math.abs(span.x2 - span.x1) >= Math.abs(span.y2 - span.y1);

  const candidates = horizontal
    ? [
        { side: 'above', dx: 0, dy: -(gap + size.height / 2) },
        { side: 'below', dx: 0, dy: gap + size.height / 2 },
        { side: 'above-left', dx: -(size.width / 2 + gap), dy: -(gap + size.height / 2) },
        { side: 'above-right', dx: size.width / 2 + gap, dy: -(gap + size.height / 2) },
        { side: 'below-left', dx: -(size.width / 2 + gap), dy: gap + size.height / 2 },
        { side: 'below-right', dx: size.width / 2 + gap, dy: gap + size.height / 2 },
      ]
    : [
        { side: 'left', dx: -(gap + size.width / 2), dy: 0 },
        { side: 'right', dx: gap + size.width / 2, dy: 0 },
        { side: 'left-above', dx: -(gap + size.width / 2), dy: -(size.height / 2 + gap) },
        { side: 'left-below', dx: -(gap + size.width / 2), dy: size.height / 2 + gap },
        { side: 'right-above', dx: gap + size.width / 2, dy: -(size.height / 2 + gap) },
        { side: 'right-below', dx: gap + size.width / 2, dy: size.height / 2 + gap },
      ];

  return candidates.map((candidate) => ({ ...candidate, midX, midY }));
}

/**
 * Approximate the size of a block of text.
 *
 * @param {string[]} lines Lines of text.
 * @param {object} config Drawing configuration.
 * @param {number} fontSize Font size in px.
 * @returns {{width: number, height: number}} Block size including padding.
 */
export function measureBlock(lines, config, fontSize) {
  const widest = lines.reduce((max, line) => Math.max(max, measureLine(line, fontSize)), 0);
  const lineCount = Math.max(1, lines.length);
  const height =
    (lineCount - 1) * config.annotLineSpacing + fontSize + config.annotCalloutPaddingY * 2;
  return {
    width: widest + config.annotCalloutPaddingX * 2,
    height,
  };
}

/** Approximate width of one line for Helvetica/Arial, generous on purpose. */
export function measureLine(text, fontSize) {
  return String(text).length * fontSize * 0.6;
}

/**
 * Place one callout among its obstacles.
 *
 * @param {object} input
 * @param {{x: number, y: number}} input.node Node pixel position.
 * @param {{width: number, height: number}} input.size Callout size.
 * @param {Array<object>} input.obstacles Static obstacles: marker and line boxes.
 * @param {Array<{x1: number, y1: number, x2: number, y2: number}>} input.taken Boxes
 *   already occupied by other annotations.
 * @param {{width: number, height: number}} input.bounds Drawing bounds.
 * @param {{dx: number, dy: number}} [input.offset] Manual offset, if any.
 * @param {object} input.config Drawing configuration.
 * @returns {{center: {x: number, y: number}, side: string, collisions: number, manual: boolean}}
 */
export function placeCallout(input) {
  const { node, size, obstacles, taken, bounds, config } = input;
  const offset = input.offset ?? { dx: 0, dy: 0 };
  const manual = offset.dx !== 0 || offset.dy !== 0;
  const countCollisions = collisionCounter({
    index: input.index,
    obstacles,
    taken,
    bounds,
    clearance: config.annotClearance,
  });

  const candidates = loadCandidates(node, size, config).map((candidate) => ({
    ...candidate,
    center: { x: node.x + candidate.dx, y: node.y + candidate.dy },
  }));

  // A manual offset says where the user wants it. Honour it exactly rather than
  // searching: they moved it because the automatic place was wrong for their
  // drawing, and re-running collision avoidance would undo their decision.
  //
  // It is applied to the candidate the label was actually on, not to the first
  // candidate in the list. Using the first one made a callout that had been
  // automatically placed on its left-hand side jump across the pole the instant it
  // was touched, because the offset was measured from a position the reader had
  // never seen.
  if (manual) {
    const base = candidates[clampIndex(offset.candidateIndex, candidates.length)];
    const center = { x: base.center.x + offset.dx, y: base.center.y + offset.dy };
    return {
      center,
      side: base.side,
      candidateIndex: clampIndex(offset.candidateIndex, candidates.length),
      collisions: countCollisions(boxAround(center, size)),
      manual: true,
    };
  }

  let best = null;
  let bestIndex = 0;
  candidates.forEach((candidate, index) => {
    const collisions = countCollisions(boxAround(candidate.center, size));
    if (!best || collisions < best.collisions) {
      best = { ...candidate, collisions };
      bestIndex = index;
    }
  });
  if (best && best.collisions === 0) {
    return {
      center: best.center,
      side: best.side,
      candidateIndex: bestIndex,
      collisions: 0,
      manual: false,
    };
  }

  return {
    center: best.center,
    side: best.side,
    candidateIndex: bestIndex,
    collisions: best.collisions,
    manual: false,
  };
}

/**
 * Place a span length label among its obstacles.
 *
 * @param {object} input
 * @param {{x1: number, y1: number, x2: number, y2: number}} input.span Span in pixels.
 * @param {{width: number, height: number}} input.size Label size.
 * @param {Array<object>} input.obstacles Static obstacles.
 * @param {Array<object>} input.taken Boxes already occupied.
 * @param {{width: number, height: number}} input.bounds Drawing bounds.
 * @param {{dx: number, dy: number}} [input.offset] Manual offset, if any.
 * @param {object} input.config Drawing configuration.
 * @returns {{center: {x: number, y: number}, side: string, collisions: number, manual: boolean}}
 */
export function placeSpanLabel(input) {
  const { span, size, obstacles, taken, bounds, config } = input;
  const offset = input.offset ?? { dx: 0, dy: 0 };
  const manual = offset.dx !== 0 || offset.dy !== 0;
  const countCollisions = collisionCounter({
    index: input.index,
    obstacles,
    taken,
    bounds,
    clearance: config.annotClearance,
  });

  const candidates = spanCandidates(span, size, config).map((candidate) => ({
    ...candidate,
    center: {
      x: candidate.midX + candidate.dx,
      y: candidate.midY + candidate.dy,
    },
  }));

  // Same rule as a callout: the nudge is measured from the candidate that was
  // actually shown, so the first drag moves the label from where it was drawn.
  if (manual) {
    const index = clampIndex(offset.candidateIndex, candidates.length);
    const base = candidates[index];
    const center = { x: base.center.x + offset.dx, y: base.center.y + offset.dy };
    return {
      center,
      side: base.side,
      candidateIndex: index,
      collisions: countCollisions(boxAround(center, size)),
      manual: true,
    };
  }

  let best = null;
  let bestIndex = 0;
  candidates.forEach((candidate, index) => {
    const collisions = countCollisions(boxAround(candidate.center, size));
    if (!best || collisions < best.collisions) {
      best = { ...candidate, collisions };
      bestIndex = index;
    }
  });
  return {
    center: best.center,
    side: best.side,
    candidateIndex: bestIndex,
    collisions: best.collisions,
    manual: false,
  };
}

/**
 * Keep a stored candidate index inside the candidate list.
 *
 * A saved project may have been written when the list had a different length, so
 * an out-of-range index falls back to the first candidate rather than reading
 * `undefined` and drawing at NaN.
 */
function clampIndex(value, length) {
  if (!Number.isInteger(value) || value < 0 || value >= length) return 0;
  return value;
}



/**
 * Everything one annotation needs once it has been placed.
 *
 * @param {object} placement Result of `placeCallout` or `placeSpanLabel`.
 * @param {string} id Annotation id.
 * @param {string} kind `load` or `span`.
 * @param {string} assetId Node or span asset id it belongs to.
 * @param {string[]} lines Text lines.
 * @param {number} fontSize Font size in px.
 * @returns {object} Annotation record.
 */
export function annotation(placement, id, kind, assetId, lines, fontSize) {
  return {
    id,
    kind,
    assetId,
    lines,
    center: placement.center,
    side: placement.side,
    // Which candidate the automatic pass settled on. A drag records this alongside
    // the offset, so the nudge is measured from the position the reader saw rather
    // than from a fixed first choice.
    candidateIndex: placement.candidateIndex ?? 0,
    collisions: placement.collisions,
    manual: placement.manual,
    fontSize,
  };
}

export { NODE_APPROACH };
