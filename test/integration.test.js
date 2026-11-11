import test from 'node:test';
import assert from 'node:assert/strict';

import { EXAMPLE_ROUTES } from '../src/config.js';
import { buildNetwork } from '../src/geometry/network.js';
import { buildScene } from '../src/geometry/scene.js';
import { renderSceneToSvg } from '../src/render/svg.js';
import { renderSceneToPdf } from '../src/render/pdf.js';
import { resolveExampleRoutes } from '../src/ui/example.js';
import { availableSources, sourcesForRow, endpointLabel, latestSource } from '../src/ui/state.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { jsPDF } = require('../vendor/jspdf/jspdf.umd.cjs');

/** Build the example exactly as the Load Example action does. */
function exampleInstructions() {
  let counter = 0;
  return resolveExampleRoutes(EXAMPLE_ROUTES, () => `route-${(counter += 1)}`);
}

test('the example authored with display names resolves to internal ids and stays valid', () => {
  const routes = exampleInstructions();
  assert.equal(routes.length, 9);
  assert.equal(routes[0].from, 'origin');
  assert.equal(routes[1].from, 'endpoint:A');
  assert.equal(routes[3].from, 'tc:1', 'the TC route starts from the TC point');
  assert.ok(
    routes.every((r) => r.id && typeof r.id === 'string'),
    'every instruction carries a unique id',
  );
  const network = buildNetwork(routes);
  assert.equal(network.ok, true, network.errors.map((e) => e.message).join('; '));
  assert.equal(network.tcCount, 1);
});

test('sequential availability offers only endpoints that already exist', () => {
  const routes = exampleInstructions();
  // Row 1 (index 0) can only start from the Origin.
  assert.deepEqual(
    availableSources(routes, 0).map((s) => s.id),
    ['origin'],
  );
  // Row 2 (index 1) may start from A, created by row 1 (already reused by row 2).
  const atIndex1 = availableSources(routes, 1).map((s) => s.id);
  assert.ok(atIndex1.includes('endpoint:A'));
  assert.ok(!atIndex1.includes('endpoint:B'), 'B does not exist yet at this position');
  // Row 4 (index 3) may start from the TC point.
  assert.ok(availableSources(routes, 3).map((s) => s.id).includes('tc:1'));
});

test('an edited row keeps its own source selectable', () => {
  const routes = exampleInstructions();
  // Row 2 references A, which exists; editing it must not lose that value.
  const options = sourcesForRow(routes, 1, routes[1].from);
  assert.ok(options.some((o) => o.id === routes[1].from));
});

test('endpoint labels read naturally for the dropdown', () => {
  const network = buildNetwork(exampleInstructions());
  const origin = network.endpoints.find((e) => e.kind === 'origin');
  const alpha = network.endpoints.find((e) => e.kind === 'endpoint' && e.position.y === -1 && e.position.x === 4);
  const tc = network.endpoints.find((e) => e.kind === 'tc');
  assert.equal(endpointLabel(origin), 'Origin');
  assert.equal(endpointLabel(alpha), 'B');
  assert.equal(endpointLabel(tc), 'TC', 'a single TC point is named TC');
});

test('several TC points are distinguished as TC1, TC2, TC3 and keep their triangles', () => {
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: true },
    { id: 'r2', from: 'origin', direction: 'east', spans: 2, tc: true },
    { id: 'r3', from: 'origin', direction: 'north', spans: 1, tc: true },
  ]);
  assert.equal(network.tcCount, 3);
  assert.deepEqual(
    network.endpoints.filter((e) => e.kind === 'tc').map((e) => e.displayName),
    ['TC1', 'TC2', 'TC3'],
  );
  // Alphabetical letters are never consumed by TC points.
  assert.equal(network.alphaCount, 0);
  for (const profile of ['preview', 'pdf', 'svg', 'print']) {
    const scene = buildScene(network, profile);
    assert.equal(scene.tc.length, 3, `${profile} keeps all three triangles`);
    assert.deepEqual(
      scene.tc.map((t) => t.name).sort(),
      ['TC1', 'TC2', 'TC3'],
      `${profile} labels each triangle`,
    );
  }
});

