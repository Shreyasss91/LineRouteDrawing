/**
 * Origin-aware dropdown labels.
 *
 * The Origin is one node with one id, but it can be drawn as a plain pole, a TC
 * point or an FPB box. The dropdown used to call it "Origin" whatever the
 * drawing showed, so the list disagreed with the picture and a TC Origin could
 * not be told from a TC destination.
 *
 * These tests pin three things at once: the label follows the chosen symbol, the
 * internal identity never changes, and a route's reference to it survives.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  availableSources,
  endpointLabel,
  latestSource,
  sourcesForRow,
} from '../src/ui/state.js';
import { buildNetwork } from '../src/geometry/network.js';

const ORIGIN = { kind: 'origin', name: 'Origin' };

test('1. the Origin label names the symbol it is drawn as', () => {
  assert.equal(endpointLabel(ORIGIN, 'plain'), 'Origin (Pole)');
  assert.equal(endpointLabel(ORIGIN, 'tc'), 'Origin (TC point)');
  assert.equal(endpointLabel(ORIGIN, 'fpb'), 'Origin (FPB point)');
});

test('2. an unknown or missing marker falls back to the pole label', () => {
  assert.equal(endpointLabel(ORIGIN), 'Origin (Pole)');
  assert.equal(endpointLabel(ORIGIN, 'nonsense'), 'Origin (Pole)');
  assert.equal(endpointLabel(ORIGIN, undefined), 'Origin (Pole)');
});

test('3. the Origin keeps its internal identity whatever the label', () => {
  for (const originMarker of ['plain', 'tc', 'fpb']) {
    const network = buildNetwork(
      [{ id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: false, fpb: false }],
      { originMarker },
    );
    const origin = network.endpoints.find((e) => e.kind === 'origin');
    assert.equal(origin.id, 'origin', `${originMarker}: the id is still "origin"`);
    assert.equal(network.originMarker, originMarker);
  }
});

test('4. changing the Origin marker does not change route references', () => {
  let previousDestinations = null;
  for (const originMarker of ['plain', 'tc', 'fpb']) {
    const network = buildNetwork(
      [
        { id: 'r1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: false },
        { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 3, tc: false, fpb: false },
      ],
      { originMarker },
    );
    assert.equal(network.ok, true, `${originMarker}: the routes still resolve`);
    const destinations = network.routes.map((r) => r.destinationId);
    if (previousDestinations) {
      assert.deepEqual(destinations, previousDestinations, `${originMarker}: references unchanged`);
    }
    previousDestinations = destinations;
    // Both routes still start from the Origin as written.
    assert.equal(network.routes[0].sourceId, 'origin');
  }
});

test('5. the dropdown offers the Origin under the chosen label', () => {
  const routes = [{ id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: false, fpb: false }];
  for (const [originMarker, expected] of [
    ['plain', 'Origin (Pole)'],
    ['tc', 'Origin (TC point)'],
    ['fpb', 'Origin (FPB point)'],
  ]) {
    const sources = availableSources(routes, 1, { originMarker });
    const origin = sources.find((s) => s.id === 'origin');
    assert.ok(origin, `${originMarker}: the Origin is offered`);
    assert.equal(origin.label, expected);
  }
});

test('6. the label changes immediately when the marker changes', () => {
  const routes = [];
  const before = availableSources(routes, 0, { originMarker: 'plain' })[0];
  const after = availableSources(routes, 0, { originMarker: 'fpb' })[0];
  assert.equal(before.id, after.id, 'the same endpoint');
  assert.equal(before.label, 'Origin (Pole)');
  assert.equal(after.label, 'Origin (FPB point)');
});

test('7. a TC Origin is distinguishable from a TC destination', () => {
  const network = buildNetwork(
    [
      { id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: true, fpb: false },
    ],
    { originMarker: 'tc' },
  );
  const sources = availableSources(
    [{ id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: true, fpb: false }],
    1,
    { originMarker: 'tc' },
  );
  const labels = sources.map((s) => s.label);
  assert.ok(labels.includes('Origin (TC point)'), 'the Origin says it is a TC point');
  assert.ok(labels.includes('TC'), 'the TC destination is named TC');
  assert.notEqual('Origin (TC point)', 'TC');
  assert.equal(network.tcCount, 1, 'the destination is counted; the Origin is not');
});

test('8. an FPB Origin is distinguishable from an FPB destination', () => {
  const network = buildNetwork(
    [{ id: 'r1', from: 'origin', direction: 'east', spans: 1, tc: false, fpb: true }],
    { originMarker: 'fpb' },
  );
  const sources = availableSources(
    [{ id: 'r1', from: 'origin', direction: 'east', spans: 1, tc: false, fpb: true }],
    1,
    { originMarker: 'fpb' },
  );
  const labels = sources.map((s) => s.label);
  assert.ok(labels.includes('Origin (FPB point)'));
  assert.ok(labels.includes('FPB'));
  assert.equal(network.fpbCount, 1);
});

test('9. ordinary destinations keep their existing naming', () => {
  const routes = [
    { id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: false, fpb: false },
    { id: 'r2', from: 'origin', direction: 'east', spans: 1, tc: true, fpb: false },
    { id: 'r3', from: 'origin', direction: 'east', spans: 2, tc: true, fpb: false },
    { id: 'r4', from: 'origin', direction: 'north', spans: 1, tc: false, fpb: true },
    { id: 'r5', from: 'origin', direction: 'north', spans: 2, tc: false, fpb: true },
  ];
  const labels = availableSources(routes, routes.length, { originMarker: 'plain' }).map(
    (s) => s.label,
  );
  assert.ok(labels.includes('Origin (Pole)'));
  assert.ok(labels.includes('A'));
  assert.ok(labels.includes('TC1'));
  assert.ok(labels.includes('TC2'));
  assert.ok(labels.includes('FPB1'));
  assert.ok(labels.includes('FPB2'));
});

test('10. a route being edited keeps its own source while others change', () => {
  const routes = [
    { id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: false, fpb: false },
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 2, tc: false, fpb: false },
  ];
  // Editing row 2: it starts from A, and A must remain selectable.
  const sources = sourcesForRow(routes, 1, 'endpoint:A', { originMarker: 'fpb' });
  assert.ok(sources.some((s) => s.id === 'endpoint:A'), 'the current source is present');
  assert.equal(sources.find((s) => s.id === 'origin').label, 'Origin (FPB point)');
});

test('11. the preselected source carries the right Origin label', () => {
  for (const [originMarker, expected] of [
    ['plain', 'Origin (Pole)'],
    ['tc', 'Origin (TC point)'],
    ['fpb', 'Origin (FPB point)'],
  ]) {
    const source = latestSource([], { originMarker });
    assert.equal(source.id, 'origin');
    assert.equal(source.label, expected);
  }
});

test('12. a restored project shows the correct Origin label', () => {
  // What a reload does: the saved originMarker is applied, then the dropdown is
  // rebuilt from the restored routes.
  const restored = {
    routes: [
      { id: 'route-1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: false },
      { id: 'route-2', from: 'endpoint:A', direction: 'east', spans: 2, tc: true, fpb: false },
    ],
    originMarker: 'fpb',
  };
  const sources = availableSources(restored.routes, restored.routes.length, {
    originMarker: restored.originMarker,
  });
  assert.equal(sources.find((s) => s.id === 'origin').label, 'Origin (FPB point)');
  // The route that starts from the Origin still names it correctly.
  const first = sources.find((s) => s.id === 'origin');
  assert.equal(restored.routes[0].from, first.id);
});

test('13. the dropdown never offers an endpoint the engine would reject', () => {
  const routes = [
    { id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: false, fpb: false },
    { id: 'r2', from: 'origin', direction: 'east', spans: 1, tc: false, fpb: false },
  ];
  // At index 1 exactly one earlier route exists, so the Origin and that route's
  // destination are available, and nothing from later rows is.
  const sources = availableSources(routes, 1, { originMarker: 'tc' });
  assert.deepEqual(sources.map((s) => s.id), ['origin', 'endpoint:A']);
  assert.ok(!sources.some((s) => s.id === 'endpoint:B'), 'a later endpoint is not offered');

  // Every offered source is one the engine actually accepts at that position.
  const prefix = buildNetwork(routes.slice(0, 1), { originMarker: 'tc' });
  const valid = new Set(prefix.endpoints.map((e) => e.id));
  for (const source of sources) {
    assert.ok(valid.has(source.id), `${source.id} is a real endpoint at that position`);
  }
});
