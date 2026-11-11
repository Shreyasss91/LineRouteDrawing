/**
 * Network point designations and span display identifiers.
 *
 * Two properties carry the weight here:
 *
 *   - A designation names a physical pole, and the sequence it comes from continues
 *     across every branch leaving that pole. A branch that restarted at 1 would make
 *     `A1` mean two different poles in one schedule.
 *   - A designation is a name, not an identity. Nothing in the store may key on it,
 *     because a name can be re-rendered and an identity must not.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNetwork } from '../src/geometry/network.js';
import { buildAssetRegistry } from '../src/geometry/assets.js';
import {
  allocateDesignations,
  countersFromDesignations,
  intermediateDesignation,
  isPoleDesignation,
  spanDesignation,
  splitDesignation,
  usesSpecialSeparator,
} from '../src/geometry/designations.js';

/** Build a network and name it. */
function named(routes) {
  const network = buildNetwork(routes, {});
  const allocation = allocateDesignations(network);
  const registry = buildAssetRegistry(network, { designations: allocation.nodeDesignations });
  return { network, allocation, registry };
}

/** The designation of every pole (intermediate or destination) in draw order. */
function poleDesignations(routes) {
  const { allocation } = named(routes);
  return [...allocation.nodeDesignations.entries()]
    .filter(([id]) => id.startsWith('mid:') || id.startsWith('dst:'))
    .map(([, designation]) => designation)
    .sort();
}

const ORIGIN_TO_A = { id: 'route-1', from: 'origin', direction: 'south', spans: 1 };

test('the Origin\'s own poles read Origin:1, Origin:2', () => {
  const names = poleDesignations([{ id: 'r1', from: 'origin', direction: 'east', spans: 4 }]);
  assert.deepEqual(names, ['A', 'Origin:1', 'Origin:2', 'Origin:3']);
});

test('poles after A read A1, A2', () => {
  const names = poleDesignations([ORIGIN_TO_A, { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 4 }]);
  assert.deepEqual(names, ['A', 'A1', 'A2', 'A3', 'B']);
});

test('a fourth span to an existing point still draws three poles', () => {
  // Four spans between two named points: the two ends are already named, so the
  // count of new poles is the span count minus one.
  const names = poleDesignations([ORIGIN_TO_A, { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 4 }]);
  assert.equal(names.filter((n) => n.startsWith('A') && n !== 'A').length, 3);
});

test('numbering continues across branches from the same source', () => {
  // Three branches leaving A in directions that share no interior pole with each
  // other, so every pole is new and the count is exact. A shared pole keeps the
  // first name it was given and consumes no second number, which is why the
  // branches here are kept apart in this test.
  const names = poleDesignations([
    ORIGIN_TO_A,
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 4 },
    { id: 'r3', from: 'endpoint:A', direction: 'west', spans: 4 },
    { id: 'r4', from: 'endpoint:A', direction: 'south', spans: 2 },
  ]);
  const a = names.filter((n) => /^A\d+$/.test(n));
  // Two branches create three poles each and one creates one: A1..A7, never a
  // restart at A1.
  assert.deepEqual(a, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
});

test('a branch that walks back through a named point names no pole there', () => {
  // A -> north passes back through the Origin, which already has a name. That pole
  // keeps its name, so the branch produces one fewer new designation than its span
  // count suggests. Naming it twice would give one physical pole two names.
  const names = poleDesignations([
    ORIGIN_TO_A,
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 4 },
    { id: 'r3', from: 'endpoint:A', direction: 'north', spans: 4 },
  ]);
  assert.equal(new Set(names).size, names.length, 'no pole is named twice');
  // A1..A3 from the east branch; the north branch names only the poles past the
  // Origin, which are new.
  assert.ok(names.includes('A1'));
  assert.ok(names.includes('A4'));
  assert.equal(names.includes('Origin'), false, 'the Origin is not re-designated as a pole');
});

test('a branch from C has its own independent sequence', () => {
  // B -> north leaves from B, so its poles belong to the B sequence and the C point
  // it creates starts a fresh one that nothing else shares.
  const names = poleDesignations([
    ORIGIN_TO_A,
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 4 },
    { id: 'r3', from: 'endpoint:B', direction: 'north', spans: 4 },
    { id: 'r4', from: 'endpoint:C', direction: 'east', spans: 4 },
  ]);
  assert.deepEqual(names.filter((n) => /^B\d+$/.test(n)), ['B1', 'B2', 'B3']);
  assert.deepEqual(names.filter((n) => /^C\d+$/.test(n)), ['C1', 'C2', 'C3']);
});

