/**
 * FPB marker line clipping.
 *
 * A feeder pillar box used to hide route lines with a white fill. The line was
 * still drawn underneath, so the geometry ran through the symbol and any change
 * to the fill would have exposed it. These tests pin the replacement: the line
 * geometry stops at the rectangle boundary, exactly as it does for a TC
 * triangle, and nothing is drawn inside the box.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNetwork } from '../src/geometry/network.js';
import { buildScene } from '../src/geometry/scene.js';
import { clipSegmentOutsidePolygon, fpbRectVertices } from '../src/geometry/markers.js';
import { createConfig } from '../src/config.js';

/** Tolerance for comparing coordinates that pass through pixel rounding. */
const EPS = 1e-6;

/**
 * Every drawn segment of a scene, as a list of sampled points.
 *
 * @param {object} scene Scene from `buildScene`.
 * @param {number} [steps] Samples per segment.
 * @returns {{x: number, y: number}[]} Sampled points.
 */
function sampleScene(scene, steps = 60) {
  const points = [];
  for (const line of scene.lines) {
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      points.push({
        x: line.x1 + (line.x2 - line.x1) * t,
        y: line.y1 + (line.y2 - line.y1) * t,
      });
    }
  }
  return points;
}

/**
 * Whether a point lies strictly inside a box, excluding its outline.
 *
 * The boundary belongs to the symbol: a trimmed line is expected to touch it,
 * so only the interior is required to be empty.
 */
function strictlyInside(box, x, y) {
  const left = box.boxX;
  const right = box.boxX + box.width;
  const top = box.boxY;
  const bottom = box.boxY + box.height;
  return x > left + EPS && x < right - EPS && y > top + EPS && y < bottom - EPS;
}

/** Build the scene for a set of instructions on the preview profile. */
function sceneFor(routes, profile = 'preview') {
  return buildScene(buildNetwork(routes), profile);
}

/** A route to an FPB two spans east of the Origin, then on to four spans. */
const HORIZONTAL_THROUGH = [
  { id: 'r1', from: 'origin', direction: 'east', spans: 2, tc: false, fpb: true },
  { id: 'r2', from: 'origin', direction: 'east', spans: 4, tc: false, fpb: false },
];

