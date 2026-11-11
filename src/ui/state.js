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

let routeCounter = 0;

/** Create a fresh instruction with a stable internal id. */
export function createRoute({ from = '', direction = 'north', spans = 1, tc = false } = {}) {
  routeCounter += 1;
  return { id: `route-${routeCounter}`, from, direction, spans, tc };
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
export function availableSources(routes, index) {
  const prefix = routes.slice(0, index);
  const network = buildNetwork(prefix);
  return network.endpoints.map((endpoint) => ({
    id: endpoint.id,
    label: endpointLabel(endpoint),
    kind: endpoint.kind,
  }));
}

/** Human-readable dropdown label for an endpoint. */
export function endpointLabel(endpoint) {
  if (endpoint.kind === 'origin') return 'Origin';
  if (endpoint.kind === 'tc') {
    // TC points are named TC when unique, TC1/TC2 when several exist.
    return endpoint.displayName ?? endpoint.name;
  }
  return endpoint.displayName ?? endpoint.name;
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
export function sourcesForRow(routes, index, currentFrom) {
  const sources = availableSources(routes, index);
  if (currentFrom && !sources.some((s) => s.id === currentFrom)) {
    const full = buildNetwork(routes.slice(0, index));
    const existing = full.endpoints.find((e) => e.id === currentFrom);
    if (existing) {
      sources.push({ id: existing.id, label: endpointLabel(existing), kind: existing.kind });
    }
  }
  return sources;
}
