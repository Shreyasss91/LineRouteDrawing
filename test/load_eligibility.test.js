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
import {
  addLoad,
  insertLoadRecord,
  isLoadEligible,
  reassignLoad,
} from '../src/data/schedules.js';
import { parseProjectJson, serializeProjectJson } from '../src/ui/project.js';
import { applyNodeLoadPlan, parseNodeLoadImport } from '../src/data/schedule_io.js';

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

test('8. the shared CSV/clipboard import planner refuses a TC target', () => {
  const f = fixture();
  // CSV import and clipboard paste both go through `parseNodeLoadImport`, so this
  // exercises the real planner the two front ends share rather than a hand-built plan.
  const context = {
    loads: [],
    lookupNode: f.lookupNode,
    isEligible: (type) => isLoadEligible(type),
    mode: 'replace',
  };

  const csv = ['nodeid,value,unit', `${f.tc.id},10,kVA`].join('\n');
  const refused = parseNodeLoadImport(csv, context);
  assert.equal(refused.ok, false, 'the importer must refuse the row');
  assert.equal(refused.code, 'bad-value', 'a refused import reports a value-level failure');
  assert.match(refused.message, /nothing has been changed/i);
  assert.match((refused.details ?? []).join(' '), /tc point/i, 'the detail names the TC rule');
  assert.equal(refused.plan, undefined, 'no plan is produced for an invalid import');

  // Tab-separated paste takes the same route.
  const tsv = ['nodeid\tvalue\tunit', `${f.tc.id}\t10\tkVA`].join('\n');
  const refusedTsv = parseNodeLoadImport(tsv, context);
  assert.equal(refusedTsv.ok, false, 'the pasted form is refused too');
  assert.equal(refusedTsv.plan, undefined);

  // An eligible target is still accepted by the same planner, so the refusal is about
  // the target and not about importing in general.
  const good = ['nodeid,value,unit', `${f.pole.id},10,kVA`].join('\n');
  const accepted = parseNodeLoadImport(good, context);
  assert.equal(accepted.ok, true, 'an eligible target imports normally');
  assert.equal(accepted.plan.records.length, 1);
  assert.equal(accepted.plan.records[0].nodeId, f.pole.id);
});

test('9. the aliased spelling of a TC point is refused by the import planner', () => {
  const f = fixture();
  const tcKey = f.registry.nodeKeys.get(f.tc.id);
  assert.equal(f.registry.canonicalNodeId(tcKey), f.tc.id, 'the key resolves to the TC');
  // A coordinate key contains a comma (`2,-2`), so it can only survive as one field in
  // a tab-separated import. That is exactly the clipboard-paste shape.
  const tsv = ['nodeid\tvalue\tunit', `${tcKey}\t10\tkVA`].join('\n');
  const refused = parseNodeLoadImport(tsv, {
    loads: [],
    lookupNode: f.lookupNode,
    isEligible: (type) => isLoadEligible(type),
    mode: 'replace',
  });
  assert.equal(refused.ok, false, 'the alias is refused for ineligibility');
  assert.match(
    (refused.details ?? []).join(' '),
    /tc point/i,
    'refused because it is a TC, not because it was unrecognised',
  );
});

test('10. the raw applier trusts its plan, so the planner is the real boundary', () => {
  const f = fixture();
  // `applyNodeLoadPlan` is a pure applier with no registry, so by design it cannot
  // re-check eligibility. Recording that here stops a future change from removing the
  // upstream guard on the assumption that the applier catches it.
  const applied = applyNodeLoadPlan(
    [],
    { mode: 'replace', records: [{ id: 'load-1', nodeId: f.tc.id, value: 10, unit: 'kVA' }] },
    () => 'load-new',
  );
  assert.equal(applied.loads.length, 1, 'the applier trusts its validated plan');
});

