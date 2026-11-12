import assert from 'node:assert/strict';
import test from 'node:test';

import { clipSegmentOutsidePolygon, tcTriangleVertices } from '../src/geometry/markers.js';
import { buildNetwork } from '../src/geometry/network.js';
import { buildScene } from '../src/geometry/scene.js';

const TRIS = () => {
  const tc = { x: 0, y: 0, halfWidth: 12, height: 20 };
  return tcTriangleVertices(tc);
};

test('a line crossing a triangle is split around its interior', () => {
  const vertices = TRIS();
  const apex = vertices[0].y;
  const base = vertices[1].y;
  const parts = clipSegmentOutsidePolygon(0, apex - 40, 0, base + 40, vertices);
  assert.equal(parts.length, 2, 'the line becomes two visible pieces');
  assert.ok(parts[0].y2 <= apex + 1e-6, 'the first piece stops at the apex');
  assert.ok(parts[1].y1 >= base - 1e-6, 'the second piece resumes at the base');
});

test('a line that misses the triangle is returned untouched', () => {
  const vertices = TRIS();
  const parts = clipSegmentOutsidePolygon(100, -40, 100, 60, vertices);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], { x1: 100, y1: -40, x2: 100, y2: 60 });
});

test('a line wholly inside the triangle is dropped', () => {
  const vertices = TRIS();
  const midY = (vertices[0].y + vertices[1].y) / 2;
  const parts = clipSegmentOutsidePolygon(0, midY, 0, midY + 1, vertices);
  assert.equal(parts.length, 0);
});

test('clipping does not lengthen a line or move its endpoints', () => {
  const vertices = TRIS();
  const parts = clipSegmentOutsidePolygon(-30, -40, 30, 60, vertices);
  for (const part of parts) {
    assert.ok(part.y1 >= -40 - 1e-6 && part.y2 <= 60 + 1e-6);
    assert.ok(Math.hypot(part.x2 - part.x1, part.y2 - part.y1) > 0);
  }
});

test('the example scene draws no line inside the TC triangle', () => {
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 4, tc: false },
  ]);
  network.graph.nodes.forEach(() => {});
  // Build a TC point four spans south of the Origin, with routes continuing on.
  const withTc = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 4, tc: true },
    { id: 'r2', from: 'origin', direction: 'south', spans: 9, tc: false },
  ]);
  assert.equal(withTc.tcCount, 1);
  const scene = buildScene(withTc, 'preview');
  assert.equal(scene.tc.length, 1, 'the triangle is present');

  const anchor = scene.tc[0];
  // The shape under test is the one actually drawn, read from the same function
  // the renderers use, so this cannot drift from the marker a reader sees.
  const vertices = tcTriangleVertices(anchor);
  // The boundary belongs to the symbol: a trimmed line legitimately touches the
  // outline. Only the strictly interior region must stay empty.
  const EDGE = 1e-3;
  const inside = (x, y) => {
    // Strict interior only. A point on an edge produces a zero for that edge and
    // is therefore NOT inside: the boundary belongs to the symbol, and a trimmed
    // line is expected to touch it.
    const sign = (p, q, r) => (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
    const [a, b, c] = vertices;
    const d1 = sign({ x, y }, a, b);
    const d2 = sign({ x, y }, b, c);
    const d3 = sign({ x, y }, c, a);
    return d1 > EDGE && d2 > EDGE && d3 > EDGE;
  };

  for (const line of scene.lines) {
    // Sample along every drawn segment: none may pass through the interior.
    for (let step = 0; step <= 20; step += 1) {
      const t = step / 20;
      const x = line.x1 + (line.x2 - line.x1) * t;
      const y = line.y1 + (line.y2 - line.y1) * t;
      assert.ok(
        !inside(x, y),
        `${line.id} is drawn inside the TC triangle at (${x.toFixed(1)}, ${y.toFixed(1)})`,
      );
    }
  }
  assert.equal(network.tcCount, 0, 'the control network has no TC point');
});

test('the line still visually meets the triangle it was trimmed against', () => {
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 4, tc: true },
    { id: 'r2', from: 'origin', direction: 'south', spans: 9, tc: false },
  ]);
  const scene = buildScene(network, 'preview');
  const anchor = scene.tc[0];
  // The triangle is anchored on its downstream base midpoint, so its apex sits
  // one full height upstream of the node. On a route laid South that is above
  // the node, which is where the arriving cable has to stop.
  const vertices = tcTriangleVertices(anchor);
  const apex = vertices[0];

  const touching = scene.lines.filter(
    (line) =>
      (Math.abs(line.x1 - apex.x) < 1e-6 && Math.abs(line.y1 - apex.y) < 1e-6) ||
      (Math.abs(line.x2 - apex.x) < 1e-6 && Math.abs(line.y2 - apex.y) < 1e-6),
  );
  assert.ok(touching.length >= 1, 'a line ends exactly at the apex, so there is no gap');
});

test('trimming applies to every profile that draws lines and triangles', () => {
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 4, tc: true },
    { id: 'r2', from: 'origin', direction: 'south', spans: 9, tc: false },
  ]);
  for (const profile of ['preview', 'svg', 'pdf', 'print']) {
    const scene = buildScene(network, profile);
    const anchor = scene.tc[0];
    // Apex upstream of the node, base exactly on it.
    const vertices = tcTriangleVertices(anchor);
    const apex = vertices[0].y;
    const base = Math.max(vertices[1].y, vertices[2].y);
    const crossing = scene.lines.filter(
      (line) => Math.abs(line.x1 - anchor.x) < 1e-6 && Math.abs(line.x2 - anchor.x) < 1e-6
        && line.y1 < apex && line.y2 > base,
    );
    assert.equal(crossing.length, 0, `${profile} draws no line straight through the triangle`);
    // The split pieces are still present, so the route does not look cut.
    const pieces = scene.lines.filter(
      (line) => Math.abs(line.x1 - anchor.x) < 1e-6 && Math.abs(line.x2 - anchor.x) < 1e-6,
    );
    assert.ok(pieces.length >= 2, `${profile} keeps the line either side of the triangle`);
  }
});