test('every drawn pole gets exactly one designation', () => {
  const { allocation, registry } = named([ORIGIN_TO_A, { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 4 }]);
  for (const asset of registry.allNodeAssets()) {
    assert.ok(allocation.nodeDesignations.has(asset.id), `${asset.id} has a designation`);
  }
  const values = [...allocation.nodeDesignations.entries()]
    .filter(([id]) => registry.allNodeAssets().some((a) => a.id === id))
    .map(([, name]) => name);
  assert.equal(new Set(values).size, values.length, 'no two physical poles share a designation');
});

test('a shared intersection keeps the first pole\'s designation', () => {
  // Two routes that cross at one point must produce one pole with one name.
  const { allocation, registry } = named([
    ORIGIN_TO_A,
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 4 },
    { id: 'r3', from: 'endpoint:A', direction: 'north', spans: 4 },
    { id: 'r4', from: 'endpoint:C', direction: 'west', spans: 4 },
  ]);
  const values = [...allocation.nodeDesignations.entries()]
    .filter(([id]) => id.startsWith('mid:'))
    .map(([, name]) => name);
  assert.equal(new Set(values).size, values.length, 'one name per pole, however many routes cross it');
  assert.ok(registry.allNodeAssets().length > 0);
});

test('a TC point is named TC and its poles take the colon form', () => {
  const names = poleDesignations([
    ORIGIN_TO_A,
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 2, tc: true },
    { id: 'r3', from: 'tc:1', direction: 'north', spans: 3 },
  ]);
  assert.deepEqual(names.filter((n) => n.startsWith('TC')), ['TC', 'TC:1', 'TC:2']);
});

test('two TCs are TC1 and TC2, and their poles stay distinguishable', () => {
  // Each TC branches in a direction of its own, so every pole past it is new and
  // takes a numbered name in that TC's own sequence.
  const names = poleDesignations([
    ORIGIN_TO_A,
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 2, tc: true },
    { id: 'r3', from: 'endpoint:A', direction: 'west', spans: 2, tc: true },
    { id: 'r4', from: 'tc:1', direction: 'north', spans: 3 },
    { id: 'r5', from: 'tc:2', direction: 'south', spans: 3 },
  ]);
  assert.ok(names.includes('TC1'));
  assert.ok(names.includes('TC2'));
  // TC1 is the point; TC1:1 is a pole beside it. The colon is what keeps them apart,
  // and it is why a pole can never be mistaken for the point it grew out of.
  assert.ok(names.includes('TC1:1'));
  assert.ok(names.includes('TC1:2'));
  assert.ok(names.includes('TC2:1'));
  assert.ok(names.includes('TC2:2'));
  assert.equal(new Set(names).size, names.length);
});

test('FPB poles take FPB1:1', () => {
  const names = poleDesignations([
    ORIGIN_TO_A,
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 2, fpb: true },
    { id: 'r3', from: 'fpb:1', direction: 'north', spans: 3 },
  ]);
  // A lone FPB displays as FPB, so its poles are FPB:1, FPB:2.
  assert.deepEqual(names.filter((n) => n.startsWith('FPB')), ['FPB', 'FPB:1', 'FPB:2']);
});

test('two FPBs are FPB1 and FPB2 with distinguishable poles', () => {
  const names = poleDesignations([
    ORIGIN_TO_A,
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 2, fpb: true },
    { id: 'r3', from: 'endpoint:A', direction: 'west', spans: 2, fpb: true },
    { id: 'r4', from: 'fpb:1', direction: 'north', spans: 3 },
  ]);
  assert.ok(names.includes('FPB1'));
  assert.ok(names.includes('FPB1:1'));
  assert.ok(names.includes('FPB2'));
  assert.equal(new Set(names).size, names.length);
});

test('a designation survives a reload unchanged', () => {
  const routes = [ORIGIN_TO_A, { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 4 }];
  const first = named(routes).allocation;
  // Feed the stored designations back in, as a project does on reload.
  const second = allocateDesignations(buildNetwork(routes, {}), {
    nodeDesignations: first.nodeDesignations,
    counters: first.counters,
  });
  assert.deepEqual([...second.nodeDesignations.entries()], [...first.nodeDesignations.entries()]);
});

test('a stored designation is never handed to a new pole', () => {
  // A project that remembers A1 and A2 must continue at A3, not reissue A1.
  const stored = new Map([['mid:old:0', 'A1'], ['mid:old:1', 'A2']]);
  const counters = countersFromDesignations(stored.values());
  assert.equal(counters.get('A'), 3);
});

test('an unrelated edit does not renumber the poles that remain', () => {
  const routes = [
    ORIGIN_TO_A,
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 4 },
    { id: 'r3', from: 'endpoint:B', direction: 'north', spans: 3 },
  ];
  const before = named(routes).allocation.nodeDesignations;
  // Drop the last branch; the poles of the first two keep their names.
  const after = named(routes.slice(0, 2)).allocation.nodeDesignations;
  for (const [id, name] of after) {
    if (before.has(id)) assert.equal(name, before.get(id), id + ' kept ' + name);
  }
});

