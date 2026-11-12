/**
 * TC marker anchoring, orientation, and the two defects it fixes.
 *
 * A TC point is a through-point on a route: a cable arrives on one route and
 * leaves on the next. Two things therefore have to be true of the triangle that
 * marks it, and both were false before this file existed.
 *
 *   1. Both spans either side of the TC are drawn at their full configured
 *      length. The triangle is anchored on the midpoint of its downstream base,
 *      so it extends backwards over the cable that feeds it and reaches nothing
 *      into the span that leaves. A triangle that overflowed downstream stole
 *      part of the outgoing span, and the cable below the TC came out visibly
 *      shorter than the distance the poles really are apart.
 *
 *   2. No conductor is drawn inside the triangle. The arriving cable stops at the
 *      apex; the leaving cable starts at the base midpoint.
 *
 * Every assertion here is made against the scene the renderers consume, so a pass
 * means the preview, the SVG, the PDF and the print sheet all agree.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createConfig } from '../src/config.js';
import {
  DEFAULT_MARKER_DIRECTION,
  pixelDirectionVector,
  tcTriangleVertices,
} from '../src/geometry/markers.js';
import { buildNetwork } from '../src/geometry/network.js';
import { buildScene, gridToPixel } from '../src/geometry/scene.js';

const EPS = 1e-6;
const CARDINALS = ['north', 'south', 'east', 'west'];

/** A route that reaches a TC point, then continues past it in the same direction. */
function throughTc(direction, spansBefore = 3, spansAfter = 3) {
  return [
    { id: 'route-1', from: 'origin', direction, spans: spansBefore },
    { id: 'route-2', from: 'endpoint:A', direction, spans: 2, tc: true },
    { id: 'route-3', from: 'tc:1', direction, spans: spansAfter },
  ];
}

/**
 * Strict point-in-triangle, excluding the boundary.
 *
 * The boundary belongs to the symbol: a trimmed conductor is expected to meet the
 * apex and the base exactly, so only the enclosed interior must be empty.
 */
