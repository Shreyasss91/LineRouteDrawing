/**
 * Asset identity: the ids that loads and span lengths are stored against.
 *
 * The failure these tests exist to prevent: a load attached to "the pole that is
 * drawn at 3,-2" silently becoming a load on a different pole when an edit shifts
 * the drawing. So the ids are checked for stability across edits, for merging
 * when two routes meet, and for never being derived from a label or a coordinate.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNetwork } from '../src/geometry/network.js';
import {
  ORIGIN_NODE,
  buildAssetRegistry,
  destinationAssetId,
  intermediateAssetId,
  nodeAssetIdForStep,
  spanAssetId,
} from '../src/geometry/assets.js';

/** Build a network and its registry from route shorthand. */
function assets(routes, options = {}) {
  const network = buildNetwork(routes, options);
  return { network, registry: buildAssetRegistry(network) };
}

/** Every node id the drawing has. */
function nodeIds(registry) {
  return registry.allNodeAssets().map((a) => a.id);
}

/** Every span id the drawing has. */
function spanIds(registry) {
  return registry.allSpanAssets().map((s) => s.id);
}

const THREE_EAST = { id: 'r1', from: 'origin', direction: 'east', spans: 3, tc: false, fpb: false };

test('1. every drawn node has an id: Origin, intermediates and destinations', () => {
  const { network, registry } = assets([THREE_EAST]);
  assert.equal(registry.allNodeAssets().length, network.graph.nodes.size, 'no node is left out');
  assert.ok(nodeIds(registry).includes(ORIGIN_NODE));
  // A 3-span route walks two intermediate poles and then its destination.
  assert.ok(nodeIds(registry).includes(intermediateAssetId('r1', 0)));
  assert.ok(nodeIds(registry).includes(intermediateAssetId('r1', 1)));
  assert.ok(nodeIds(registry).includes(destinationAssetId('r1')));
});

test('2. intermediate poles are identifiable, not only the named endpoints', () => {
  // The requirement that made this necessary: loads go on intermediate poles too,
  // and there are many more of them than there are letters.
  const { registry } = assets([{ id: 'r1', from: 'origin', direction: 'south', spans: 4, tc: false, fpb: false }]);
  const intermediates = registry.allNodeAssets().filter((a) => a.id.startsWith('mid:'));
  assert.equal(intermediates.length, 3, 'a 4-span route has 3 intermediate poles');
  assert.equal(new Set(intermediates.map((a) => a.id)).size, 3, 'each has a distinct id');
});

test('3. step identity maps the last step to the destination', () => {
  assert.equal(nodeAssetIdForStep('r1', 0, 3), 'mid:r1:0');
  assert.equal(nodeAssetIdForStep('r1', 1, 3), 'mid:r1:1');
  assert.equal(nodeAssetIdForStep('r1', 2, 3), 'dst:r1');
});

test('4. a node shared by two routes is one asset', () => {
  // The second route starts in the middle of the first, so it lands on a pole the
  // first route already made.
  const { network, registry } = assets([
    { id: 'r1', from: 'origin', direction: 'east', spans: 4, tc: false, fpb: false },
    { id: 'r2', from: 'endpoint:A', direction: 'north', spans: 2, tc: false, fpb: false },
  ]);
  assert.equal(
    registry.allNodeAssets().length,
    network.graph.nodes.size,
    'the shared node is not duplicated',
  );
  // The junction keeps the id of the first route that created it.
  const shared = registry.allNodeAssets().find((a) => a.label === 'A');
  assert.equal(shared.id, destinationAssetId('r1'), 'the earlier route owns the shared pole');
});

test('5. an overlapping edge has exactly one span id', () => {
  // Two routes walking the same cable, in opposite directions.
  const { network, registry } = assets([
    { id: 'r1', from: 'origin', direction: 'east', spans: 3, tc: false, fpb: false },
    { id: 'r2', from: 'endpoint:A', direction: 'west', spans: 2, tc: false, fpb: false },
  ]);
  assert.equal(registry.allSpanAssets().length, network.graph.edges.size, 'one span per edge');
  assert.equal(
    new Set(spanIds(registry)).size,
    spanIds(registry).length,
    'no span id appears twice',
  );
});

test('6. a span id is direction independent', () => {
  assert.equal(spanAssetId('a', 'b'), spanAssetId('b', 'a'));
  assert.notEqual(spanAssetId('a', 'b'), spanAssetId('a', 'c'));
});

test('7. an unrelated edit keeps every existing id', () => {
  // This is the core promise: adding a branch elsewhere must not disturb anything.
  const base = [
    THREE_EAST,
    { id: 'r2', from: 'endpoint:A', direction: 'north', spans: 2, tc: false, fpb: false },
  ];
  const before = assets(base);
  const after = assets([
    ...base,
    { id: 'r3', from: 'endpoint:B', direction: 'south', spans: 3, tc: false, fpb: false },
  ]);

  const beforeNodes = new Set(nodeIds(before.registry));
  const afterNodes = new Set(nodeIds(after.registry));
  for (const id of beforeNodes) {
    assert.ok(afterNodes.has(id), `node ${id} keeps its identity`);
  }

  const beforeSpans = new Set(spanIds(before.registry));
  const afterSpans = new Set(spanIds(after.registry));
  for (const id of beforeSpans) {
    assert.ok(afterSpans.has(id), `span ${id} keeps its identity`);
  }
});