test('11. an invalid load refuses the whole file and protects what is stored', () => {
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

test('12. an unknown node id is still accepted as unresolved, not refused as ineligible', () => {
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

test('13. the model fails closed when no resolver is supplied', () => {
  const f = fixture();
  // Omitting the resolver used to skip the eligibility check entirely, so a caller that
  // forgot it could create a load on a TC point. The check is now mandatory.
  const omitted = addLoad([], { nodeId: f.tc.id, value: 10, unit: 'kVA' });
  assert.equal(omitted.ok, false, 'a load cannot be created without a resolver');
  assert.equal(omitted.code, 'MISSING_NODE_RESOLVER');
  assert.equal(omitted.loads, undefined);
  assert.equal(omitted.record, undefined);

  // Not every non-function is a resolver either.
  for (const bogus of [null, undefined, 'lookup', 42, {}]) {
    const result = addLoad([], { nodeId: f.pole.id, value: 10, unit: 'kVA', lookupNode: bogus });
    assert.equal(result.ok, false, `lookupNode: ${JSON.stringify(bogus)} must fail closed`);
    assert.equal(result.code, 'MISSING_NODE_RESOLVER');
  }

  // The bypass is specifically that an eligible-looking id is not enough on its own.
  const noResolverPole = addLoad([], { nodeId: f.pole.id, value: 10, unit: 'kVA' });
  assert.equal(noResolverPole.ok, false, 'even an eligible id needs a resolver');
});

test('14. the model fails closed when the resolver cannot resolve the target', () => {
  const f = fixture();
  // A resolver that returns nothing tells us the id names no point, so eligibility
  // cannot be established and the operation must not proceed.
  const result = addLoad([], {
    nodeId: 'dst:does-not-exist',
    value: 10,
    unit: 'kVA',
    lookupNode: () => null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNRESOLVED_LOAD_TARGET');
  assert.equal(result.loads, undefined);

  // A resolver that returns something without a nodeType cannot prove eligibility.
  const noType = addLoad([], { nodeId: f.pole.id, value: 10, unit: 'kVA', lookupNode: () => ({}) });
  assert.equal(noType.ok, false, 'an unknown type is not treated as eligible');
  assert.equal(noType.code, 'INELIGIBLE_LOAD_TARGET');

  // The real resolver, for contrast, resolves it and accepts.
  const resolved = addLoad([], {
    nodeId: f.pole.id,
    value: 10,
    unit: 'kVA',
    lookupNode: f.lookupNode,
  });
  assert.equal(resolved.ok, true);
});

/* ---------------------------------------------------------------------------
 * Reassignment is the other way a load reaches a point.
 *
 * `addLoad()` was the obvious way to create this invalid state, but moving an existing
 * load is the same act one step later, and it was reproduced accepting a TC target:
 *
 *   reassignLoad([{ id, nodeId: <a pole>, value: 25, unit: 'kVA' }], id, <a TC>)
 *     -> { ok: true }, the load was on the triangle
 *
 * Guarding creation but not movement would have made the rule enforceable on one path
 * and bypassable on the other, so the guard and its error codes match `addLoad()`.
 * ------------------------------------------------------------------------- */

test('15. a load cannot be moved onto a TC point', () => {
  const f = fixture();
  const seeded = insertLoadRecord([], { nodeId: f.pole.id, value: 25, unit: 'kVA' }).loads;
  const moved = reassignLoad(seeded, seeded[0].id, f.tc.id, { lookupNode: f.lookupNode });

  assert.equal(moved.ok, false, 'moving onto a TC is refused');
  assert.equal(moved.code, 'INELIGIBLE_LOAD_TARGET');
  assert.equal(moved.loads, undefined, 'no replacement list is offered');

  // An alias of the same TC must be refused for ineligibility too, not waved through
  // because the resolver was handed a spelling it did not recognise.
  const aliased = reassignLoad(seeded, seeded[0].id, f.tc.coordKey, { lookupNode: f.lookupNode });
  assert.equal(aliased.ok, false, 'a coordinate spelling of the TC is also refused');
  assert.equal(aliased.code, 'INELIGIBLE_LOAD_TARGET');
});

test('16. a rejected reassignment leaves the input untouched', () => {
  const f = fixture();
  const seeded = insertLoadRecord([], { nodeId: f.pole.id, value: 25, unit: 'kVA' }).loads;
  const snapshot = JSON.stringify(seeded);

  const rejected = reassignLoad(seeded, seeded[0].id, f.tc.id, { lookupNode: f.lookupNode });
  assert.equal(rejected.ok, false);
  assert.equal(JSON.stringify(seeded), snapshot, 'the caller still holds the original list');
  assert.equal(seeded[0].nodeId, f.pole.id, 'the load is still on the pole');
});

test('17. reassignment to an eligible point keeps the record intact', () => {
  const f = fixture();
  const seeded = insertLoadRecord([], { nodeId: f.pole.id, value: 25, unit: 'kVA' }).loads;
  const before = seeded[0];

  for (const target of [f.origin, f.fpb]) {
    const moved = reassignLoad(seeded, before.id, target.id, { lookupNode: f.lookupNode });
    assert.equal(moved.ok, true, `moving to a ${target.nodeType} is allowed`);
    assert.equal(moved.loads[0].nodeId, target.id);
    assert.equal(moved.loads[0].id, before.id, 'the id is preserved');
    assert.equal(moved.loads[0].value, 25, 'the value is preserved');
    assert.equal(moved.loads[0].unit, 'kVA', 'the unit is preserved');
  }
});

test('18. reassignment fails closed without a usable resolver', () => {
  const f = fixture();
  const seeded = insertLoadRecord([], { nodeId: f.pole.id, value: 25, unit: 'kVA' }).loads;
  const id = seeded[0].id;

  for (const options of [undefined, {}, { lookupNode: null }, { lookupNode: 'nope' }]) {
    const result = reassignLoad(seeded, id, f.pole.id, options);
    assert.equal(result.ok, false, `refused for ${JSON.stringify(options)}`);
    assert.equal(result.code, 'MISSING_NODE_RESOLVER');
    assert.equal(result.loads, undefined);
  }

  // A resolver that names no point cannot prove eligibility either.
  const unresolved = reassignLoad(seeded, id, f.pole.id, { lookupNode: () => null });
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.code, 'UNRESOLVED_LOAD_TARGET');

  // A stale load id is its own failure, not an eligibility question.
  const stale = reassignLoad(seeded, 'load-999', f.pole.id, { lookupNode: f.lookupNode });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'UNKNOWN_LOAD');
});

/* ---------------------------------------------------------------------------
 * The import planner needs both capabilities to verify a target.
 *
 * It already refused to produce a plan without them, but by throwing a TypeError from
 * the middle of a row loop - a crash rather than a validation result a caller can show.
 * That is fail-closed in the sense that mattered (no unverified plan existed), and these
 * tests keep it that way while making the failure reportable.
 * ------------------------------------------------------------------------- */

test('19. the import planner refuses when it cannot check a target', () => {
  const text = 'nodeId,value,unit\ndst:route-1,25,kVA\n';
  const f = fixture();

  // Neither capability: nothing can be verified.
  const none = parseNodeLoadImport(text, {});
  assert.equal(none.ok, false);
  assert.equal(none.code, 'missing-capability');
  assert.equal(none.plan, undefined, 'no plan is produced');

  // A lookup without the eligibility rule can resolve a point but cannot judge it.
  const noRule = parseNodeLoadImport(text, { lookupNode: f.lookupNode });
  assert.equal(noRule.ok, false);
  assert.equal(noRule.code, 'missing-capability');
  assert.equal(noRule.plan, undefined);

  // The rule without a lookup cannot reach the point it would judge.
  const noLookup = parseNodeLoadImport(text, { isEligible: isLoadEligible });
  assert.equal(noLookup.ok, false);
  assert.equal(noLookup.code, 'missing-capability');
  assert.equal(noLookup.plan, undefined);

  // With both, the same text plans normally - so the guard is not an over-refusal.
  const verified = parseNodeLoadImport(text, {
    loads: [],
    lookupNode: f.lookupNode,
    isEligible: isLoadEligible,
  });
  assert.equal(verified.ok, true, 'a valid import still plans');

  // And with both, a TC target is still refused, which is the property that matters.
  const tcRow = `nodeId,value,unit\n${f.tc.id},25,kVA\n`;
  const refused = parseNodeLoadImport(tcRow, {
    loads: [],
    lookupNode: f.lookupNode,
    isEligible: isLoadEligible,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.plan, undefined);
});

test('20. a target whose type cannot be established is refused, consistently', () => {
  const f = fixture();
  const seeded = insertLoadRecord([], { nodeId: f.pole.id, value: 25, unit: 'kVA' }).loads;
  const id = seeded[0].id;

  // A resolver may return an object with no usable `nodeType`. That proves nothing about
  // eligibility, so it must land on the same code as an actively ineligible point, and
  // both operations must agree - a caller handling `addLoad()` and `reassignLoad()` with
  // one branch depends on it.
  for (const resolved of [{}, { nodeType: undefined }, { nodeType: null }, { nodeType: '' }]) {
    const moved = reassignLoad(seeded, id, f.pole.id, { lookupNode: () => resolved });
    assert.equal(moved.ok, false, `move refused for ${JSON.stringify(resolved)}`);
    assert.equal(moved.code, 'INELIGIBLE_LOAD_TARGET');

    const added = addLoad([], {
      nodeId: f.pole.id,
      value: 10,
      unit: 'kVA',
      lookupNode: () => resolved,
    });
    assert.equal(added.ok, false, `create refused for ${JSON.stringify(resolved)}`);
    assert.equal(added.code, moved.code, 'both operations report the same code');

    // The message must read as English rather than interpolating "undefined".
    assert.match(moved.message, /point whose type cannot be established/);
    assert.doesNotMatch(moved.message, /undefined/);
  }
});
