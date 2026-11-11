/**
 * Marker clearance policy.
 *
 * A symbol is drawn at a node and route lines are trimmed against it. If the
 * spacing between nodes is smaller than the symbols need, the drawing breaks in
 * ways that are silent: a pole ends up hidden inside an FPB box, two boxes
 * overlap, and a trimmed line vanishes so the route loses a connection without
 * any error being reported.
 *
 * The requirement is derived from the drawing configuration and the same marker
 * primitives the renderers consume, never from a second set of sizes. One
 * function answers "is this spacing workable", so the preview, the exporters
 * and the UI cannot disagree.
 *
 * Two facts about the existing drawing keep the rule small:
 *
 *   - The TC triangle is already scaled to fit inside one span (see
 *     `tcMaxSpanFraction` in `src/config.js`), so it never reaches a neighbour.
 *   - The FPB box is deliberately *not* scaled: it is sized to its own label,
 *     because shrinking it would make the text overflow the rectangle. It is
 *     therefore the only marker that can exceed the available space.
 *
 * The policy still evaluates every marker pair rather than assuming this, so a
 * future change to a marker's size cannot quietly reintroduce the defect.
 *
 * This module performs no I/O and holds no state: every input is an argument and
 * every decision leaves as a return value.
 */

import { createConfig } from '../config.js';

/**
 * Kinds of marker a scene can draw at a node.
 *
 * @type {readonly ['pole', 'tc', 'fpb']}
 */
export const MARKER_KINDS = Object.freeze(['pole', 'tc', 'fpb']);

/**
 * Reach of every marker kind from its node's centre, along each axis.
 *
 * The reach is the furthest a marker draws from its anchor, so a marker never
 * extends beyond it. A TC triangle hangs below its anchor, so its two halves
 * differ; the larger reach is used, which is the conservative choice and is
 * also what the renderer produces once `tcScale` is applied.
 *
 * @param {object} [configOverrides] Drawing configuration overrides.
 * @returns {Record<string, {halfWidth: number, halfHeight: number}>} Per-kind reach.
 */
export function markerExtents(configOverrides = {}) {
  const config = createConfig(configOverrides);

  // The pole is a crossing whose arms reach poleMarkerSize in every direction.
  const pole = { halfWidth: config.poleMarkerSize, halfHeight: config.poleMarkerSize };

  // The TC triangle hangs below its anchor: its apex sits a little above the
  // anchor and its body extends `height` below that apex. Its two vertical
  // reaches are therefore very different, and a neighbour below the triangle is
  // pushed much further away than a neighbour above it. Collapsing them into one
  // number would understate the room a triangle needs from the node below it.
  const apexInset = config.tcMarkerSize * 0.35;
  const tc = {
    halfWidth: config.tcMarkerSize,
    // Kept for callers that only need the largest extent in any direction.
    halfHeight: Math.max(apexInset, apexInset + config.tcMarkerHeight),
    up: apexInset,
    down: apexInset + config.tcMarkerHeight,
  };

  // The FPB box is centred on its anchor and sized from its own label, using the
  // same measurement the scene builder uses when it places the rectangle.
  const textWidth = String(config.fpbText).length * config.fpbFontSize * 0.62;
  const fpb = {
    halfWidth: (textWidth + config.fpbPaddingX * 2) / 2,
    halfHeight: (config.fpbFontSize + config.fpbPaddingY * 2) / 2,
  };

  // The pole and the box are symmetric about their anchor, so their two
  // vertical reaches are equal.
  pole.up = pole.halfHeight;
  pole.down = pole.halfHeight;
  fpb.up = fpb.halfHeight;
  fpb.down = fpb.halfHeight;

  return { pole, tc, fpb };
}

/**
 * Distance two markers of the given kinds must keep between their centres,
 * measured along one axis.
 *
 * Two markers touch when that distance is no more than the sum of their reaches.
 * Adding the clearance policy gives the distance they must keep.
 *
 * @param {'pole'|'tc'|'fpb'} a Kind of the first marker.
 * @param {'pole'|'tc'|'fpb'} b Kind of the second marker.
 * @param {'x'|'y'} axis Axis being measured.
 * @param {object} extents Result of `markerExtents`.
 * @param {number} clearance Minimum empty space between the symbols.
 * @returns {number} The smallest workable centre-to-centre distance.
 */
