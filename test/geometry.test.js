import test from 'node:test';
import assert from 'node:assert/strict';

import { advance, normalizeDirection, coordKey } from '../src/geometry/direction.js';
import { edgeKey, createGraph, ensureNode, addEdge } from '../src/geometry/graph.js';
import { buildNetwork, alphaLabel, computeBoundingBox, ERROR_CODES } from '../src/geometry/network.js';
import { buildScene, gridToPixel, measureDrawing } from '../src/geometry/scene.js';
import { EXAMPLE_ROUTES, createConfig, RENDER_PROFILES } from '../src/config.js';

/** Convenience wrapper matching the shape the UI submits. */
function routes(list) {
  return list.map((r, i) => ({ id: `r${i + 1}`, ...r }));
}

function nodeAt(network, x, y) {
  return network.graph.nodes.get(`${x},${y}`) ?? null;
}

test('1. cardinal directions map to the documented coordinate deltas', () => {
  const origin = { x: 0, y: 0 };
  assert.deepEqual(advance(origin, 'north', 1), { x: 0, y: 1 });
  assert.deepEqual(advance(origin, 'south', 1), { x: 0, y: -1 });
  assert.deepEqual(advance(origin, 'east', 1), { x: 1, y: 0 });
  assert.deepEqual(advance(origin, 'west', 1), { x: -1, y: 0 });
  assert.deepEqual(advance({ x: 3, y: -2 }, 'north', 4), { x: 3, y: 2 });
  assert.equal(normalizeDirection('NORTH'), 'north');
  assert.equal(normalizeDirection(' East '), 'east');
  assert.equal(normalizeDirection('up'), null);
});

test('2. N spans produce N unit edges and N+1 pole positions including the source', () => {
  const network = buildNetwork(routes([{ from: 'origin', direction: 'east', spans: 4, tc: false }]));
  assert.equal(network.graph.edges.size, 4);
  assert.equal(network.graph.nodes.size, 5);
  assert.equal(nodeAt(network, 0, 0).id, 'n1');
  for (let x = 0; x <= 4; x += 1) {
    assert.ok(nodeAt(network, x, 0), `pole at x=${x} must exist`);
  }
});

test('2b. a plain graph keeps one node per shared coordinate', () => {
  const graph = createGraph();
  const a = ensureNode(graph, { x: 0, y: 0 });
  const b = ensureNode(graph, { x: 0, y: 0 });
  assert.equal(a.id, b.id);
  assert.equal(graph.nodes.size, 1);
  addEdge(graph, { x: 0, y: 0 }, { x: 1, y: 0 }, { routeId: 'r1' });
  addEdge(graph, { x: 1, y: 0 }, { x: 0, y: 0 }, { routeId: 'r2' });
  assert.equal(graph.edges.size, 1, 'reverse traversal must not duplicate the edge');
  assert.equal(edgeKey({ x: 1, y: 0 }, { x: 0, y: 0 }), edgeKey({ x: 0, y: 0 }, { x: 1, y: 0 }));
});

test('3. alphabetical labels are assigned on first reuse as a source', () => {
  assert.equal(alphaLabel(0), 'A');
  assert.equal(alphaLabel(25), 'Z');
  assert.equal(alphaLabel(26), 'AA');

  // Route 1 creates an endpoint that is never reused -> no label.
  const single = buildNetwork(routes([{ from: 'origin', direction: 'north', spans: 2, tc: false }]));
  const terminal = single.endpoints.find((e) => e.kind !== 'origin' && e.kind !== 'tc');
  assert.equal(terminal.displayName, null, 'unused terminal endpoint displays no letter');
  assert.equal(nodeAt(single, 0, 2).alphaLabel, null);

  // Reusing an endpoint as a source assigns the next letter, in order.
  const network = buildNetwork(
    routes([
      { from: 'origin', direction: 'north', spans: 2, tc: false },
      { from: 'endpoint:A', direction: 'east', spans: 1, tc: false },
      { from: 'endpoint:B', direction: 'south', spans: 1, tc: false },
    ]),
  );
  assert.equal(nodeAt(network, 0, 2).alphaLabel, 'A');
  assert.equal(nodeAt(network, 1, 2).alphaLabel, 'B');
  assert.equal(network.alphaCount, 2);
});