function strictlyInside(x, y, vertices, edge = 1e-4) {
  const sign = (p, q, r) => (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
  const [a, b, c] = vertices;
  const d1 = sign({ x, y }, a, b);
  const d2 = sign({ x, y }, b, c);
  const d3 = sign({ x, y }, c, a);
  const positive = d1 > edge && d2 > edge && d3 > edge;
  const negative = d1 < -edge && d2 < -edge && d3 < -edge;
  return positive || negative;
}

/** Every scene line that runs along the axis the TC triangle points on. */
function linesOnAxis(scene, anchor) {
  return scene.lines.filter(
    (line) =>
      (Math.abs(line.x1 - anchor.x) < EPS && Math.abs(line.x2 - anchor.x) < EPS) ||
      (Math.abs(line.y1 - anchor.y) < EPS && Math.abs(line.y2 - anchor.y) < EPS),
  );
}

/* ------------------------------------------------------------------------ */
/* A. Directional marker geometry                                            */
/* ------------------------------------------------------------------------ */

test('A. the triangle faces the cable that arrives, in all four directions', () => {
  const config = createConfig();

  for (const direction of CARDINALS) {
    const scene = buildScene(buildNetwork(throughTc(direction)), 'preview');
    assert.equal(scene.tc.length, 1, `${direction}: one triangle`);
    const anchor = scene.tc[0];
    const [apex, baseRight, baseLeft] = tcTriangleVertices(anchor);

    // The base midpoint is the node itself, exactly.
    const baseMid = { x: (baseRight.x + baseLeft.x) / 2, y: (baseRight.y + baseLeft.y) / 2 };
    assert.ok(Math.abs(baseMid.x - anchor.x) < EPS, `${direction}: base midpoint x is the node`);
    assert.ok(Math.abs(baseMid.y - anchor.y) < EPS, `${direction}: base midpoint y is the node`);

    // The apex sits upstream: opposite the travel direction, on the same axis.
    const travel = pixelDirectionVector(direction);
    const toApex = { x: apex.x - anchor.x, y: apex.y - anchor.y };
    assert.ok(
      toApex.x * travel.dx + toApex.y * travel.dy < 0,
      `${direction}: the apex points back along the arriving cable`,
    );
    // Exactly one full height away, on the route axis.
    assert.ok(
      Math.abs(Math.hypot(toApex.x, toApex.y) - anchor.height) < EPS,
      `${direction}: the apex is one height from the node`,
    );

    // No part of the shape reaches downstream of the node.
    const downstream = (p) => (p.x - anchor.x) * travel.dx + (p.y - anchor.y) * travel.dy;
    assert.ok(downstream(apex) <= EPS, `${direction}: the apex does not reach downstream`);
    assert.ok(
      downstream(baseRight) <= EPS && downstream(baseLeft) <= EPS,
      `${direction}: neither base corner reaches downstream`,
    );

    // The adaptive sizing policy still governs the size.
    assert.ok(
      anchor.halfWidth <= config.tcMarkerSize + EPS,
      `${direction}: the half-width is within the configured size`,
    );
    assert.ok(
      anchor.height <= config.tcMarkerHeight + EPS,
      `${direction}: the height is within the configured size`,
    );
  }
});

test('A. a point with no arriving route uses a fixed default orientation', () => {
  // The Origin can itself be declared a TC point, and no cable arrives at it.
  const network = buildNetwork([{ id: 'r1', from: 'origin', direction: 'south', spans: 2 }], {
    originMarker: 'tc',
  });
  const scene = buildScene(network, 'preview');
  assert.equal(scene.tc.length, 1, 'the Origin is drawn as a triangle');
  const anchor = scene.tc[0];
  assert.equal(anchor.direction, DEFAULT_MARKER_DIRECTION, 'the default is used');

  const [apex] = tcTriangleVertices(anchor);
  const travel = pixelDirectionVector(DEFAULT_MARKER_DIRECTION);
  const toApex = { x: apex.x - anchor.x, y: apex.y - anchor.y };
  assert.ok(
    toApex.x * travel.dx + toApex.y * travel.dy < 0,
    'the default apex points back along the default direction',
  );
});

/* ------------------------------------------------------------------------ */
/* B. Downstream span length                                                 */
/* ------------------------------------------------------------------------ */

test('B. the span leaving a TC keeps its whole configured length', () => {
  for (const direction of CARDINALS) {
    for (const spacing of [12, 20, 40, 60]) {
      const network = buildNetwork(throughTc(direction));
      assert.ok(network.ok, `${direction}/${spacing}: the network builds`);
      const scene = buildScene(network, 'preview', { spanLength: spacing });
      const anchor = scene.tc[0];
      const travel = pixelDirectionVector(direction);

      // The first ordinary pole after the TC, along the direction of travel.
      const expected = {
        x: anchor.x + travel.dx * spacing,
        y: anchor.y + travel.dy * spacing,
      };
      const pole = scene.poles.find(
        (p) => Math.abs(p.x - expected.x) < EPS && Math.abs(p.y - expected.y) < EPS,
      );
      assert.ok(pole, `${direction}/${spacing}: the next pole is one span from the node`);

      // Base midpoint to that pole is exactly one configured span.
      const [apex, baseRight, baseLeft] = tcTriangleVertices(anchor);
      const baseMid = { x: (baseRight.x + baseLeft.x) / 2, y: (baseRight.y + baseLeft.y) / 2 };
      const measured = Math.hypot(pole.x - baseMid.x, pole.y - baseMid.y);
      assert.ok(
        Math.abs(measured - spacing) < EPS,
        `${direction}/${spacing}: the leaving span measures ${measured.toFixed(3)}, not ${spacing}`,
      );

      // And the conductor leaving the base is that same whole length, with no
      // piece of it eaten by the triangle.
      const leaving = linesOnAxis(scene, anchor).find(
        (line) =>
          (line.x1 - anchor.x) * travel.dx + (line.y1 - anchor.y) * travel.dy >= -EPS &&
          Math.hypot(line.x1 - anchor.x, line.y1 - anchor.y) < 1e-3 &&
          Math.hypot(line.x2 - anchor.x, line.y2 - anchor.y) > 1e-3,
      );
      assert.ok(leaving, `${direction}/${spacing}: a conductor leaves the base midpoint`);
      assert.ok(
        Math.abs(leaving.y1 - anchor.y) < EPS && Math.abs(leaving.x1 - anchor.x) < EPS,
        `${direction}/${spacing}: the leaving conductor starts exactly on the node`,
      );
      const leavingLength = Math.hypot(leaving.x2 - leaving.x1, leaving.y2 - leaving.y1);
      assert.ok(
        Math.abs(leavingLength - spacing) < EPS,
        `${direction}/${spacing}: the leaving conductor is ${leavingLength.toFixed(3)} px, ` +
          `not the full ${spacing} px`,
      );
    }
  }
});

test('B. anchoring the triangle moved no coordinate and no span identity', () => {
  // The same routes, read as a graph, must be identical whether or not the TC
  // triangle exists. Anchoring is a drawing decision and may not touch topology.
  const withTc = buildNetwork(throughTc('south'));
  const withoutTc = buildNetwork([
    { id: 'route-1', from: 'origin', direction: 'south', spans: 3 },
    { id: 'route-2', from: 'endpoint:A', direction: 'south', spans: 2 },
    { id: 'route-3', from: 'endpoint:B', direction: 'south', spans: 3 },
  ]);

  const keys = (network) => [...network.graph.nodes.keys()].sort();
  const edges = (network) => [...network.graph.edges.keys()].sort();
  assert.deepEqual(keys(withTc), keys(withoutTc), 'every node keeps its coordinate');
  assert.deepEqual(edges(withTc), edges(withoutTc), 'every edge keeps its identity');
});

test('B. the measured span length is untouched by the marker geometry', () => {
  // A length is recorded against a physical span, keyed by its asset id. The
  // marker's position may not change that id, the key, or the value.
  const base = buildNetwork(throughTc('south'));
  const probed = buildScene(base, 'preview', {}, {});
  const leaving = probed.annotations.spans.find(
    (span) => span.a.kind === 'node' && span.b.nodeType === 'tc',
  );
  assert.ok(leaving, 'the span arriving at the TC was found');

  const measured = new Map([[leaving.assetId, 28.5]]);
  const scene = buildScene(base, 'preview', {}, { spanLengths: measured });
  const same = scene.annotations.spans.find((span) => span.assetId === leaving.assetId);
  assert.ok(same, 'the same span is still there, under the same id');
  assert.equal(same.measured, true, 'it reads as measured');
  assert.ok(
    same.lines.join(' ').includes('28.5'),
    'the recorded metres are what is drawn, not a value derived from the marker',
  );
});

/* ------------------------------------------------------------------------ */
/* C. Empty triangle interior                                                */
/* ------------------------------------------------------------------------ */

test('C. no conductor is drawn inside the triangle', () => {
  for (const direction of CARDINALS) {
    for (const spacing of [12, 20, 40, 60]) {
      const scene = buildScene(buildNetwork(throughTc(direction)), 'preview', {
        spanLength: spacing,
      });
      const anchor = scene.tc[0];
      const vertices = tcTriangleVertices(anchor);

      for (const line of scene.lines) {
        for (let step = 0; step <= 200; step += 1) {
          const t = step / 200;
          const x = line.x1 + (line.x2 - line.x1) * t;
          const y = line.y1 + (line.y2 - line.y1) * t;
          assert.ok(
            !strictlyInside(x, y, vertices),
            `${direction}/${spacing}: ${line.id} runs inside the triangle at ` +
              `(${x.toFixed(2)}, ${y.toFixed(2)})`,
          );
        }
      }
    }
  }
});

test('C. the arriving conductor stops at the apex and leaves no gap', () => {
  for (const direction of CARDINALS) {
    const scene = buildScene(buildNetwork(throughTc(direction)), 'preview');
    const anchor = scene.tc[0];
    const apex = tcTriangleVertices(anchor)[0];

    const reachingApex = scene.lines.filter(
      (line) =>
        (Math.abs(line.x1 - apex.x) < 1e-3 && Math.abs(line.y1 - apex.y) < 1e-3) ||
        (Math.abs(line.x2 - apex.x) < 1e-3 && Math.abs(line.y2 - apex.y) < 1e-3),
    );
    assert.equal(reachingApex.length, 1, `${direction}: exactly one conductor meets the apex`);
  }
});

/* ------------------------------------------------------------------------ */
/* D. Multiple incident routes                                               */
/* ------------------------------------------------------------------------ */

test('D. a branch leaving the TC sideways is clipped and stays connected', () => {
  const routes = [
    { id: 'route-1', from: 'origin', direction: 'south', spans: 3 },
    { id: 'route-2', from: 'endpoint:A', direction: 'south', spans: 2, tc: true },
    // Continues straight on past the TC.
    { id: 'route-3', from: 'tc:1', direction: 'south', spans: 2 },
    // Turns off at the TC, so the TC has three incident edges.
    { id: 'route-4', from: 'tc:1', direction: 'east', spans: 3 },
  ];
  const network = buildNetwork(routes);
  const scene = buildScene(network, 'preview');
  const anchor = scene.tc[0];
  const vertices = tcTriangleVertices(anchor);

  // No conductor, from any branch, enters the triangle.
  for (const line of scene.lines) {
    for (let step = 0; step <= 100; step += 1) {
      const t = step / 100;
      const x = line.x1 + (line.x2 - line.x1) * t;
      const y = line.y1 + (line.y2 - line.y1) * t;
      assert.ok(!strictlyInside(x, y, vertices), `${line.id} crosses the triangle`);
    }
  }

  // The perpendicular branch starts on the base midpoint and runs clear of the
  // shape, so the junction still reads as connected.
  const perpendicular = scene.lines.find(
    (line) =>
      Math.abs(line.y1 - anchor.y) < EPS &&
      Math.abs(line.y2 - anchor.y) < EPS &&
      Math.hypot(line.x1 - anchor.x, line.y1 - anchor.y) < 1e-3 &&
      Math.hypot(line.x2 - anchor.x, line.y2 - anchor.y) > 1e-3,
  );
  assert.ok(perpendicular, 'the sideways branch leaves the base midpoint');
});

test('D. a TC reached by two routes still has one node and one triangle', () => {
  // Both routes end on the same coordinate, which is one physical point.
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 2 },
    { id: 'r2', from: 'endpoint:A', direction: 'south', spans: 2, tc: true },
    { id: 'r3', from: 'origin', direction: 'south', spans: 4, tc: true },
  ]);
  const scene = buildScene(network, 'preview');
  assert.equal(scene.tc.length, 1, 'one coordinate, one triangle');
  assert.equal(network.tcCount, 1, 'one TC endpoint');
});

