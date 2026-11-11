/**
 * Network builder: turns a sequential list of route instructions into one
 * canonical network graph.
 *
 * Processing rules (deliberately strict and deterministic):
 *  - Instructions are processed in the order the user entered them.
 *  - A route's `from` endpoint must already exist: either the Origin, or a
 *    destination created by a preceding instruction that resolved successfully.
 *  - Forward references are refused with an actionable error on the row.
 *  - A row that fails does not create a destination, so every later row that
 *    depended on it fails too, with an error pointing at the original cause.
 *  - Editing or deleting an earlier row therefore re-evaluates every later row
 *    deterministically; nothing is silently dropped.
 *
 * Naming rules:
 *  - The Origin is the initial node and displays the text "Origin".
 *  - Alphabetical labels A, B, C... are assigned the first time an ordinary
 *    endpoint is used as the STARTING point of another route, in that order.
 *  - A terminal branch that is never reused keeps its internal id but displays
 *    no alphabetical label.
 *  - A TC point is a special node with a stable internal id (`tc:N`) and a
 *    triangular symbol. It never consumes an alphabetical letter. Its display
 *    name is `TC` when it is the only TC point, otherwise `TC1`, `TC2`, ...
 *
 * Internal endpoint ids are the single source of node identity; display names
 * are derived and never used to link instructions.
 */

import { advance, coordKey, normalizeDirection, sameCoord } from './direction.js';
import { addEdge, createGraph, ensureNode } from './graph.js';

const ORIGIN_ID = 'origin';

/** Error codes emitted by the validator. */
export const ERROR_CODES = Object.freeze({
  UNKNOWN_SOURCE: 'unknown-source',
  UNKNOWN_DIRECTION: 'invalid-direction',
  INVALID_SPANS: 'invalid-spans',
  ZERO_LENGTH: 'zero-length',
  DEPENDENCY_FAILED: 'dependency-failed',
});

/**
 * Format an alphabetical label from a zero-based index.
 *
 * @param {number} index Zero-based label index.
 * @returns {string} A, B, ..., Z, AA, AB, ...
 */