test('4. TC endpoints are identified by a stable internal id and a triangle marker', () => {
  const network = buildNetwork(
    routes([
      { from: 'origin', direction: 'south', spans: 1, tc: true },
      { from: 'origin', direction: 'east', spans: 2, tc: true },
    ]),
  );
  const tcs = network.endpoints.filter((e) => e.kind === 'tc');
  assert.equal(tcs.length, 2);
  assert.deepEqual(
    tcs.map((t) => t.id),
    ['tc:1', 'tc:2'],
  );
  assert.equal(network.tcCount, 2);
  assert.equal(network.alphaCount, 0, 'TC must not consume alphabetical letters');

  const scene = buildScene(network, 'preview');
  assert.equal(scene.tc.length, 2);
  // The TC node itself still carries an X plus the triangle.
  assert.ok(scene.poles.some((p) => p.id === 'pole:0,-1'));
});

test('4b. a single TC point displays "TC"; several display TC1..TCn', () => {
  const one = buildNetwork(routes([{ from: 'origin', direction: 'south', spans: 1, tc: true }]));
  assert.equal(one.endpoints.find((e) => e.kind === 'tc').displayName, 'TC');

  const many = buildNetwork(
    routes([
      { from: 'origin', direction: 'south', spans: 1, tc: true },
      { from: 'origin', direction: 'east', spans: 1, tc: true },
    ]),
  );
  assert.deepEqual(
    many.endpoints.filter((e) => e.kind === 'tc').map((e) => e.displayName),
    ['TC1', 'TC2'],
  );
  assert.equal(buildScene(many, 'preview').tc[0].name, 'TC1');
});

test('5. reusing endpoints keeps one stable identity and does not duplicate poles', () => {
  const network = buildNetwork(
    routes([
      { from: 'origin', direction: 'east', spans: 4, tc: false },
      { from: 'endpoint:A', direction: 'east', spans: 2, tc: false },
      { from: 'endpoint:A', direction: 'south', spans: 2, tc: false },
    ]),
  );
  // 5 nodes along y=0 (0..4), 2 more east to 6, 2 more south to -2.
  assert.equal(network.graph.nodes.size, 9);
  assert.equal(network.graph.edges.size, 8);
  // Reusing A twice keeps one identity and one pole at that coordinate.
  assert.equal(network.endpoints.filter((e) => e.position.x === 4 && e.position.y === 0).length, 1);
  const scene = buildScene(network, 'preview');
  assert.equal(scene.poles.length, 9);
  assert.equal(new Set(scene.poles.map((p) => p.id)).size, 9);
});

test('6. shared endpoints merge into one canonical node', () => {
  // Two routes arriving at the same coordinate from different directions must
  // resolve to one canonical node, one pole and no duplicate endpoint.
  const network = buildNetwork(
    routes([
      { from: 'origin', direction: 'east', spans: 2, tc: false }, // A at (2,0)
      { from: 'origin', direction: 'north', spans: 1, tc: false }, // B at (0,1)
      { from: 'endpoint:B', direction: 'east', spans: 2, tc: false }, // C at (2,1)
      { from: 'endpoint:C', direction: 'south', spans: 1, tc: false }, // lands on (2,0)
    ]),
  );
  assert.ok(network.ok);
  // (2,0) is joined to (1,0) from the east route and to (2,1) from the south route.
  assert.deepEqual([...network.graph.nodes.get('2,0').neighbors].sort(), ['1,0', '2,1']);
  // The convergence produced no second endpoint record at (2,0).
  assert.equal(network.endpoints.filter((e) => e.position.x === 2 && e.position.y === 0).length, 1);
  const scene = buildScene(network, 'preview');
  assert.equal(scene.poles.filter((p) => p.id === 'pole:2,0').length, 1);
  // Route 4 reuses the existing A endpoint rather than creating "E".
  assert.equal(network.routes[3].destinationId, 'endpoint:A');
});