/** A route to an FPB two spans south of the Origin, then on to four spans. */
const VERTICAL_THROUGH = [
  { id: 'r1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: true },
  { id: 'r2', from: 'origin', direction: 'south', spans: 4, tc: false, fpb: false },
];

test('the FPB outline is read from the same primitive the renderers draw', () => {
  const scene = sceneFor(HORIZONTAL_THROUGH);
  assert.equal(scene.fpb.length, 1, 'exactly one box');
  const box = scene.fpb[0];

  const vertices = fpbRectVertices(box);
  assert.equal(vertices.length, 4, 'a rectangle has four corners');
  assert.deepEqual(vertices[0], { x: box.boxX, y: box.boxY });
  assert.deepEqual(vertices[1], { x: box.boxX + box.width, y: box.boxY });
  assert.deepEqual(vertices[2], { x: box.boxX + box.width, y: box.boxY + box.height });
  assert.deepEqual(vertices[3], { x: box.boxX, y: box.boxY + box.height });

  // The box is centred on its anchor, and its size comes from its own label.
  assert.ok(Math.abs(box.boxX + box.width / 2 - box.x) < EPS, 'centred horizontally');
  assert.ok(Math.abs(box.boxY + box.height / 2 - box.y) < EPS, 'centred vertically');
  const config = createConfig();
  assert.ok(Math.abs(box.height - (config.fpbFontSize + config.fpbPaddingY * 2)) < EPS);
});

test('1. a horizontal line stops at the box and resumes on the opposite side', () => {
  const scene = sceneFor(HORIZONTAL_THROUGH);
  const box = scene.fpb[0];
  const left = box.boxX;
  const right = box.boxX + box.width;

  const horizontal = scene.lines.filter((l) => Math.abs(l.y1 - box.y) < EPS && Math.abs(l.y2 - box.y) < EPS);
  assert.ok(horizontal.length >= 2, 'the route is split into pieces each side of the box');

  const arriving = horizontal.filter((l) => l.x2 <= left + EPS);
  const leaving = horizontal.filter((l) => l.x1 >= right - EPS);
  assert.ok(arriving.length >= 1, 'a piece arrives from the left');
  assert.ok(leaving.length >= 1, 'a piece leaves on the right');

  // The arriving piece ends exactly on the left edge; the leaving one starts on
  // the right edge. Neither overshoots into the box.
  assert.ok(
    arriving.some((l) => Math.abs(l.x2 - left) < EPS),
    'the arriving line stops exactly at the left boundary',
  );
  assert.ok(
    leaving.some((l) => Math.abs(l.x1 - right) < EPS),
    'the leaving line resumes exactly at the right boundary',
  );
  for (const line of horizontal) {
    assert.ok(line.x1 >= left - EPS || line.x2 <= left + EPS, 'no piece starts inside on the left');
    assert.ok(line.x2 <= right + EPS || line.x1 >= right - EPS, 'no piece runs into the box');
  }
});

test('2. a vertical line stops at the box and resumes on the opposite side', () => {
  const scene = sceneFor(VERTICAL_THROUGH);
  const box = scene.fpb[0];
  const top = box.boxY;
  const bottom = box.boxY + box.height;

  const vertical = scene.lines.filter((l) => Math.abs(l.x1 - box.x) < EPS && Math.abs(l.x2 - box.x) < EPS);
  assert.ok(vertical.length >= 2, 'the route is split into pieces above and below the box');
  assert.ok(
    vertical.some((l) => Math.abs(l.y2 - top) < EPS),
    'the incoming line stops exactly at the top boundary',
  );
  assert.ok(
    vertical.some((l) => Math.abs(l.y1 - bottom) < EPS),
    'the outgoing line resumes exactly at the bottom boundary',
  );
  assert.ok(
    !vertical.some((l) => l.y1 < top - EPS && l.y2 > bottom + EPS),
    'no single piece runs straight through the box',
  );
});

test('3. a route terminating at an FPB stops at the rectangle boundary', () => {
  const scene = sceneFor([
    { id: 'r1', from: 'origin', direction: 'east', spans: 2, tc: false, fpb: true },
  ]);
  const box = scene.fpb[0];
  assert.equal(scene.fpb.length, 1);

  const last = scene.lines.at(-1);
  assert.ok(Math.abs(last.x2 - box.boxX) < 1e-9, 'the route ends exactly on the box edge');
  assert.ok(last.x1 < box.boxX, 'it approaches from outside the box');
  // Nothing continues past the box, because the route ends there.
  assert.ok(
    !scene.lines.some((l) => l.x1 >= box.boxX + box.width - EPS),
    'no line exists beyond the box',
  );
});

test('4. every branch connected to an FPB stops at its own boundary', () => {
  const scene = sceneFor([
    { id: 'r1', from: 'origin', direction: 'east', spans: 2, tc: false, fpb: true },
    { id: 'r2', from: 'fpb:1', direction: 'north', spans: 2, tc: false, fpb: false },
    { id: 'r3', from: 'fpb:1', direction: 'south', spans: 2, tc: false, fpb: false },
    { id: 'r4', from: 'origin', direction: 'east', spans: 4, tc: false, fpb: false },
  ]);
  const box = scene.fpb[0];
  const left = box.boxX;
  const right = box.boxX + box.width;
  const top = box.boxY;
  const bottom = box.boxY + box.height;

  // A line's own direction depends on edge ordering, so match either endpoint.
  const ends = (line) => [
    { x: line.x1, y: line.y1 },
    { x: line.x2, y: line.y2 },
  ];
  const anyEnd = (predicate) => scene.lines.some((line) => ends(line).some(predicate));

  // The vertical branches leave the box's top and bottom edges.
  assert.ok(
    anyEnd((p) => Math.abs(p.x - box.x) < EPS && Math.abs(p.y - top) < EPS),
    'a branch meets the top edge',
  );
  assert.ok(
    anyEnd((p) => Math.abs(p.x - box.x) < EPS && Math.abs(p.y - bottom) < EPS),
    'a branch meets the bottom edge',
  );

  // The through route meets the left and right edges.
  assert.ok(anyEnd((p) => Math.abs(p.x - left) < EPS), 'the incoming route meets the left edge');
  assert.ok(anyEnd((p) => Math.abs(p.x - right) < EPS), 'the outgoing route meets the right edge');

  // Whatever the branch, nothing is drawn inside.
  for (const point of sampleScene(scene)) {
    assert.ok(!strictlyInside(box, point.x, point.y), 'no branch runs inside the box');
  }
});

test('5. a line that misses the rectangle is returned unchanged', () => {
  const box = { boxX: 100, boxY: 20, width: 30, height: 16 };
  const vertices = fpbRectVertices(box);
  const parts = clipSegmentOutsidePolygon(0, 200, 300, 200, vertices);
  assert.equal(parts.length, 1, 'the line is not split');
  assert.deepEqual(parts[0], { x1: 0, y1: 200, x2: 300, y2: 200 });

  // The same holds in a real scene: a route well clear of the box keeps its
  // full span length.
  const scene = sceneFor([
    ...HORIZONTAL_THROUGH,
    { id: 'r3', from: 'origin', direction: 'south', spans: 3, tc: false, fpb: false },
  ]);
  const config = createConfig();
  const vertical = scene.lines.filter(
    (l) => Math.abs(l.x1 - l.x2) < EPS && Math.abs(Math.abs(l.y2 - l.y1) - config.spanLength) < EPS,
  );
  assert.ok(vertical.length >= 1, 'the unrelated route keeps its unit spans untouched');
});

test('6. a segment lying wholly inside the rectangle is dropped', () => {
  const box = { boxX: 100, boxY: 20, width: 30, height: 16 };
  const vertices = fpbRectVertices(box);
  const parts = clipSegmentOutsidePolygon(110, 26, 120, 30, vertices);
  assert.equal(parts.length, 0, 'nothing is drawn inside the box');

  // A line that only partly overlaps keeps just its outside part.
  const partial = clipSegmentOutsidePolygon(95, 28, 115, 28, vertices);
  assert.equal(partial.length, 1);
  assert.ok(Math.abs(partial[0].x2 - box.boxX) < EPS, 'it is cut at the left edge');
  assert.ok(Math.abs(partial[0].x1 - 95) < EPS, 'the outside end is preserved');
});

test('7. boundary contact does not leave a visible gap', () => {
  for (const routes of [HORIZONTAL_THROUGH, VERTICAL_THROUGH]) {
    const scene = sceneFor(routes);
    const box = scene.fpb[0];
    const edges = {
      left: (p) => Math.abs(p.x - box.boxX) < EPS && p.y >= box.boxY - EPS && p.y <= box.boxY + box.height + EPS,
      right: (p) =>
        Math.abs(p.x - (box.boxX + box.width)) < EPS &&
        p.y >= box.boxY - EPS &&
        p.y <= box.boxY + box.height + EPS,
      top: (p) => Math.abs(p.y - box.boxY) < EPS && p.x >= box.boxX - EPS && p.x <= box.boxX + box.width + EPS,
      bottom: (p) =>
        Math.abs(p.y - (box.boxY + box.height)) < EPS &&
        p.x >= box.boxX - EPS &&
        p.x <= box.boxX + box.width + EPS,
    };

    const endpoints = scene.lines.flatMap((l) => [
      { x: l.x1, y: l.y1 },
      { x: l.x2, y: l.y2 },
    ]);
    const touches = Object.entries(edges).filter(([, test]) => endpoints.some(test));
    assert.ok(touches.length >= 2, 'the trimmed route meets the box on at least two sides');
  }
});

test('8. no line points lie inside the rectangle in any direction', () => {
  const cases = [
    HORIZONTAL_THROUGH,
    VERTICAL_THROUGH,
    [
      { id: 'r1', from: 'origin', direction: 'east', spans: 2, tc: false, fpb: true },
      { id: 'r2', from: 'fpb:1', direction: 'north', spans: 2, tc: false, fpb: false },
      { id: 'r3', from: 'fpb:1', direction: 'south', spans: 2, tc: false, fpb: false },
      { id: 'r4', from: 'origin', direction: 'east', spans: 4, tc: false, fpb: false },
    ],
  ];
  for (const routes of cases) {
    const scene = sceneFor(routes);
    const box = scene.fpb[0];
    for (const point of sampleScene(scene, 80)) {
      assert.ok(
        !strictlyInside(box, point.x, point.y),
        `a line is drawn inside the box at (${point.x.toFixed(2)}, ${point.y.toFixed(2)})`,
      );
    }
  }
});

test('9. preview, SVG, PDF and print clip the box identically', () => {
  const reference = sceneFor(HORIZONTAL_THROUGH);
  const referenceBox = reference.fpb[0];

  for (const profile of ['preview', 'svg', 'pdf', 'print']) {
    const scene = sceneFor(HORIZONTAL_THROUGH, profile);
    assert.equal(scene.fpb.length, 1, `${profile} draws the box`);
    const box = scene.fpb[0];
    // A profile's margin differs, so the box moves with the drawing. Its size
    // is what must be identical, because it comes from the same primitive.
    assert.ok(Math.abs(box.width - referenceBox.width) < EPS, `${profile} box width matches`);
    assert.ok(Math.abs(box.height - referenceBox.height) < EPS, `${profile} box height matches`);

    for (const point of sampleScene(scene)) {
      assert.ok(!strictlyInside(box, point.x, point.y), `${profile} draws nothing inside the box`);
    }

    // The same pieces exist in every profile, so the route is not cut short.
    assert.equal(
      scene.lines.length,
      reference.lines.length,
      `${profile} splits the route into the same number of pieces`,
    );
  }
});

test('10. TC clipping is unchanged by the FPB work', () => {
  const routes = [
    { id: 'r1', from: 'origin', direction: 'south', spans: 4, tc: true, fpb: false },
    { id: 'r2', from: 'origin', direction: 'south', spans: 9, tc: false, fpb: false },
  ];
  const scene = buildScene(buildNetwork(routes), 'preview');
  assert.equal(scene.tc.length, 1);
  assert.equal(scene.fpb.length, 0);

  const triangle = scene.tc[0];
  const apex = triangle.y + triangle.halfWidth * 0.35;
  const base = apex + triangle.height;
  const EDGE = 1e-3;
  const insideTriangle = (x, y) => {
    const yn = (y - apex) / triangle.height;
    if (yn <= EDGE || yn >= 1 - EDGE) return false;
    return Math.abs(x - triangle.x) < triangle.halfWidth * (1 - yn) - EDGE;
  };

  for (const point of sampleScene(scene, 80)) {
    assert.ok(!insideTriangle(point.x, point.y), 'the triangle interior is still empty');
  }
  assert.ok(
    scene.lines.some((l) => Math.abs(l.y1 - apex) < EPS || Math.abs(l.y2 - apex) < EPS),
    'the line still meets the apex',
  );

  // A TC point and an FPB in one drawing are both clipped.
  const mixed = buildScene(
    buildNetwork([
      { id: 'm1', from: 'origin', direction: 'south', spans: 4, tc: true, fpb: false },
      { id: 'm2', from: 'origin', direction: 'south', spans: 9, tc: false, fpb: false },
      { id: 'm3', from: 'origin', direction: 'east', spans: 3, tc: false, fpb: true },
      { id: 'm4', from: 'origin', direction: 'east', spans: 6, tc: false, fpb: false },
    ]),
    'preview',
  );
  assert.equal(mixed.tc.length, 1);
  assert.equal(mixed.fpb.length, 1);
  const box = mixed.fpb[0];
  for (const point of sampleScene(mixed, 80)) {
    assert.ok(!insideTriangle(point.x, point.y), 'no line inside the triangle');
    assert.ok(!strictlyInside(box, point.x, point.y), 'no line inside the box');
  }
});

test('clipping never changes the canonical network or the line count per edge', () => {
  const network = buildNetwork(HORIZONTAL_THROUGH);
  const edgesBefore = [...network.graph.edges.keys()].sort();
  const nodesBefore = [...network.graph.nodes.keys()].sort();

  const scene = buildScene(network, 'preview');

  assert.deepEqual([...network.graph.edges.keys()].sort(), edgesBefore, 'edges are untouched');
  assert.deepEqual([...network.graph.nodes.keys()].sort(), nodesBefore, 'nodes are untouched');
  // Every canonical edge is still drawn, and only edges that pass through the
  // box gain extra pieces. The box is centred on a node here, so it trims the
  // two edges either side of that node without splitting either of them.
  const drawnEdges = new Set(scene.lines.map((l) => l.parentId));
  assert.equal(drawnEdges.size, edgesBefore.length, 'every edge is still represented');
  assert.equal(scene.lines.length, edgesBefore.length, 'no edge needed splitting');
  assert.equal(edgesBefore.length, 4, 'the fixture has four canonical edges');

  // Every piece names the edge it came from, so edge identity survives.
  const parents = new Set(scene.lines.map((l) => l.parentId));
  assert.equal(parents.size, edgesBefore.length, 'each canonical edge is represented once');
  for (const line of scene.lines) {
    assert.equal(line.parentId, `line:${line.parentId.slice('line:'.length)}`, 'the parent id is stable');
    assert.ok(
      edgesBefore.some((key) => line.parentId === `line:${key}`),
      `the parent ${line.parentId} is a real canonical edge`,
    );
  }
});

test('clipping never lengthens a segment or leaves a zero-length piece', () => {
  const scene = sceneFor(HORIZONTAL_THROUGH);
  const config = createConfig();
  for (const line of scene.lines) {
    const length = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
    assert.ok(length > 1e-6, `${line.id} is not a stray zero-length piece`);
    assert.ok(
      length <= config.spanLength + 1e-9,
      `${line.id} is no longer than one span (${length.toFixed(3)})`,
    );
  }
});
