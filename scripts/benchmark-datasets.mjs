/**
 * The drawings the performance baseline is measured on.
 *
 * One definition, used by the Node benchmark, the browser benchmark and the test
 * that pins their sizes. If the documentation and the code disagreed about what
 * "the large drawing" is, every number in the baseline would be unattributable,
 * so the datasets live here and their counts are asserted in
 * `test/benchmark_datasets.test.js`.
 *
 * Each scenario is a full project: routes plus the measured data. They are built
 * from the real domain modules where the shape depends on the engine (asset ids),
 * never from hand-written coordinates, so a scenario cannot drift out of sync with
 * how the engine actually names things.
 *
 * All of them respect the interactive route limit (`MAX_ROUTE_SPANS`, 500 per
 * route): a baseline that only works on files the form would refuse would be
 * measuring a path a user cannot reach.
 */

import { EXAMPLE_ROUTES } from '../src/config.js';
import { resolveExampleRoutes } from '../src/ui/example.js';
import { latestSource } from '../src/ui/state.js';
import { buildNetwork } from '../src/geometry/network.js';
import { buildAssetRegistry } from '../src/geometry/assets.js';
import { MAX_ROUTE_SPANS } from '../src/data/constraints.js';

/** Spacing used by every scenario unless the scenario says otherwise. */
export const SPAN_LENGTH = 40;

/** The bundled example's authored routes carry placeholder ids; these are stable. */
let exampleCounter = 0;
const nextExampleId = () => {
  exampleCounter += 1;
  return `route-${exampleCounter}`;
};

/** A route record with the defaults this file always uses. */
function route(id, from, direction, spans, extra = {}) {
  return { id, from, direction, spans, tc: false, fpb: false, ...extra };
}

/**
 * A: the bundled example, exactly as the application loads it.
 *
 * This is the "someone opened the tool" case, and the one every other scenario is
 * compared against.
 */
export function bundledExampleRoutes() {
  exampleCounter = 0;
  return resolveExampleRoutes(EXAMPLE_ROUTES, nextExampleId);
}

/**
 * B: a medium network - one spine with branches off it.
 *
 * Deliberately a different SHAPE from the chain, not merely a smaller copy of it:
 * branches make the network builder walk shared sources and make the annotation
 * layer place many labels in one vertical strip, which is where a placement
 * search's cost either stays linear or does not.
 */
export function mediumRoutes() {
  // The spine is built as separate instructions so that each one creates an endpoint a
  // branch can legally start from: the engine only offers Endpoints (and TC/FPB points)
  // as sources, never an arbitrary pole in the middle of a route.
  const routes = [];
  for (let i = 0; i < 8; i += 1) {
    const from = i === 0 ? 'origin' : latestSource(routes).id;
    routes.push(route(`route-${i + 1}`, from, 'south', 4));
  }

  // One east branch from each spine endpoint, so the drawing is a different SHAPE from
  // the chain rather than a smaller copy of it.
  const endpoints = buildNetwork(routes).endpoints.filter((e) => e.kind !== 'origin');
  let next = routes.length;
  for (const endpoint of endpoints) {
    next += 1;
    routes.push(route(`route-${next}`, endpoint.id, 'east', 8));
  }
  return routes;
}

/**
 * C: the large network - 40 routes, 501 physical spans, one chain.
 *
 * This is the shape the historic hand-measured numbers used, kept so the baseline
 * can be compared with them. The span counts are distributed over the routes by
 * this function rather than written out, so the total is exact and the per-route
 * figure always satisfies `MAX_ROUTE_SPANS`.
 */
export function largeChainRoutes(totalSpans = 501, routeCount = 40) {
  const routes = [];
  let remaining = totalSpans;
  for (let i = 0; i < routeCount; i += 1) {
    const spans = Math.floor(remaining / (routeCount - i));
    remaining -= spans;
    // Each instruction continues from the endpoint the previous one created, found
    // through the same helper the form uses to preselect a source. Writing the ids by
    // hand would be guessing at how the engine names endpoints.
    const from = i === 0 ? 'origin' : latestSource(routes).id;
    routes.push(route(`route-${i + 1}`, from, 'south', spans));
  }
  return routes;
}

/**
 * A one-span-per-route chain of a given length, for the scaling series.
 *
 * Each route adds one span, so the number of routes, spans and span labels are all the
 * same figure - the axis the scaling table is plotted against.
 *
 * @param {number} spans Span count.
 * @returns {Array<object>} Routes.
 */
export function scalingChainRoutes(spans) {
  const routes = [];
  for (let i = 0; i < spans; i += 1) {
    const from = i === 0 ? 'origin' : latestSource(routes).id;
    routes.push(route(`route-${i + 1}`, from, 'south', 1));
  }
  return routes;
}