test('7. partial overlap merges only the shared segments', () => {
  const network = buildNetwork(
    routes([
      { from: 'origin', direction: 'east', spans: 3, tc: false }, // 0..3
      { from: 'origin', direction: 'east', spans: 5, tc: false }, // 0..5, overlaps 0..3
    ]),
  );
  assert.equal(network.graph.edges.size, 5, 'overlapping units are stored once');
  assert.equal(network.graph.nodes.size, 6);
  const scene = buildScene(network, 'preview');
  assert.equal(scene.lines.length, 5);
  // The first three units lie inside both routes, the last two only in route 2.
  const shared = scene.lines.filter((l) => Math.min(l.x1, l.x2) < scene.padding + 3 * scene.spanLength);
  const onlySecond = scene.lines.filter((l) => Math.min(l.x1, l.x2) >= scene.padding + 3 * scene.spanLength);
  assert.equal(shared.length, 3);
  assert.equal(onlySecond.length, 2);
  assert.ok(shared.every((l) => l.sources.length === 2), 'overlapped units carry both routes');
  assert.ok(onlySecond.every((l) => l.sources.length === 1));
});

test('8. complete overlap is drawn exactly once', () => {
  const network = buildNetwork(
    routes([
      { from: 'origin', direction: 'north', spans: 4, tc: false },
      { from: 'origin', direction: 'north', spans: 4, tc: false },
    ]),
  );
  assert.equal(network.graph.edges.size, 4);
  const scene = buildScene(network, 'preview');
  assert.equal(scene.lines.length, 4);
  assert.ok(scene.lines.every((l) => l.sources.length === 2));
  // Route provenance survives merging.
  assert.equal(network.routes.length, 2);
  assert.ok(network.routes.every((r) => r.ok));
});

test('9. intersecting routes become connected junctions', () => {
  // A horizontal run through (2,0) and a vertical run that descends onto the
  // same coordinate must share one canonical node and connect all four arms.
  const network = buildNetwork(
    routes([
      { from: 'origin', direction: 'east', spans: 4, tc: false }, // (0,0)..(4,0)
      { from: 'origin', direction: 'north', spans: 2, tc: false }, // (0,0)..(0,2)
      { from: 'endpoint:B', direction: 'east', spans: 2, tc: false }, // (0,2)..(2,2)
      { from: 'endpoint:C', direction: 'south', spans: 2, tc: false }, // (2,2)..(2,0)
    ]),
  );
  assert.ok(network.ok);
  const crossing = network.graph.nodes.get('2,0');
  assert.ok(crossing, 'crossing coordinate exists');
  assert.equal(crossing.neighbors.size, 3, 'the junction joins west, east and north');
  assert.deepEqual([...crossing.neighbors].sort(), ['1,0', '2,1', '3,0']);
  const scene = buildScene(network, 'preview');
  assert.equal(scene.poles.filter((p) => p.id === 'pole:2,0').length, 1, 'one X at the junction');
});

test('10. multiple branches from one node remain connected', () => {
  const network = buildNetwork(
    routes([
      { from: 'origin', direction: 'east', spans: 2, tc: false },
      { from: 'endpoint:A', direction: 'north', spans: 1, tc: false },
      { from: 'endpoint:A', direction: 'south', spans: 1, tc: false },
      { from: 'endpoint:A', direction: 'east', spans: 1, tc: false },
    ]),
  );
  const hub = network.graph.nodes.get('2,0');
  assert.equal(hub.neighbors.size, 4);
  assert.equal(network.graph.edges.size, 5);
  assert.equal(network.routes.filter((r) => r.ok).length, 4);
});

test('11. preview labels: origin and alphabetical labels are visible', () => {
  const network = buildNetwork(
    routes([
      { from: 'origin', direction: 'east', spans: 2, tc: false },
      { from: 'endpoint:A', direction: 'south', spans: 2, tc: true },
    ]),
  );
  const scene = buildScene(network, 'preview');
  assert.equal(scene.labels.filter((l) => l.kind === 'origin').length, 1);
  assert.equal(scene.labels.filter((l) => l.kind === 'alpha').length, 1);
  assert.equal(scene.labels[0].text !== undefined, true);
  assert.equal(scene.hasVisibleText, true);
});