/* ------------------------------------------------------------------------ */
/* E. Cross-renderer agreement                                               */
/* ------------------------------------------------------------------------ */

test('E. every profile draws the triangle from the same outline', () => {
  const network = buildNetwork(throughTc('south'));
  const outlines = [];
  // The mini-preview uses the preview profile and its own viewBox, so there is no
  // separate scene profile to compare: it is checked in the browser suite.
  for (const profile of ['preview', 'svg', 'pdf', 'print']) {
    const scene = buildScene(network, profile);
    assert.equal(scene.tc.length, 1, `${profile}: the triangle is present`);
    const anchor = scene.tc[0];
    // Compared relative to the anchor, because each profile applies its own
    // padding and that moves the whole drawing, not the shape.
    outlines.push({
      profile,
      vertices: tcTriangleVertices(anchor).map(
        (p) => `${(p.x - anchor.x).toFixed(4)},${(p.y - anchor.y).toFixed(4)}`,
      ),
    });
  }
  const first = outlines[0].vertices;
  for (const { profile, vertices } of outlines) {
    assert.deepEqual(
      vertices,
      first,
      `${profile} draws the same triangle as the preview, compared in scene space`,
    );
  }
});

test('E. the adaptive fit only ever shrinks the triangle', () => {
  // A marker sitting immediately upstream leaves less room, and the triangle must
  // give way rather than swallow the cable. It is never made larger than the
  // configured size, whatever the drawing asks for.
  const config = createConfig();
  const tight = buildScene(
    buildNetwork([
      { id: 'r1', from: 'origin', direction: 'east', spans: 1, fpb: true },
      { id: 'r2', from: 'origin', direction: 'east', spans: 2, tc: true },
    ]),
    'preview',
  );
  const anchor = tight.tc[0];
  assert.ok(
    anchor.height < config.tcMarkerHeight,
    'the triangle gave way to the box upstream of it',
  );

  const roomy = buildScene(buildNetwork(throughTc('south')), 'preview');
  assert.ok(
    roomy.tc[0].height <= config.tcMarkerHeight + EPS,
    'a triangle with room uses its configured height',
  );
  assert.ok(roomy.tc[0].height > 0, 'a triangle is never reduced to nothing');
});

test('E. gridToPixel still maps South to a growing pixel Y', () => {
  // Guard for the assumption the orientation table is written against: the
  // drawing's Y axis is inverted relative to the grid, so "upstream" for a route
  // laid South is a smaller pixel Y.
  const bbox = { minX: 0, minY: -5, maxX: 5, maxY: 0 };
  const north = gridToPixel({ x: 0, y: 0 }, bbox, 40);
  const south = gridToPixel({ x: 0, y: -1 }, bbox, 40);
  assert.ok(south.y > north.y, 'a point further South is lower on the sheet');
});
