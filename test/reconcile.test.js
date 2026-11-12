/**
 * Reconciliation: what happens to recorded data when the route changes.
 *
 * The rule under test is that nothing recorded is ever silently lost or silently
 * moved. A deleted branch leaves its loads and lengths attached to ids that no
 * longer exist; those records are reported as unresolved and stay in the data until
 * a person reassigns or discards them. The failure this prevents is a load quietly
 * appearing on a different pole, which would make the drawing state something that
 * was never surveyed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNetwork } from '../src/geometry/network.js';
import { buildAssetRegistry, reconcile } from '../src/geometry/assets.js';
import { createLoadSchedule, createSpanLengths, insertLoadRecord, setSpanLength } from '../src/data/schedules.js';

const MAIN = [
  { id: 'route-1', from: 'origin', direction: 'east', spans: 3, tc: false, fpb: false },
  { id: 'route-2', from: 'endpoint:A', direction: 'north', spans: 3, tc: false, fpb: false },
];

/** Registry for a route list. */
function registryFor(routes) {
  return buildAssetRegistry(buildNetwork(routes, {}));
}

test('1. deleting a branch leaves its loads unresolved, not reassigned', () => {
  const withBranch = registryFor(MAIN);
  // A load on a pole that only the north branch creates.
  const branchNode = withBranch.allNodeAssets().find((a) => a.id.startsWith('mid:route-2:'));
  assert.ok(branchNode, 'the branch has its own pole');

  const loads = insertLoadRecord(createLoadSchedule(), { nodeId: branchNode.id, value: 25 }).loads;

  // Remove the branch.
  const without = registryFor([MAIN[0]]);
  const result = reconcile(without, loads, []);
  assert.equal(result.unresolvedLoads.length, 1, 'the load is reported as unresolved');
  assert.equal(result.unresolvedLoads[0].value, 25, 'and its value is intact');
  assert.equal(result.unresolvedLoads[0].nodeId, branchNode.id, 'its target is unchanged');
});

test('2. an unrelated edit leaves every record resolved', () => {
  const before = registryFor(MAIN);
  const loads = insertLoadRecord(createLoadSchedule(), {
    nodeId: before.allNodeAssets()[1].id,
    value: 10,
  }).loads;

  // Append a branch somewhere else entirely.
  const after = registryFor([
    ...MAIN,
    { id: 'route-3', from: 'endpoint:B', direction: 'south', spans: 2, tc: false, fpb: false },
  ]);
  const result = reconcile(after, loads, []);
  assert.equal(result.unresolvedLoads.length, 0, 'nothing became unresolved');
});

test('3. a removed span length is reported, and its value survives', () => {
  const before = registryFor(MAIN);
  const span = before.allSpanAssets().find((s) => s.a.startsWith('mid:route-2') || s.b.startsWith('mid:route-2'));
  assert.ok(span, 'the branch has a span of its own');

  const lengths = setSpanLength(createSpanLengths(), span.id, 32.5).spanLengths;
  const after = registryFor([MAIN[0]]);
  const result = reconcile(after, [], [...lengths.values()]);
  assert.equal(result.unresolvedSpans.length, 1);
  assert.equal(result.unresolvedSpans[0].lengthM, 32.5);
});

test('4. a load on a shared pole is not orphaned when its own branch goes', () => {
  // The junction is kept by the surviving route, so its id is still live.
  const before = registryFor(MAIN);
  const junction = before.allNodeAssets().find((a) => a.id === 'dst:route-1');
  assert.ok(junction);

  const loads = insertLoadRecord(createLoadSchedule(), { nodeId: junction.id, value: 15 }).loads;
  const after = registryFor([MAIN[0]]);
  const result = reconcile(after, loads, []);
  assert.equal(result.unresolvedLoads.length, 0, 'the surviving pole still owns the record');
});

test('5. reconciliation never reports a record as resolved by coincidence', () => {
  // Replacing the whole drawing with a different one must not make the old
  // records look valid just because some new node exists.
  const before = registryFor(MAIN);
  const loads = insertLoadRecord(createLoadSchedule(), { nodeId: 'dst:route-2', value: 20 }).loads;

  const other = registryFor([
    { id: 'route-9', from: 'origin', direction: 'west', spans: 4, tc: false, fpb: false },
  ]);
  const result = reconcile(other, loads, []);
  assert.equal(result.unresolvedLoads.length, 1, 'the record is unresolved on a different drawing');
});

test('6. everything resolves again when the branch is re-added', () => {
  // The route ids are what make this work: restoring the same instructions
  // recreates the same asset ids, so the record finds its pole again.
  const before = registryFor(MAIN);
  const target = before.allNodeAssets().find((a) => a.id === 'mid:route-2:1');
  const loads = insertLoadRecord(createLoadSchedule(), { nodeId: target.id, value: 12 }).loads;

  const gone = reconcile(registryFor([MAIN[0]]), loads, []);
  assert.equal(gone.unresolvedLoads.length, 1);

  const restored = reconcile(registryFor(MAIN), loads, []);
  assert.equal(restored.unresolvedLoads.length, 0, 're-adding the branch resolves it again');
});

test('7. an empty drawing orphans every record rather than dropping them', () => {
  const before = registryFor(MAIN);
  let loads = createLoadSchedule();
  loads = insertLoadRecord(loads, { nodeId: 'dst:route-1', value: 5 }).loads;
  loads = insertLoadRecord(loads, { nodeId: 'dst:route-2', value: 6 }).loads;

  const result = reconcile(registryFor([]), loads, []);
  assert.equal(result.unresolvedLoads.length, 2, 'both are kept and reported');
});