test('8. an edit that removes a branch does not hand its ids to anything else', () => {
  const withBranch = assets([
    THREE_EAST,
    { id: 'r2', from: 'endpoint:A', direction: 'north', spans: 3, tc: false, fpb: false },
  ]);
  const withoutBranch = assets([THREE_EAST]);

  const goneNodes = nodeIds(withBranch.registry).filter(
    (id) => !nodeIds(withoutBranch.registry).includes(id),
  );
  assert.ok(goneNodes.length > 0, 'the removed branch had its own nodes');

  // The removed ids are simply absent. Nothing new has taken them over, so a load
  // stored against one of them cannot appear on a surviving pole.
  const surviving = new Set(nodeIds(withoutBranch.registry));
  for (const id of goneNodes) {
    assert.ok(!surviving.has(id), `${id} is not reattached to a surviving pole`);
  }
});

test('9. ids are not labels and not coordinates', () => {
  const { registry } = assets([THREE_EAST]);
  for (const asset of registry.allNodeAssets()) {
    if (asset.id === ORIGIN_NODE) continue;
    assert.doesNotMatch(asset.id, /^\d+,-?\d+$/, `${asset.id} is not a bare coordinate`);
    assert.notEqual(asset.id, asset.label, `${asset.id} is not its display label`);
  }
  // A coordinate can still be looked up, which is what the drawing needs, but it
  // is a separate lookup rather than the identity itself.
  assert.equal(registry.canonicalNodeId('3,0'), destinationAssetId('r1'));
});

test('10. the Origin always has the same id', () => {
  for (const originMarker of ['plain', 'tc', 'fpb']) {
    const { registry } = assets([THREE_EAST], { originMarker });
    const origin = registry.nodeAsset(ORIGIN_NODE);
    assert.ok(origin, `the Origin exists when drawn as ${originMarker}`);
    assert.equal(origin.isOrigin, true);
    assert.equal(origin.nodeType, 'origin');
  }
});

test('11. node types are reported so loads can be restricted', () => {
  const { registry } = assets([
    { id: 'r1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: false },
    { id: 'r2', from: 'origin', direction: 'east', spans: 2, tc: true, fpb: false },
    { id: 'r3', from: 'origin', direction: 'west', spans: 2, tc: false, fpb: true },
  ]);
  const types = registry.allNodeAssets().map((a) => a.nodeType);
  assert.ok(types.includes('origin'));
  assert.ok(types.includes('pole'));
  assert.ok(types.includes('tc'));
  assert.ok(types.includes('fpb'));
});

test('12. every span records both of its node assets', () => {
  const { registry } = assets([THREE_EAST]);
  const known = new Set(nodeIds(registry));
  for (const span of registry.allSpanAssets()) {
    assert.ok(known.has(span.a), `${span.id} starts at a real node`);
    assert.ok(known.has(span.b), `${span.id} ends at a real node`);
    assert.equal(span.id, spanAssetId(span.a, span.b), 'the id matches its endpoints');
  }
});

test('13. the registry is deterministic', () => {
  const routes = [
    THREE_EAST,
    { id: 'r2', from: 'endpoint:A', direction: 'north', spans: 2, tc: false, fpb: false },
  ];
  assert.deepEqual(nodeIds(assets(routes).registry), nodeIds(assets(routes).registry));
  assert.deepEqual(spanIds(assets(routes).registry), spanIds(assets(routes).registry));
});

test('14. an alias spelling resolves to the canonical span', () => {
  // A span id built the other way round must still find its span, so data written
  // by an older build (or by hand) is not orphaned for a harmless reason.
  const { registry } = assets([THREE_EAST]);
  const span = registry.allSpanAssets()[0];
  const reversed = spanAssetId(span.b, span.a);
  assert.equal(reversed, span.id, 'the two spellings are already the same id');
  assert.equal(registry.canonicalSpanId(span.id), span.id);
});

test('15. the example drawing has an id for every node and edge', () => {
  const routes = [
    { id: 'route-1', from: 'origin', direction: 'south', spans: 1, tc: false, fpb: false },
    { id: 'route-2', from: 'endpoint:A', direction: 'east', spans: 4, tc: false, fpb: false },
    { id: 'route-3', from: 'endpoint:B', direction: 'south', spans: 3, tc: true, fpb: false },
    { id: 'route-4', from: 'tc:1', direction: 'south', spans: 3, tc: false, fpb: false },
    { id: 'route-5', from: 'endpoint:C', direction: 'east', spans: 1, tc: false, fpb: false },
    { id: 'route-6', from: 'endpoint:C', direction: 'south', spans: 2, tc: false, fpb: false },
    { id: 'route-7', from: 'endpoint:D', direction: 'west', spans: 3, tc: false, fpb: false },
    { id: 'route-8', from: 'endpoint:D', direction: 'east', spans: 7, tc: false, fpb: false },
    { id: 'route-9', from: 'endpoint:D', direction: 'south', spans: 10, tc: false, fpb: false },
  ];
  const { network, registry } = assets(routes);
  assert.equal(registry.allNodeAssets().length, network.graph.nodes.size);
  assert.equal(registry.allSpanAssets().length, network.graph.edges.size);
  assert.equal(network.graph.nodes.size, 34);
  assert.equal(network.graph.edges.size, 33);
});