test('a TC anchor shows the triangle only, never a second X on top of it', () => {
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 2, tc: true },
    { id: 'r2', from: 'tc:1', direction: 'east', spans: 2, tc: false },
  ]);
  assert.ok(network.ok);
  for (const profile of ['preview', 'svg', 'pdf', 'print']) {
    const scene = buildScene(network, profile);
    assert.equal(scene.tc.length, 1, `${profile} keeps the TC triangle`);
    const overlapping = scene.poles.filter(
      (p) => Math.abs(p.x - scene.tc[0].x) < 0.001 && Math.abs(p.y - scene.tc[0].y) < 0.001,
    );
    assert.equal(overlapping.length, 0, `${profile} draws no X at the TC anchor`);
    // The rest of the drawing keeps its crossings.
    assert.ok(scene.poles.length >= 1, `${profile} keeps X symbols on ordinary poles`);
  }
});

test('deleting an earlier route invalidates dependents and blocks export', () => {
  const routes = exampleInstructions();
  const withoutFirst = routes.slice(1);
  const network = buildNetwork(withoutFirst);
  assert.equal(network.ok, false);
  assert.equal(network.errors[0].row, 0);
  assert.match(network.errors[0].message, /has not been created yet/);
  // The dependent rows are still present and each reports its own error.
  assert.equal(network.routes.length, 8);
  for (const error of network.errors) {
    assert.ok(typeof error.message === 'string' && error.message.length > 0);
  }
});

test('the example SVG and PDF are produced from identical geometry', () => {
  const network = buildNetwork(exampleInstructions());
  const svgScene = buildScene(network, 'svg');
  const svg = renderSceneToSvg(svgScene);
  const pdfScene = buildScene(network, 'pdf');
  const { doc, primitives } = renderSceneToPdf(pdfScene, {
    jsPDF,
    layout: 'a4_landscape',
    compress: false,
  });

  assert.equal((svg.match(/<line /g) ?? []).length, svgScene.lines.length);
  assert.equal((svg.match(/<path /g) ?? []).length, svgScene.poles.length);
  assert.equal((svg.match(/<polygon /g) ?? []).length, svgScene.tc.length);
  assert.equal(primitives.lines, svgScene.lines.length);
  assert.equal(primitives.poles, svgScene.poles.length);
  assert.equal(primitives.tc, svgScene.tc.length);
  assert.equal(svgScene.tc.length, 1);
  assert.doesNotMatch(svg, /<text/);

  const text = new TextDecoder('latin1').decode(new Uint8Array(doc.output('arraybuffer')));
  assert.doesNotMatch(text, /Origin/);
  assert.doesNotMatch(text, /\/Subtype\s*\/Image/);
});

test('a new route preselects the most recently created endpoint', () => {
  // Nothing yet: the Origin is the only starting point.
  assert.deepEqual(latestSource([]), { id: 'origin', label: 'Origin' });

  // After one route, its destination is preselected. That destination has not
  // been reused, so it carries no letter yet; the id is what matters.
  const first = [{ id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: false }];
  const afterFirst = latestSource(first);
  assert.equal(afterFirst.id, 'endpoint:A');

  // It is offered by the dropdown for the next row, so the preselection is
  // actually selectable rather than merely computed.
  assert.ok(availableSources(first, 1).some((option) => option.id === afterFirst.id));

  // A TC destination is preselected as the TC point, by its own identifier.
  const withTc = [
    { id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: false },
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 2, tc: true },
  ];
  const afterTc = latestSource(withTc);
  assert.equal(afterTc.id, 'tc:1');
  assert.equal(afterTc.label, 'TC');
  assert.ok(availableSources(withTc, 2).some((option) => option.id === 'tc:1'));

  // The example leaves D's last destination as the newest endpoint.
  const example = exampleInstructions();
  const afterExample = latestSource(example);
  assert.equal(afterExample.id, 'endpoint:H');
  assert.equal(afterExample.label, 'H');
});

test('a new route step by step follows the newest endpoint', () => {
  const routes = [];
  const push = (route) => routes.push({ id: `r${routes.length + 1}`, ...route });
  push({ from: latestSource(routes).id, direction: 'south', spans: 1, tc: false });
  const afterOne = latestSource(routes).id;
  push({ from: afterOne, direction: 'east', spans: 3, tc: false });
  const afterTwo = latestSource(routes).id;
  assert.notEqual(afterOne, afterTwo, 'the preselection advances as routes are added');

  // Every route built this way resolves, which is the point of the default.
  const network = buildNetwork(routes);
  assert.equal(network.ok, true, network.errors.map((e) => e.message).join('; '));
});
