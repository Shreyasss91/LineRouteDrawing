/**
 * The performance baseline's datasets: the sizes it reports must be the sizes it measures.
 *
 * `documentation/11-performance-baseline.md` quotes exact counts for four drawings, and a
 * baseline whose dataset silently changed shape would make every number in that document
 * unattributable - the description would say 501 spans while the measurement ran on
 * something else. These tests pin the counts, and pin the properties that make the
 * datasets legitimate:
 *
 *   - every route is within the interactive limit, so the baseline measures a drawing a
 *     user can actually build;
 *   - every scenario builds without errors, so nothing is being measured on a broken
 *     drawing;
 *   - the measured data refers to real asset ids, so the annotation-heavy scenario is
 *     annotated rather than merely carrying tables of numbers.
 *
 * Nothing here asserts a timing. A duration depends on the machine, so a test that
 * asserted one would fail on a slower laptop while the code was fine.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_ROUTE_SPANS,
  SPAN_LENGTH,
  annotationHeavyProject,
  bundledExampleRoutes,
  describeScenario,
  largeChainRoutes,
  mediumRoutes,
  scalingChainRoutes,
  scenarios,
  widestRoute,
} from '../scripts/benchmark-datasets.mjs';
import { buildNetwork } from '../src/geometry/network.js';
import { buildAssetRegistry } from '../src/geometry/assets.js';

/** Look a scenario up by name, so a failure names the drawing. */
function scenario(name) {
  const found = scenarios().find((s) => s.name === name);
  assert.ok(found, `scenario ${name} is missing`);
  return found;
}

/** Counts as the documentation states them. */
const EXPECTED = {
  'A-example': {
    routes: 9,
    spans: 34,
    nodes: 34,
    edges: 33,
    assets: 34,
    loads: 0,
    measuredSpans: 0,
    loadOffsets: 0,
    spanOffsets: 0,
  },
  'B-medium': {
    routes: 16,
    spans: 96,
    nodes: 97,
    edges: 96,
    assets: 97,
    loads: 0,
    measuredSpans: 0,
    loadOffsets: 0,
    spanOffsets: 0,
  },
  'C-large': {
    routes: 40,
    spans: 501,
    nodes: 502,
    edges: 501,
    assets: 502,
    loads: 0,
    measuredSpans: 0,
    loadOffsets: 0,
    spanOffsets: 0,
  },
  'D-surveyed': {
    routes: 40,
    spans: 501,
    nodes: 502,
    edges: 501,
    assets: 502,
    loads: 50,
    measuredSpans: 501,
    loadOffsets: 25,
    spanOffsets: 101,
  },
};

test('1. every dataset has the exact size the baseline documentation quotes', () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    assert.deepEqual(describeScenario(scenario(name).project), expected, name);
  }
});

test('2. every dataset builds without errors', () => {
  for (const item of scenarios()) {
    const network = buildNetwork(item.project.routes);
    assert.equal(network.ok, true, `${item.name}: ${JSON.stringify(network.errors)}`);
  }
});

test('3. no dataset uses a route the form would refuse', () => {
  for (const item of scenarios()) {
    const widest = widestRoute(item.project);
    assert.ok(widest > 0, `${item.name} has an empty route`);
    assert.ok(
      widest <= MAX_ROUTE_SPANS,
      `${item.name} has a ${widest}-span route, above the ${MAX_ROUTE_SPANS} limit`,
    );
  }
});

test('4. the large chain really is a chain, and its spans add up', () => {
  const routes = largeChainRoutes();
  assert.equal(routes.length, 40);
  assert.equal(
    routes.reduce((sum, r) => sum + r.spans, 0),
    501,
    'the total must be exactly 501 spans',
  );
  // Each instruction continues from a point the previous ones created, which is what
  // makes it a chain rather than 40 separate runs from the Origin. The check asks the
  // engine which endpoints exist at each step instead of assuming how they are named.
  assert.equal(routes[0].from, 'origin');
  for (let i = 1; i < routes.length; i += 1) {
    const earlier = buildNetwork(routes.slice(0, i));
    const exists = earlier.endpoints.some((e) => e.id === routes[i].from);
    assert.ok(exists, `${routes[i].id} starts from an uncreated point ${routes[i].from}`);
    assert.notEqual(routes[i].from, 'origin', `${routes[i].id} starts from the origin again`);
  }
});