test('12. PDF and SVG profiles suppress origin and alphabetical labels', () => {
  const network = buildNetwork(
    routes([
      { from: 'origin', direction: 'east', spans: 2, tc: false },
      { from: 'endpoint:A', direction: 'south', spans: 2, tc: true },
    ]),
  );
  for (const profileId of ['pdf', 'svg', 'print']) {
    const scene = buildScene(network, profileId);
    assert.equal(scene.labels.length, 0, `${profileId} must hide all labels`);
    assert.equal(scene.hasVisibleText, false);
  }
  // ...while the canonical model still carries them.
  assert.equal(network.graph.nodes.get('0,0').isOrigin, true);
  assert.equal(network.graph.nodes.get('2,0').alphaLabel, 'A');
});

test('13. TC triangles and X markers survive every render profile', () => {
  const network = buildNetwork(
    routes([
      { from: 'origin', direction: 'south', spans: 1, tc: true },
      { from: 'origin', direction: 'east', spans: 1, tc: false },
    ]),
  );
  for (const profileId of Object.keys(RENDER_PROFILES)) {
    const scene = buildScene(network, profileId);
    assert.ok(scene.tc.length >= 1, `${profileId} keeps the TC triangle`);
    assert.ok(scene.poles.length >= 1, `${profileId} keeps the X symbols`);
    assert.ok(scene.lines.length >= 1, `${profileId} keeps the lines`);
  }
});

test('example network: topology matches the reference drawing', () => {
  const network = buildNetwork(routes([...EXAMPLE_ROUTES]));
  assert.equal(network.ok, true, 'example must be valid');
  assert.equal(network.routes.filter((r) => r.ok).length, 9);

  // Origin south 1 -> A at (0,-1)
  assert.ok(nodeAt(network, 0, -1));
  // A east 4 -> B at (4,-1)
  assert.ok(nodeAt(network, 4, -1));
  // B south 3 -> TC at (4,-4)
  const tcNode = nodeAt(network, 4, -4);
  assert.ok(tcNode);
  assert.equal(tcNode.tcId, 'tc:1');
  // TC south 3 -> C at (4,-7)
  assert.ok(nodeAt(network, 4, -7));
  // C east 1 -> D at (5,-7); C south 2 -> E at (4,-9)
  assert.ok(nodeAt(network, 5, -7));
  assert.ok(nodeAt(network, 4, -9));
  // D west 3 -> F at (2,-7); D east 7 -> G at (12,-7); D south 10 -> H at (5,-17)
  assert.ok(nodeAt(network, 2, -7));
  assert.ok(nodeAt(network, 12, -7));
  assert.ok(nodeAt(network, 5, -17));

  const bbox = computeBoundingBox(network.graph);
  assert.deepEqual(bbox, { minX: 0, minY: -17, maxX: 12, maxY: 0 });

  // 1 + 4 + 3 + 3 + 1 + 2 + 3 + 7 + 10 spans, with 33 distinct unit edges
  // (one unit is shared where C east 1 and D west 3 meet at D).
  assert.equal(network.graph.edges.size, 33);
  assert.equal(network.graph.nodes.size, 34);

  // Exactly one TC point in the example.
  assert.equal(network.tcCount, 1);
  assert.equal(network.endpoints.find((e) => e.kind === 'tc').displayName, 'TC');

  // Every reused source got an alphabetical letter, in first-use order.
  assert.equal(nodeAt(network, 0, -1).alphaLabel, 'A');
  assert.equal(nodeAt(network, 4, -1).alphaLabel, 'B');
  assert.equal(nodeAt(network, 4, -7).alphaLabel, 'C');
  assert.equal(nodeAt(network, 5, -7).alphaLabel, 'D');
  // Terminals that are never reused carry no letter.
  assert.equal(nodeAt(network, 4, -9).alphaLabel, null);
  assert.equal(nodeAt(network, 5, -17).alphaLabel, null);
});