/**
 * D: annotation-heavy - the large chain, fully surveyed.
 *
 * Every span measured, a load on one pole in ten, and a manual offset on one label
 * in five. Annotation placement avoids the symbols, the lines and the other
 * labels, so this is the scenario that says whether that avoidance is linear in
 * the number of annotations or worse.
 */
export function annotationHeavyProject(baseRoutes = largeChainRoutes()) {
  const network = buildNetwork(baseRoutes);
  const registry = buildAssetRegistry(network);

  const loads = [];
  const loadPlacements = {};
  const spanLengths = {};
  const spanPlacements = {};

  // No route in this scenario ends at a TC point, so every node can carry a load.
  let poleIndex = 0;
  for (const asset of registry.allNodeAssets()) {
    poleIndex += 1;
    if (poleIndex % 10 === 0) {
      loads.push({
        id: `load-${loads.length + 1}`,
        nodeId: asset.id,
        value: 25,
        unit: 'kVA',
      });
      if (poleIndex % 20 === 0) loadPlacements[asset.id] = { dx: 6, dy: -8 };
    }
  }

  // Every physical span gets a length, keyed by its asset id, which is how the
  // application stores one measurement per physical edge.
  const spans = [...registry.allSpanAssets()];
  for (const [index, span] of spans.entries()) {
    spanLengths[span.id] = 28 + (index % 5) * 0.5;
    if (index % 5 === 0) spanPlacements[span.id] = { dx: 0, dy: 4 };
  }

  return { routes: baseRoutes, loads, spanLengths, loadPlacements, spanPlacements };
}

/**
 * The scenarios, in the order the baseline reports them.
 *
 * `project` is what the application would hold for that drawing; `routes` is kept
 * alongside because the network-to-scene phases need it directly.
 *
 * @returns {Array<{name: string, description: string, project: object}>}
 */
export function scenarios() {
  const exampleRoutes = bundledExampleRoutes();
  const medium = mediumRoutes();
  const large = largeChainRoutes();
  const surveyed = annotationHeavyProject(large);

  return [
    {
      name: 'A-example',
      description: 'The bundled example, as the application loads it',
      project: {
        routes: exampleRoutes,
        originMarker: 'plain',
        spanLength: SPAN_LENGTH,
        layout: 'a4_landscape',
        loads: [],
        spanLengths: {},
        loadPlacements: {},
        spanPlacements: {},
        nodeDesignations: {},
      },
    },
    {
      name: 'B-medium',
      description: 'One 32-span spine with eight 8-span branches',
      project: {
        routes: medium,
        originMarker: 'plain',
        spanLength: SPAN_LENGTH,
        layout: 'a4_landscape',
        loads: [],
        spanLengths: {},
        loadPlacements: {},
        spanPlacements: {},
        nodeDesignations: {},
      },
    },
    {
      name: 'C-large',
      description: '40 routes, 501 spans, one chain, nothing measured',
      project: {
        routes: large,
        originMarker: 'plain',
        spanLength: SPAN_LENGTH,
        layout: 'a4_landscape',
        loads: [],
        spanLengths: {},
        loadPlacements: {},
        spanPlacements: {},
        nodeDesignations: {},
      },
    },
    {
      name: 'D-surveyed',
      description: 'The large chain fully surveyed: every span measured, loads and offsets',
      project: {
        routes: surveyed.routes,
        originMarker: 'plain',
        spanLength: SPAN_LENGTH,
        layout: 'a4_landscape',
        loads: surveyed.loads,
        spanLengths: surveyed.spanLengths,
        loadPlacements: surveyed.loadPlacements,
        spanPlacements: surveyed.spanPlacements,
        nodeDesignations: {},
      },
    },
  ];
}

/**
 * Exact counts for one scenario, as the baseline documentation quotes them.
 *
 * @param {object} project Project payload.
 * @returns {{routes: number, spans: number, nodes: number, edges: number, assets: number,
 *   loads: number, measuredSpans: number, loadOffsets: number, spanOffsets: number}}
 *   Counts.
 */
export function describeScenario(project) {
  const network = buildNetwork(project.routes);
  if (!network.ok) {
    throw new Error(`benchmark scenario does not build: ${network.errors.join('; ')}`);
  }
  const registry = buildAssetRegistry(network);
  return {
    routes: project.routes.length,
    spans: project.routes.reduce((sum, r) => sum + r.spans, 0),
    nodes: network.graph.nodes.size,
    edges: network.graph.edges.size,
    assets: [...registry.allNodeAssets()].length,
    loads: (project.loads ?? []).length,
    measuredSpans: Object.keys(project.spanLengths ?? {}).length,
    loadOffsets: Object.keys(project.loadPlacements ?? {}).length,
    spanOffsets: Object.keys(project.spanPlacements ?? {}).length,
  };
}

/** The widest route in a project, which is what `MAX_ROUTE_SPANS` constrains. */
export function widestRoute(project) {
  return project.routes.reduce((max, r) => Math.max(max, r.spans), 0);
}

export { MAX_ROUTE_SPANS };