test('5. the chain builder can produce other sizes exactly', () => {
  for (const total of [10, 96, 200, 501, 750]) {
    const routes = largeChainRoutes(total, 40);
    assert.equal(
      routes.reduce((sum, r) => sum + r.spans, 0),
      total,
      `${total} spans requested`,
    );
  }
});

test('6. the medium dataset branches instead of being a shorter chain', () => {
  const routes = mediumRoutes();
  const sources = new Set(routes.map((r) => r.from));
  // A chain has one distinct source per route after the first; a branched drawing reuses
  // sources, so there are strictly fewer sources than routes.
  assert.ok(
    sources.size < routes.length,
    'a branched drawing must reuse source points',
  );
  const directions = new Set(routes.map((r) => r.direction));
  assert.deepEqual([...directions].sort(), ['east', 'south']);
});

test('7. the annotated dataset refers to real assets only', () => {
  const project = annotationHeavyProject(largeChainRoutes());
  const registry = buildAssetRegistry(buildNetwork(project.routes));
  const nodeIds = new Set([...registry.allNodeAssets()].map((a) => a.id));
  const spanIds = new Set([...registry.allSpanAssets()].map((a) => a.id));

  assert.equal(project.loads.length, 50);
  for (const load of project.loads) {
    assert.ok(nodeIds.has(load.nodeId), `load target ${load.nodeId} is not a drawn node`);
    assert.ok(load.value > 0 && load.unit, `${load.id} is not a usable record`);
  }
  // Every physical span is measured, which is what makes this the surveyed dataset.
  assert.equal(Object.keys(project.spanLengths).length, spanIds.size);
  for (const id of Object.keys(project.spanLengths)) {
    assert.ok(spanIds.has(id), `span length ${id} is not a drawn span`);
  }
  for (const id of Object.keys(project.loadPlacements)) {
    assert.ok(nodeIds.has(id), `load offset ${id} is not a drawn node`);
  }
  for (const id of Object.keys(project.spanPlacements)) {
    assert.ok(spanIds.has(id), `span offset ${id} is not a drawn span`);
  }
});

test('8. every dataset is a complete, openable project', () => {
  for (const item of scenarios()) {
    const project = item.project;
    assert.ok(Array.isArray(project.routes) && project.routes.length > 0, item.name);
    assert.equal(project.spanLength, SPAN_LENGTH, item.name);
    assert.equal(typeof project.originMarker, 'string', item.name);
    assert.equal(typeof project.layout, 'string', item.name);
    for (const key of ['loads', 'spanLengths', 'loadPlacements', 'spanPlacements']) {
      assert.ok(project[key] !== undefined && project[key] !== null, `${item.name}: ${key}`);
    }
  }
});

test('9. the scaling series is one span per route, so its axis is unambiguous', () => {
  for (const size of [50, 100, 200, 400, 800]) {
    const routes = scalingChainRoutes(size);
    assert.equal(routes.length, size, `${size} routes`);
    assert.ok(
      routes.every((r) => r.spans === 1),
      'every route in the scaling series must be one span',
    );
    assert.equal(buildNetwork(routes).ok, true, `${size} spans must build`);
  }
});

test('10. the bundled example dataset matches the application’s own example', () => {
  const routes = bundledExampleRoutes();
  assert.equal(routes.length, 9);
  // The same authored example the tool loads, resolved the same way - so scenario A is a
  // measurement of the thing a first-time user sees, not a lookalike.
  assert.equal(routes.reduce((sum, r) => sum + r.spans, 0), 34);
});