// ---- span display identifiers ----

test('span names read from one designation to the other', () => {
  assert.equal(spanDesignation('Origin', 'Origin:1'), 'Origin\u2013Origin:1');
  assert.equal(spanDesignation('Origin:1', 'Origin:2'), 'Origin:1\u2013Origin:2');
  assert.equal(spanDesignation('A', 'A1'), 'A\u2013A1');
  assert.equal(spanDesignation('A1', 'A2'), 'A1\u2013A2');
  assert.equal(spanDesignation('A2', 'B'), 'A2\u2013B');
  assert.equal(spanDesignation('C', 'C1'), 'C\u2013C1');
  assert.equal(spanDesignation('FPB1', 'FPB1:1'), 'FPB1\u2013FPB1:1');
});

test('a drawn span is named in the direction it was first drawn', () => {
  // Three spans from the Origin so there is a pole Origin:1 between it and A, and the
  // first span of the cable reads from the Origin outwards.
  const { registry } = named([{ id: 'r1', from: 'origin', direction: 'east', spans: 3 }]);
  const first = registry.allSpanAssets().find((s) => s.fromDesignation === 'Origin');
  assert.ok(first, 'the Origin has a first span');
  assert.equal(first.designation, 'Origin\u2013Origin:1');
  // The cable reads as one run, not as three unrelated names.
  const names = registry.allSpanAssets().map((s) => s.designation).sort();
  assert.deepEqual(
    names,
    ['Origin:2\u2013A', 'Origin\u2013Origin:1', 'Origin:1\u2013Origin:2'].sort(),
  );
});

test('an overlapping span walked backwards keeps its id and its direction', () => {
  // A route east, then a route that walks back along the same cable, and a third that
  // walks it forwards again. All three describe one cable, so there is one span per
  // unit edge with one name each, oriented as the first walk laid it down.
  const { registry } = named([
    ORIGIN_TO_A,
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 3 },
    { id: 'r3', from: 'endpoint:B', direction: 'west', spans: 3 },
    { id: 'r4', from: 'endpoint:A', direction: 'east', spans: 3 },
  ]);
  const spans = registry.allSpanAssets();
  const names = spans.map((s) => s.designation);
  assert.equal(new Set(names).size, names.length, 'no duplicate span names');
  // Three unit spans were walked three times, plus the one span from the Origin to A,
  // so there are exactly four spans rather than nine.
  assert.equal(spans.length, 4);
  // The first walk went east from A, so every eastbound name starts at the A end of
  // its cable and none of them is a mirrored duplicate.
  assert.deepEqual(
    names.sort(),
    ['A1\u2013A2', 'A2\u2013B', 'A\u2013A1', 'Origin\u2013A'].sort(),
  );
});

test('a span name follows its poles and never becomes an id', () => {
  const { registry } = named([ORIGIN_TO_A, { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 3 }]);
  for (const span of registry.allSpanAssets()) {
    assert.match(span.id, /~/, 'the id is the asset pair, not the readable name');
    assert.match(span.designation, /\u2013/, 'the name uses the display separator');
    assert.notEqual(span.id, span.designation);
  }
});

// ---- helpers ----

test('a colon marks the special sources only', () => {
  assert.equal(usesSpecialSeparator('Origin', 'origin'), true);
  assert.equal(usesSpecialSeparator('TC1', 'tc'), true);
  assert.equal(usesSpecialSeparator('FPB2', 'fpb'), true);
  assert.equal(usesSpecialSeparator('A', 'endpoint'), false);
  assert.equal(intermediateDesignation('A', 'endpoint', 3), 'A3');
  assert.equal(intermediateDesignation('Origin', 'origin', 2), 'Origin:2');
  assert.equal(intermediateDesignation('TC1', 'tc', 1), 'TC1:1');
});

test('a designation splits back into its source and number', () => {
  assert.deepEqual(splitDesignation('A12'), { sourceName: 'A', ordinal: 12 });
  assert.deepEqual(splitDesignation('Origin:3'), { sourceName: 'Origin', ordinal: 3 });
  assert.equal(splitDesignation('A'), null, 'a named point is not a pole sequence');
  assert.equal(splitDesignation(''), null);
});

test('a named point is not mistaken for a pole', () => {
  assert.equal(isPoleDesignation('A1', ['A', 'B']), true);
  assert.equal(isPoleDesignation('A', ['A', 'B']), false);
  assert.equal(isPoleDesignation('Origin', ['Origin']), false);
  assert.equal(isPoleDesignation('Origin:1', ['Origin']), true);
});
