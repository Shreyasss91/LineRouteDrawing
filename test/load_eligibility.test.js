/**
 * A load may not be recorded on a TC point.
 *
 * A TC point is a test point, not a load-bearing asset. The rule predates this
 * file: `isLoadEligible('tc') === false`, and the schedule importer and the
 * point pickers both consult it. Two boundaries did not, and were reproduced
 * accepting the invalid state:
 *
 *   addLoad([], { nodeId: <a TC>, value: 10, unit: 'kVA' })
 *     -> { ok: true }, record created
 *   parseProjectJson(<project with a load on a TC node>)
 *     -> { ok: true }, load kept
 *
 * So a hand-edited project could put a number on a TC triangle and the
 * annotation layer would draw it. These tests pin the refusal at both
 * boundaries, and pin that every eligible target is still accepted, because the
 * risk of enforcing a rule is over-enforcing it.
 *
 * Identity is resolved through the asset registry, never by reading the id text,
 * so an alias or a coordinate spelling cannot slip past the check. The case that
 * makes this matter is the aliased node: the same physical point is reachable
 * under more than one accepted spelling, and a text check would miss the second.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAssetRegistry } from '../src/geometry/assets.js';
import { buildNetwork } from '../src/geometry/network.js';
import { addLoad, isLoadEligible } from '../src/data/schedules.js';
import { parseProjectJson, serializeProjectJson } from '../src/ui/project.js';
import { applyNodeLoadPlan } from '../src/data/schedule_io.js';

const FIXED_DATE = new Date('2026-07-08T09:10:11.000Z');

/** A drawing with an ordinary pole, an FPB destination and a TC destination. */
function fixture(originMarker = 'plain') {
  const routes = [
    { id: 'route-1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: false },
    { id: 'route-2', from: 'endpoint:A', direction: 'east', spans: 2, tc: true, fpb: false },
    { id: 'route-3', from: 'endpoint:A', direction: 'south', spans: 2, tc: false, fpb: true },
  ];
  const network = buildNetwork(routes, { originMarker });
  assert.ok(network.ok, 'the fixture routes must resolve');
  const registry = buildAssetRegistry(network);
  const find = (nodeType) => {
    const asset = registry.allNodeAssets().find((a) => a.nodeType === nodeType);
    assert.ok(asset, `the fixture has a ${nodeType}`);
    return asset;
  };
  const lookupNode = (id) => registry.nodeAsset(registry.canonicalNodeId(id) ?? id);
  return {
    routes,
    originMarker,
    network,
    registry,
    lookupNode,
    pole: find('pole'),
    fpb: find('fpb'),
    tc: find('tc'),
    origin: find('origin'),
  };
}

/** A project document for the fixture, with the given loads. */
function documentWith(loads, originMarker = 'plain') {
  const f = fixture(originMarker);
  const json = serializeProjectJson(
    {
      routes: f.routes,
      originMarker,
      spanLength: 40,
      layout: 'a4_landscape',
      loads,
      spanLengths: {},
      loadPlacements: {},
      spanPlacements: {},
      nodeDesignations: {},
      exportLoads: true,
      exportLengths: true,
    },
    { now: FIXED_DATE },
  );
  return JSON.parse(json);
}

test('1. the model refuses a load on a TC point', () => {
  const f = fixture();
  const result = addLoad([], { nodeId: f.tc.id, value: 10, unit: 'kVA', lookupNode: f.lookupNode });
  assert.equal(result.ok, false, 'a load on a TC point must be refused');
  assert.equal(result.code, 'INELIGIBLE_LOAD_TARGET');
  assert.match(result.message, /tc point/i);
  assert.equal(result.loads, undefined, 'a refusal carries no new list');
  assert.equal(result.record, undefined, 'a refusal creates no record');
});

test('2. a refused load leaves the existing collection untouched', () => {
  const f = fixture();
  const existing = [{ id: 'load-1', nodeId: f.pole.id, value: 25, unit: 'kVA' }];
  const before = structuredClone(existing);
  const result = addLoad(existing, {
    nodeId: f.tc.id,
    value: 10,
    unit: 'kVA',
    lookupNode: f.lookupNode,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(existing, before, 'the input list is not mutated');
  assert.equal(existing.length, 1, 'nothing was appended');
});

test('3. the parser refuses a project that carries a load on a TC point', () => {
  const f = fixture();
  const document = documentWith([{ id: 'load-1', nodeId: f.tc.id, value: 10, unit: 'kVA' }]);
  const parsed = parseProjectJson(JSON.stringify(document));
  assert.equal(parsed.ok, false, 'the file must be refused');
  assert.equal(parsed.code, 'INELIGIBLE_LOAD_TARGET');
  assert.match(parsed.message, /cannot be opened/i);
  assert.match(parsed.message, /load-1/, 'the message names the offending record');
  assert.equal(parsed.project, undefined, 'nothing is returned to apply');
});

test('4. a TC Origin keeps the Origin eligible, and its own symbol is not a TC node', () => {
  const f = fixture('tc');
  // Choosing a TC symbol for the Origin does not turn the Origin into a TC point:
  // it stays `origin`, which is load-eligible.
  assert.equal(f.origin.nodeType, 'origin');
  assert.equal(isLoadEligible(f.origin.nodeType), true);
  const result = addLoad([], {
    nodeId: f.origin.id,
    value: 40,
    unit: 'kVA',
    lookupNode: f.lookupNode,
  });
  assert.equal(result.ok, true, 'an Origin drawn as a TC still takes a load');
});

test('5. ordinary poles remain eligible', () => {
  const f = fixture();
  const result = addLoad([], {
    nodeId: f.pole.id,
    value: 25,
    unit: 'kW',
    lookupNode: f.lookupNode,
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.nodeId, f.pole.id);
  assert.equal(result.record.unit, 'kW');
  assert.equal(result.loads.length, 1);
});

test('6. eligible FPB and Origin configurations are still accepted', () => {
  for (const originMarker of ['plain', 'tc', 'fpb']) {
    const f = fixture(originMarker);
    for (const asset of [f.pole, f.fpb, f.origin]) {
      const result = addLoad([], {
        nodeId: asset.id,
        value: 12,
        unit: 'kVA',
        lookupNode: f.lookupNode,
      });
      assert.equal(
        result.ok,
        true,
        `${asset.nodeType} must accept a load when the Origin is ${originMarker}`,
      );
    }
  }
});

test('7. eligibility is decided by canonical identity, not by the id text', () => {
  const f = fixture();
  const network = f.network;
  const graph = network.graph;

  // Find a coordinate key the registry also accepts for the TC node, which is the
  // alternative spelling `canonicalNodeId` resolves. This is the alias case: the
  // same physical point under a second accepted id.
  const tcKey = f.registry.nodeKeys.get(f.tc.id);
  assert.ok(tcKey, 'the TC node has a coordinate key');
  assert.notEqual(tcKey, f.tc.id, 'the coordinate key is a different spelling');
  assert.equal(f.registry.canonicalNodeId(tcKey), f.tc.id, 'both spell it to one node');

  // The graph really does hold that node, so this is a genuine alias and not a
  // made-up string.
  const node = graph.nodes.get(tcKey);
  assert.ok(node, 'the coordinate key names a real graph node');

  const viaAlias = addLoad([], {
    nodeId: tcKey,
    value: 10,
    unit: 'kVA',
    lookupNode: f.lookupNode,
  });
  assert.equal(viaAlias.ok, false, 'the aliased spelling is refused too');
  assert.equal(viaAlias.code, 'INELIGIBLE_LOAD_TARGET');

  // And the parser refuses it when the file uses the alias.
  const document = documentWith([{ id: 'load-1', nodeId: tcKey, value: 10, unit: 'kVA' }]);
  const parsed = parseProjectJson(JSON.stringify(document));
  assert.equal(parsed.ok, false, 'the parser refuses the aliased spelling as well');
  assert.equal(parsed.code, 'INELIGIBLE_LOAD_TARGET');
});

test('8. the schedule import and apply path cannot introduce a TC load', () => {
  const f = fixture();
  // The importer refuses the row before a plan exists, so a TC target never
  // reaches `applyNodeLoadPlan` through the supported import path.
  const document = documentWith([{ id: 'load-1', nodeId: f.tc.id, value: 10, unit: 'kVA' }]);
  assert.equal(parseProjectJson(JSON.stringify(document)).code, 'INELIGIBLE_LOAD_TARGET');

  // `applyNodeLoadPlan` is a pure applier and deliberately does not re-check, so
  // the guard has to be upstream - which is what the assertions above establish.
  // Recording that contract here stops a future change from removing the upstream
  // guard on the assumption that the applier catches it.
  const applied = applyNodeLoadPlan([], {
    mode: 'replace',
    records: [{ id: 'load-1', nodeId: f.tc.id, value: 10, unit: 'kVA' }],
  }, () => 'load-new');
  assert.equal(applied.loads.length, 1, 'the applier trusts its validated plan');
});

test('9. an invalid load refuses the whole file and protects what is stored', () => {
  const f = fixture();
  // One good load and one on a TC: the good one must not be applied either, and
  // the project must not be returned in any partially fixed-up form.
  const document = documentWith([
    { id: 'load-1', nodeId: f.pole.id, value: 25, unit: 'kVA' },
    { id: 'load-2', nodeId: f.tc.id, value: 10, unit: 'kVA' },
  ]);
  const parsed = parseProjectJson(JSON.stringify(document));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'INELIGIBLE_LOAD_TARGET');
  assert.equal(parsed.project, undefined, 'all-or-nothing: no partial project');
  assert.equal(parsed.warnings, undefined, 'no warnings are issued for a refusal');

  // The offending record is named but not quietly dropped: the file is refused, so
  // the caller keeps whatever it had.
  assert.match(parsed.message, /load-2/);
});

test('10. an unknown node id is still accepted as unresolved, not refused as ineligible', () => {
  const f = fixture();
  // A load pointing at a point the drawing no longer has is the user's data and is
  // kept for reassignment. Only a *live* TC point refuses the file.
  const document = documentWith([{ id: 'load-1', nodeId: 'dst:route-99', value: 10, unit: 'kVA' }]);
  const parsed = parseProjectJson(JSON.stringify(document));
  assert.equal(parsed.ok, true, 'an orphan load does not refuse the file');
  assert.equal(parsed.project.loads.length, 1);
  assert.equal(parsed.project.loads[0].nodeId, 'dst:route-99');
  assert.ok(
    parsed.warnings.some((w) => /no longer has/.test(w)),
    'the orphan is reported as a warning',
  );
});
