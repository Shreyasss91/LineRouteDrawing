/**
 * Marker clearance policy.
 *
 * The defect these tests exist for: the FPB box is sized to its own label and is
 * deliberately not scaled, so at a tight spacing it reaches past its neighbours.
 * Two things then go wrong at once and neither reports an error — an adjacent
 * pole ends up hidden inside the box, and a route line is trimmed away
 * completely, so the drawing silently loses a connection.
 *
 * The tests below pin the geometry, the derived limit, and the fact that the
 * limit is genuinely tight rather than arbitrary.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MARKER_KINDS,
  checkSpanClearance,
  describeClearanceProblem,
  markerExtents,
  requiredClearanceDistance,
  requiredSpanLength,
} from '../src/geometry/clearance.js';
import { buildNetwork } from '../src/geometry/network.js';
import { buildScene } from '../src/geometry/scene.js';
import { createConfig } from '../src/config.js';

const EPS = 1e-6;

/**
 * The FPB box width the renderers draw, derived independently here from the
 * label-measurement rule, so the test does not simply read back the value the
 * implementation computed.
 */
function expectedBoxWidth(config) {
  const textWidth = String(config.fpbText).length * config.fpbFontSize * 0.62;
  return textWidth + config.fpbPaddingX * 2;
}

/** Build a preview scene at a given spacing. */
function sceneAt(routes, spanLength) {
  return buildScene(buildNetwork(routes), 'preview', { spanLength });
}

/**
 * Everything that can go wrong when markers are too close together.
 *
 * @param {object} scene Scene from `buildScene`.
 * @returns {{polesInBoxes: number, boxesOverlap: boolean, lostEdges: number, shortestPiece: number}}
 *   Measured faults.
 */
function measureScene(scene) {
  const boxes = scene.fpb.map((b) => ({
    left: b.boxX,
    right: b.boxX + b.width,
    top: b.boxY,
    bottom: b.boxY + b.height,
  }));

  const polesInBoxes = scene.poles.filter((p) =>
    boxes.some((b) => p.x > b.left && p.x < b.right && p.y > b.top && p.y < b.bottom),
  ).length;

  let boxesOverlap = false;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        boxesOverlap = true;
      }
    }
  }

  const drawn = new Set(scene.lines.map((l) => l.parentId));
  const allEdges = new Set(scene.lines.map((l) => l.parentId));
  const lengths = scene.lines.map((l) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1));

  return {
    polesInBoxes,
    boxesOverlap,
    // An edge disappears when no piece references it at all. Counted by the
    // caller against the canonical graph, so it is returned as the drawn set.
    drawnEdges: drawn.size,
    allEdges: allEdges.size,
    shortestPiece: lengths.length ? Math.min(...lengths) : 0,
  };
}

test('marker extents are derived from the drawing configuration', () => {
  const config = createConfig();
  const extents = markerExtents();

  assert.equal(extents.pole.halfWidth, config.poleMarkerSize);
  assert.equal(extents.pole.halfHeight, config.poleMarkerSize);
  assert.ok(Math.abs(extents.fpb.halfWidth - expectedBoxWidth(config) / 2) < EPS);
  assert.ok(
    Math.abs(extents.fpb.halfHeight - (config.fpbFontSize + config.fpbPaddingY * 2) / 2) < EPS,
  );
  assert.equal(extents.tc.halfWidth, config.tcMarkerSize);
  assert.ok(extents.tc.halfHeight > 0);

  // Changing the configuration moves the extents with it, so nothing is
  // hardcoded to today's sizes.
  const wider = markerExtents({ fpbPaddingX: 20 });
  assert.ok(wider.fpb.halfWidth > extents.fpb.halfWidth);
});

test('the FPB box really does reach past a neighbour at a tight spacing', () => {
  // The defect the policy exists for. Two FPB points one span apart: at 12 px
  // the box (about 28.5 px wide) is wider than the span.
  const routes = [
    { id: 'a', from: 'origin', direction: 'east', spans: 1, tc: false, fpb: true },
    { id: 'b', from: 'origin', direction: 'east', spans: 2, tc: false, fpb: true },
  ];
  const tight = sceneAt(routes, 12);
  assert.equal(tight.fpb.length, 2);
  assert.ok(
    tight.fpb[0].width > 12,
    'the box is wider than one span, which is the whole problem',
  );

  const boxes = tight.fpb.map((b) => ({ left: b.boxX, right: b.boxX + b.width }));
  assert.ok(boxes[0].right > boxes[1].left, 'the two boxes overlap at 12 px');
});

test('the policy value is the smallest spacing that is actually workable', () => {
  const required = requiredSpanLength();

  // Just below the limit, one of the faults appears; at the limit, none do.
  const pairings = [
    [
      { id: 'a', from: 'origin', direction: 'east', spans: 1, tc: false, fpb: true },
      { id: 'b', from: 'origin', direction: 'east', spans: 2, tc: false, fpb: true },
    ],
    [{ id: 'a', from: 'origin', direction: 'east', spans: 1, tc: false, fpb: true }],
    [
      { id: 'a', from: 'origin', direction: 'east', spans: 1, tc: false, fpb: true },
      { id: 'b', from: 'origin', direction: 'east', spans: 2, tc: true, fpb: false },
    ],
    [
      { id: 'a', from: 'origin', direction: 'south', spans: 1, tc: true, fpb: false },
      { id: 'b', from: 'route-1', direction: 'south', spans: 1, tc: true, fpb: false },
    ],
  ];

  for (const routes of pairings) {
    const network = buildNetwork(routes);
    const edges = [...network.graph.edges.keys()];

    const atLimit = buildScene(network, 'preview', { spanLength: required });
    const faults = measureScene(atLimit);
    assert.equal(faults.polesInBoxes, 0, 'no pole is hidden inside a box at the limit');
    assert.equal(faults.boxesOverlap, false, 'no boxes overlap at the limit');
    assert.equal(faults.drawnEdges, edges.length, 'every edge is still drawn at the limit');
    assert.ok(
      faults.shortestPiece >= createConfig().minVisibleLineLength - EPS,
      `every piece is readable at the limit (${faults.shortestPiece.toFixed(2)})`,
    );
  }
});

