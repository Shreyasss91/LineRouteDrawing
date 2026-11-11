/**
 * Application state: the single owner of route instructions.
 *
 * Route instructions are the only mutable input. Everything drawn is derived
 * from them through the geometry core, so there is no second copy of the
 * network to keep in sync.
 *
 * Sequential availability: the "From" dropdown for a route may only offer
 * endpoints that already exist at that position in the list. `availableSources`
 * computes that by replaying the instructions with the same builder the
 * drawing uses, so the dropdown can never offer an endpoint the geometry engine
 * would reject.
 */

import { buildNetwork } from '../geometry/network.js';

export { normalizeMarkerKind } from '../geometry/network.js';

let routeCounter = 0;

/** Create a fresh instruction with a stable internal id. */
export function createRoute({ from = '', direction = 'north', spans = 1, tc = false, fpb = false } = {}) {
  routeCounter += 1;
  return { id: `route-${routeCounter}`, from, direction, spans, tc, fpb };
}

/** Next internal route id, kept unique even across load-example calls. */
export function nextRouteId() {
  routeCounter += 1;
  return `route-${routeCounter}`;
}

export function createState(exampleRoutes = []) {
  return {
    routes: exampleRoutes.map((route) =>
      createRoute({
        from: route.from,
        direction: route.direction,
        spans: route.spans,
        tc: route.tc,
      }),
    ),
    selectedId: null,
    /** How the Origin itself is drawn: plain pole, TC point or FPB box. */
    originMarker: 'plain',
    spanLength: 40,
    layout: 'a4_landscape',
  };
}

/**
 * Build the canonical network for the current routes.
 *
 * @param {object} state Application state.
 * @returns {ReturnType<typeof buildNetwork>}
 */
export function buildFromState(state) {
  return buildNetwork(state.routes);
}

/**
 * Endpoints available as a starting point for the route at `index`.
 *
 * Replays the instructions before `index` and returns every endpoint the builder
 * created, which is exactly the set that is valid to reference at that point:
 * the Origin plus each earlier route's destination, whether or not that
 * destination has already been reused.
 *
 * @param {Array<object>} routes Route list.
 * @param {number} index Position being edited; pass `routes.length` for a new row.
 * @returns {Array<{id: string, label: string, kind: string}>}
 */
export function availableSources(routes, index, options = {}) {
  const prefix = routes.slice(0, index);
  const network = buildNetwork(prefix, { originMarker: options.originMarker });
  return network.endpoints.map((endpoint) => ({
    id: endpoint.id,
    label: endpointLabel(endpoint, options.originMarker),
    kind: endpoint.kind,
  }));
}

/** Label suffix for the Origin's own marker, so the dropdown matches the drawing. */
const ORIGIN_MARKER_LABEL = Object.freeze({
  plain: 'Pole',
  tc: 'TC point',
  fpb: 'FPB point',
});

/**
 * Human-readable dropdown label for an endpoint.
 *
 * The Origin is always the same node, but it can be drawn as a plain pole, a TC
 * point or an FPB box. Naming it simply "Origin" left the dropdown describing a
 * point that the drawing no longer showed, so the label carries the marker type
 * the user chose. Its internal id stays `origin` either way.
 *
 * @param {{kind: string, name: string, displayName?: string}} endpoint Endpoint.
 * @param {'plain'|'tc'|'fpb'} [originMarker] How the Origin itself is drawn.
 * @returns {string} Label to show in the dropdown.
 */
export function endpointLabel(endpoint, originMarker = 'plain') {
  if (endpoint.kind === 'origin') {
    const suffix = ORIGIN_MARKER_LABEL[originMarker] ?? ORIGIN_MARKER_LABEL.plain;
    return `Origin (${suffix})`;
  }
  // TC points are named TC when unique and TC1/TC2 when several exist; feeder
  // pillar boxes follow the same rule with FPB. Both come from displayName.
  return endpoint.displayName ?? endpoint.name;
}

/**
 * The internal id of the endpoint most recently created by the instruction
 * list, which is what a new route should start from by default.
 *
 * "Most recently created" means the destination of the last instruction that
 * resolved successfully. When nothing has been added yet, the Origin is the
 * only sensible starting point.
 *
 * @param {Array<object>} routes Route list.
 * @returns {{id: string, label: string}} Source to preselect.
 */
export function latestSource(routes, options = {}) {
  const originLabel = endpointLabel({ kind: 'origin', name: 'Origin' }, options.originMarker);
  if (!routes || routes.length === 0) return { id: 'origin', label: originLabel };
  const network = buildNetwork(routes, { originMarker: options.originMarker });
  const lastResolved = [...network.routes].reverse().find((route) => route.ok);
  const endpoint = lastResolved
    ? network.endpoints.find((e) => e.id === lastResolved.destinationId)
    : null;
  if (!endpoint) return { id: 'origin', label: originLabel };
  return { id: endpoint.id, label: endpointLabel(endpoint, options.originMarker) };
}

/**
 * The source list shown when the route at `index` already references an
 * endpoint. The route being edited keeps its own source even if editing other
 * fields, so the current value must remain selectable.
 *
 * @param {Array<object>} routes Route list.
 * @param {number} index Row position.
 * @param {string} currentFrom Currently referenced endpoint id.
 * @returns {Array<{id: string, label: string}>}
 */
export function sourcesForRow(routes, index, currentFrom, options = {}) {
  const sources = availableSources(routes, index, options);
  if (currentFrom && !sources.some((s) => s.id === currentFrom)) {
    const full = buildNetwork(routes.slice(0, index), { originMarker: options.originMarker });
    const existing = full.endpoints.find((e) => e.id === currentFrom);
    if (existing) {
      sources.push({
        id: existing.id,
        label: endpointLabel(existing, options.originMarker),
        kind: existing.kind,
      });
    }
  }
  return sources;
}