export function requiredDistanceBetween(a, b, axis, extents, clearance) {
  const reach = (kind) => (axis === 'x' ? extents[kind].halfWidth : extents[kind].halfHeight);
  return reach(a) + reach(b) + clearance;
}

/**
 * The smallest span length at which every pair of markers clears a neighbour of
 * every other kind, and the route line between them is still readable.
 *
 * A span has to hold three things: the reach of one marker, a piece of visible
 * route line, and the reach of the neighbour. Those three must fit exactly, so
 * the requirement is `reachA + minVisibleLineLength + reachB`. The clearance
 * policy is not added separately: a minimum visible line already implies it, and
 * adding both would reject spacing that is in fact fine. The clearance is still
 * checked on its own, for drawings whose lines are long but whose symbols sit
 * close, which is what `requiredClearanceDistance` answers.
 *
 * A route may run north, south, east or west, so a neighbour can lie on either
 * axis and the larger of the two requirements is the one that must hold.
 *
 * @param {object} [configOverrides] Drawing configuration overrides.
 * @returns {number} Smallest workable span length in px.
 */
export function requiredSpanLength(configOverrides = {}) {
  const config = createConfig(configOverrides);
  const extents = markerExtents(configOverrides);

  let required = 0;
  for (const a of MARKER_KINDS) {
    for (const b of MARKER_KINDS) {
      // Horizontal: both markers are symmetric left and right.
      const horizontal =
        extents[a].halfWidth + extents[b].halfWidth + config.minVisibleLineLength;
      // Vertical: `a` is the marker above, so it reaches down with its lower
      // extent, and `b` is below, so it reaches up with its upper extent.
      const vertical = extents[a].down + extents[b].up + config.minVisibleLineLength;
      required = Math.max(required, horizontal, vertical);
    }
  }

  // A whole number of pixels is easier to act on and to type into the field.
  return Math.ceil(required);
}

/**
 * The smallest span length at which no two markers can overlap, ignoring how
 * long the visible line is.
 *
 * This is the weaker of the two limits and exists so a caller can distinguish
 * "the symbols collide" from "the line between them is too short to see". The
 * export guard uses the stronger `requiredSpanLength`.
 *
 * @param {object} [configOverrides] Drawing configuration overrides.
 * @returns {number} Smallest spacing at which symbols keep their clearance.
 */
export function requiredClearanceDistance(configOverrides = {}) {
  const config = createConfig(configOverrides);
  const extents = markerExtents(configOverrides);

  let required = 0;
  for (const a of MARKER_KINDS) {
    for (const b of MARKER_KINDS) {
      required = Math.max(
        required,
        extents[a].halfWidth + extents[b].halfWidth + config.markerClearance,
        extents[a].down + extents[b].up + config.markerClearance,
      );
    }
  }
  return Math.ceil(required);
}

/**
 * Check a span length against the clearance policy.
 *
 * @param {number} spanLength Spacing in px.
 * @param {object} [configOverrides] Drawing configuration overrides.
 * @returns {{ok: boolean, spanLength: number, required: number, message: string|null}}
 *   Verdict, with a trader-readable message when the spacing is too tight.
 */
export function checkSpanClearance(spanLength, configOverrides = {}) {
  const required = requiredSpanLength(configOverrides);
  const ok = Number.isFinite(spanLength) && spanLength >= required;
  return {
    ok,
    spanLength,
    required,
    message: ok ? null : describeClearanceProblem(spanLength, required),
  };
}

/**
 * Explain a spacing problem in terms the operator can act on.
 *
 * No status code, no field name and no internal identifier: the person reading
 * this needs to know what is wrong and which value to choose.
 *
 * @param {number} spanLength The rejected spacing.
 * @param {number} required The smallest allowed spacing.
 * @returns {string} A sentence naming the cause and the next action.
 */
export function describeClearanceProblem(spanLength, required) {
  const shown = Number.isFinite(spanLength) ? Math.round(spanLength) : 0;
  return (
    `A spacing of ${shown} px is too tight. The point symbols would overlap and ` +
    `the route lines between them would disappear. ` +
    `Set the spacing to ${required} px or more.`
  );
}