export function alphaLabel(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Registry of endpoints created while walking the instruction list. */
function createEndpointRegistry() {
  const byId = new Map();
  /** Lower-case display-name -> endpoint id, for resolving example/config input. */
  const byName = new Map();
  let alphaCounter = 0;
  let tcCounter = 0;

  function add(endpoint) {
    byId.set(endpoint.id, endpoint);
    byName.set(endpoint.name.toLowerCase(), endpoint.id);
    return endpoint;
  }

  const registry = {
    byId,
    byName,
    get(id) {
      return byId.get(id) ?? null;
    },
    /** Resolve a reference that may be an internal id or a display name. */
    resolve(ref) {
      if (ref === null || ref === undefined) return null;
      const direct = byId.get(ref);
      if (direct) return direct;
      const lowered = String(ref).trim().toLowerCase();
      const aliased = byName.get(lowered);
      return aliased ? byId.get(aliased) : null;
    },
    addOrigin(position) {
      return add({
        id: ORIGIN_ID,
        name: 'Origin',
        kind: 'origin',
        position: { ...position },
        usedAsSource: true,
      });
    },
    addLabeled(position, kind) {
      const name = alphaLabel(alphaCounter++);
      return add({
        id: `endpoint:${name}`,
        name,
        kind,
        position: { ...position },
        usedAsSource: false,
      });
    },
    addTc(position) {
      tcCounter += 1;
      return add({
        id: `tc:${tcCounter}`,
        name: `TC${tcCounter}`,
        kind: 'tc',
        position: { ...position },
        usedAsSource: false,
      });
    },
    get alphaCount() {
      return alphaCounter;
    },
    get tcCount() {
      return tcCounter;
    },
    all() {
      return [...byId.values()];
    },
  };

  return registry;
}

/**
 * Validate the shape of one instruction, independent of dependencies.
 *
 * @param {object} route Raw instruction.
 * @returns {{code: string, message: string}|null}
 */
function validateShapes(route) {
  if (!route || typeof route !== 'object') {
    return { code: ERROR_CODES.UNKNOWN_SOURCE, message: 'Route instruction is not an object.' };
  }
  if (route.from === null || route.from === undefined || route.from === '') {
    return {
      code: ERROR_CODES.UNKNOWN_SOURCE,
      message: 'No starting point selected. Choose the Origin or an endpoint created above.',
    };
  }
  if (!normalizeDirection(route.direction)) {
    return {
      code: ERROR_CODES.UNKNOWN_DIRECTION,
      message: `"${String(route.direction ?? '')}" is not a direction. Use North, South, East or West.`,
    };
  }
  const spans = route.spans;
  if (typeof spans !== 'number' || !Number.isFinite(spans)) {
    return {
      code: ERROR_CODES.INVALID_SPANS,
      message: 'Spans must be a whole number greater than zero.',
    };
  }
  if (!Number.isInteger(spans)) {
    return { code: ERROR_CODES.INVALID_SPANS, message: 'Spans must be a whole number (no decimals).' };
  }
  if (spans <= 0) {
    return { code: ERROR_CODES.INVALID_SPANS, message: 'Spans must be greater than zero.' };
  }
  return null;
}

/**
 * Build the canonical network from sequential route instructions.
 *
 * @param {Array<object>} routes Route instructions in user order.
 * @param {object} [options]
 * @param {{x: number, y: number}} [options.origin] Origin coordinate.
 * @returns {{
 *   ok: boolean,
 *   graph: ReturnType<typeof createGraph>,
 *   routes: Array<object>,
 *   errors: Array<object>,
 *   endpoints: Array<object>,
 *   tcCount: number,
 *   boundingBox: {minX: number, minY: number, maxX: number, maxY: number},
 * }}
 */
export function buildNetwork(routes, options = {}) {
  const originPosition = options.origin ?? { x: 0, y: 0 };
  const graph = createGraph();
  const registry = createEndpointRegistry();
  const errors = [];

  const origin = registry.addOrigin(originPosition);
  const originNode = ensureNode(graph, originPosition);
  originNode.isOrigin = true;

  const input = Array.isArray(routes) ? routes : [];
  const resolved = [];

  input.forEach((route, index) => {
    const routeId = route && route.id != null ? route.id : `r${index + 1}`;
    const label = `Route ${index + 1}`;
    const shapeError = validateShapes(route);
    if (shapeError) {
      errors.push({ routeId, row: index, ...shapeError, message: `${label}: ${shapeError.message}` });
      resolved.push({ routeId, row: index, ok: false, error: shapeError.code });
      return;
    }

    const direction = normalizeDirection(route.direction);
    const source = registry.resolve(route.from);

    if (!source) {
      const failedDependency = resolved.find(
        (r) => r.ok === false && (r.createdId === route.from || r.routeId === route.from),
      );
      const message = failedDependency
        ? `${label}: its starting point cannot exist because route ${failedDependency.row + 1} did not resolve.`
        : `${label}: the starting point "${String(route.from)}" has not been created yet. ` +
          'Choose the Origin or an endpoint created by an earlier route.';
      errors.push({
        routeId,
        row: index,
        code: ERROR_CODES.UNKNOWN_SOURCE,
        message,
      });
      resolved.push({ routeId, row: index, ok: false, error: ERROR_CODES.UNKNOWN_SOURCE });
      return;
    }

    // A route is a chain of unit spans; the destination is the far end.
    const start = source.position;
    let cursor = { ...start };
    const path = [cursor];
    for (let span = 0; span < route.spans; span += 1) {
      const next = advance(cursor, direction, 1);
      if (sameCoord(next, cursor)) {
        errors.push({
          routeId,
          row: index,
          code: ERROR_CODES.ZERO_LENGTH,
          message: `${label}: a span cannot have zero length.`,
        });
        resolved.push({ routeId, row: index, ok: false, error: ERROR_CODES.ZERO_LENGTH });
        return;
      }
      addEdge(graph, cursor, next, {
        routeId,
        row: index,
        fromId: source.id,
        direction,
        spanIndex: span,
      });
      cursor = next;
      path.push(cursor);
    }

    const destinationPosition = cursor;

    // Endpoints are identified by coordinate, so arriving at a coordinate that
    // already carries an endpoint reuses it instead of creating a second one.
    let destination = registry.all().find((e) => sameCoord(e.position, destinationPosition)) ?? null;
    if (!destination) {
      destination = route.tc
        ? registry.addTc(destinationPosition)
        : registry.addLabeled(destinationPosition, 'endpoint');
    } else if (route.tc && destination.kind !== 'tc') {
      // The same coordinate requested as a TC point upgrades it to a TC, keeping
      // its alphabetical letter for later reuse.
      destination.kind = 'tc';
      destination.tcRequested = true;
    }

    // Only the route's SOURCE becomes reused. The freshly created destination
    // stays unlabelled until some later route starts from it.
    source.usedAsSource = true;

    resolved.push({
      routeId,
      row: index,
      ok: true,
      sourceId: source.id,
      destinationId: destination.id,
      destinationName: destination.name,
      path,
    });
  });

  // Project endpoint naming onto the canonical graph nodes.
  // A TC marker is created for any endpoint that was requested as a TC point,
  // including one that already existed at that coordinate.
  const tcEndpoints = registry.all().filter((e) => e.kind === 'tc');
  let tcNameCounter = 0;
  for (const endpoint of tcEndpoints) {
    if (!endpoint.tcId) {
      tcNameCounter += 1;
      endpoint.tcId = endpoint.tcId ?? `tc:${tcNameCounter}`;
    }
  }
  const endpoints = registry.all().map((endpoint) => {
    const node = ensureNode(graph, endpoint.position);
    let displayName;
    let alphaLabelValue = null;
    if (endpoint.kind === 'origin') {
      displayName = 'Origin';
      node.isOrigin = true;
    } else if (endpoint.kind === 'tc') {
      displayName = tcEndpoints.length > 1 ? endpoint.name : 'TC';
      node.tcId = endpoint.id;
      node.tcName = displayName;
      endpoint.displayName = displayName;
    } else {
      // Only a reused endpoint displays an alphabetical label.
      const reused = resolved.some((r) => r.ok && r.sourceId === endpoint.id);
      alphaLabelValue = reused ? endpoint.name : null;
      node.alphaLabel = alphaLabelValue;
      // An unused terminal endpoint displays no alphabetical label at all, so
      // its display name is intentionally null (its id remains stable).
      displayName = alphaLabelValue;
      endpoint.displayName = displayName;
    }
    return { ...endpoint, displayName };
  });

  const boundingBox = computeBoundingBox(graph);

  return {
    ok: errors.length === 0,
    graph,
    routes: resolved,
    errors,
    endpoints,
    tcCount: tcEndpoints.length,
    /** Number of alphabetical labels actually displayed (reused sources). */
    alphaCount: endpoints.filter((e) => e.kind === 'endpoint' && e.displayName).length,
    originPosition: { ...originPosition },
    boundingBox,
  };
}

/**
 * Compute the integer bounding box of all graph nodes.
 *
 * @param {ReturnType<typeof createGraph>} graph Canonical graph.
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
 */
export function computeBoundingBox(graph) {
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  let first = true;
  for (const node of graph.nodes.values()) {
    if (first) {
      minX = maxX = node.x;
      minY = maxY = node.y;
      first = false;
      continue;
    }
    if (node.x < minX) minX = node.x;
    if (node.x > maxX) maxX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.y > maxY) maxY = node.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Return the internal id of an endpoint record, used by the dropdown.
 *
 * @param {object} endpoint Endpoint record from `buildNetwork`.
 * @returns {string}
 */
export function endpointId(endpoint) {
  return endpoint.id;
}

/** Re-exported for consumers that need the canonical coordinate key. */
export { coordKey };