test('sequential dependency: forward references are refused with an actionable error', () => {
  const network = buildNetwork(
    routes([
      { from: 'endpoint:B', direction: 'east', spans: 1, tc: false },
      { from: 'origin', direction: 'east', spans: 1, tc: false },
    ]),
  );
  assert.equal(network.ok, false);
  assert.equal(network.errors[0].row, 0);
  assert.match(network.errors[0].message, /has not been created yet/);
  // Nothing is silently reordered: row 0 produced no geometry.
  assert.equal(network.routes[0].ok, false);
});

test('sequential dependency: a failed row invalidates its dependents, without dropping them', () => {
  const network = buildNetwork(
    routes([
      { from: 'origin', direction: 'east', spans: 0, tc: false },
      { from: 'endpoint:A', direction: 'east', spans: 2, tc: false },
    ]),
  );
  assert.equal(network.ok, false);
  assert.equal(network.errors.length, 2);
  assert.equal(network.errors[0].code, ERROR_CODES.INVALID_SPANS);
  assert.equal(network.errors[1].code, ERROR_CODES.UNKNOWN_SOURCE);
  assert.equal(network.routes.length, 2, 'dependent rows are reported, never dropped');
});

test('invalid spans and directions are rejected', () => {
  for (const spans of [0, -1, 1.5, '3', NaN]) {
    const network = buildNetwork(routes([{ from: 'origin', direction: 'east', spans, tc: false }]));
    assert.equal(network.ok, false, `spans=${String(spans)} must be invalid`);
  }
  const bad = buildNetwork(routes([{ from: 'origin', direction: 'up', spans: 2, tc: false }]));
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, ERROR_CODES.UNKNOWN_DIRECTION);
});

test('editing an existing route recalculates dependents deterministically', () => {
  const base = [
    { from: 'origin', direction: 'south', spans: 1, tc: false },
    { from: 'endpoint:A', direction: 'east', spans: 4, tc: false },
    { from: 'endpoint:B', direction: 'south', spans: 3, tc: false },
  ];
  const before = buildNetwork(routes(base));
  assert.ok(nodeAt(before, 4, -4));

  // Change route 2 from 4 spans to 6.
  const edited = base.map((r, i) => (i === 1 ? { ...r, spans: 6 } : r));
  const after = buildNetwork(routes(edited));
  assert.ok(after.ok);
  assert.ok(nodeAt(after, 6, -1), 'A moved east by two more units');
  assert.ok(nodeAt(after, 6, -4), 'dependent destination moved with it');
  assert.equal(nodeAt(after, 4, -4), null, 'stale geometry is gone');

  // Rebuilding the same edited input twice yields identical topology.
  const again = buildNetwork(routes(edited));
  assert.deepEqual(
    [...after.graph.nodes.keys()].sort(),
    [...again.graph.nodes.keys()].sort(),
  );
  assert.equal(after.graph.edges.size, again.graph.edges.size);
});

test('model stays intact across profiles and span-length changes', () => {
  const network = buildNetwork(routes([...EXAMPLE_ROUTES]));
  const small = buildScene(network, 'preview', { spanLength: 20 });
  const large = buildScene(network, 'preview', { spanLength: 80 });
  assert.equal(small.lines.length, large.lines.length);
  const smallContent = small.width - small.padding * 2;
  const largeContent = large.width - large.padding * 2;
  assert.equal(smallContent, largeContent / 4);
  assert.equal(network.graph.edges.size, 33, 'topology unchanged by spacing');
});

test('scene metrics and grid-to-pixel mapping', () => {
  const config = createConfig();
  const bbox = { minX: 0, minY: -2, maxX: 3, maxY: 0 };
  const metrics = measureDrawing(bbox, config, 10);
  assert.equal(metrics.width, 3 * 40 + 20);
  assert.equal(metrics.height, 2 * 40 + 20);
  // North (+Y) maps upward on screen.
  const top = gridToPixel({ x: 0, y: 0 }, bbox, 10, { x: 5, y: 5 });
  const bottom = gridToPixel({ x: 0, y: -2 }, bbox, 10, { x: 5, y: 5 });
  assert.ok(top.y < bottom.y, 'grid North is up in pixel space');
  assert.equal(coordKey({ x: 1, y: 2 }), '1,2');
});