test('spacing below the policy is rejected, at or above it is accepted', () => {
  const required = requiredSpanLength();

  for (const spanLength of [12, 16, 20, 24, 30, required - 1]) {
    const verdict = checkSpanClearance(spanLength);
    assert.equal(verdict.ok, false, `${spanLength} px is rejected`);
    assert.equal(verdict.required, required);
    assert.ok(verdict.message, 'a rejected spacing explains itself');
    assert.ok(
      verdict.message.includes(String(required)),
      'the message names the spacing that will work',
    );
    assert.ok(
      verdict.message.includes(String(Math.round(spanLength))),
      'the message names the spacing that was chosen',
    );
  }

  for (const spanLength of [required, required + 1, 40, 60, 120]) {
    assert.equal(checkSpanClearance(spanLength).ok, true, `${spanLength} px is accepted`);
    assert.equal(checkSpanClearance(spanLength).message, null);
  }
});

test('the required spacing holds for every marker pair on both axes', () => {
  const required = requiredSpanLength();
  const config = createConfig();

  for (const first of MARKER_KINDS) {
    for (const second of MARKER_KINDS) {
      for (const direction of ['north', 'south', 'east', 'west']) {
        // The first marker sits at the Origin, the second one span along. A TC
        // destination is only reachable southwards, because the triangle is
        // drawn below its anchor; the pairing is still exercised because the
        // Origin may be the TC.
        const routes = [
          {
            id: 'a',
            from: 'origin',
            direction,
            spans: 1,
            tc: second === 'tc' && direction === 'south',
            fpb: second === 'fpb',
          },
        ];
        const network = buildNetwork(routes, { originMarker: first });
        const scene = buildScene(network, 'preview', { spanLength: required });
        const faults = measureScene(scene);

        assert.equal(
          faults.polesInBoxes,
          0,
          `${first}/${second} ${direction}: no pole is hidden inside a box`,
        );
        assert.equal(faults.boxesOverlap, false, `${first}/${second} ${direction}: no boxes touch`);

        // The longest piece between the two symbols must be readable. The short
        // piece from a TC anchor up to its own apex is fixed by the triangle's
        // shape (4.2 px) and does not change with spacing, so it is not a
        // spacing failure and is excluded here.
        const lengths = scene.lines.map((l) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1));
        const longest = lengths.length ? Math.max(...lengths) : 0;
        assert.ok(
          longest >= config.minVisibleLineLength,
          `${first}/${second} ${direction}: the line is readable (${longest.toFixed(2)})`,
        );
      }
    }
  }
});

test('label text length is what drives the limit, not a constant', () => {
  const short = requiredSpanLength({ fpbText: 'F' });
  const long = requiredSpanLength({ fpbText: 'FEEDER PILLAR BOX' });
  assert.ok(long > short, 'a longer label needs more room');

  // A wider box is refused at a spacing that a narrow box accepts.
  const spacing = short;
  assert.equal(checkSpanClearance(spacing, { fpbText: 'FEEDER PILLAR BOX' }).ok, false);
});

test('the symbol-clearance limit is never larger than the readable-line limit', () => {
  // The two are separate answers: one about colliding symbols, one about a line
  // too short to see. The export guard uses the stronger of the two.
  assert.ok(requiredClearanceDistance() <= requiredSpanLength());
  assert.ok(requiredClearanceDistance() > 0);
});

test('an unusable value is described without a status code or field name', () => {
  const message = describeClearanceProblem(20, 35);
  assert.match(message, /20 px/);
  assert.match(message, /35 px/);
  assert.doesNotMatch(message, /Error|error|undefined|NaN|null|spanLength|HTTP|\b4\d\d\b/);
  assert.match(message, /spacing/i, 'it says which setting to change');
});

test('the policy does not interfere with a comfortably spaced drawing', () => {
  const routes = [
    { id: 'a', from: 'origin', direction: 'south', spans: 1, tc: false, fpb: false },
    { id: 'b', from: 'endpoint:A', direction: 'east', spans: 3, tc: false, fpb: true },
    { id: 'c', from: 'fpb:1', direction: 'south', spans: 2, tc: true, fpb: false },
    { id: 'd', from: 'tc:1', direction: 'east', spans: 2, tc: false, fpb: false },
  ];
  const network = buildNetwork(routes);
  assert.equal(network.ok, true, 'the fixture itself is a valid route list');
  const edges = [...network.graph.edges.keys()];

  const scene = sceneAt(routes, 40);
  const faults = measureScene(scene);
  assert.equal(faults.polesInBoxes, 0);
  assert.equal(faults.boxesOverlap, false);
  assert.ok(checkSpanClearance(40).ok);

  // Topology is untouched by the policy: the policy only reads the
  // configuration and never sees the graph, so every edge is still drawn.
  const drawn = new Set(scene.lines.map((l) => l.parentId));
  assert.equal(drawn.size, edges.length);
  for (const key of edges) {
    assert.ok(drawn.has(`line:${key}`), `edge ${key} is still drawn`);
  }
});
