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
  INVALID_MARKER: 'invalid-marker',
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
  let fpbCounter = 0;

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
    addOrigin(position, markerKind = 'plain') {
      return add({
        id: ORIGIN_ID,
        name: 'Origin',
        kind: 'origin',
        position: { ...position },
        usedAsSource: true,
        // The Origin may itself be shown as a TC point or a feeder pillar box.
        originMarker: markerKind,
      });
    },
    addLabeled(position, kind, createdByDirection = null) {
      const name = alphaLabel(alphaCounter++);
      return add({
        id: `endpoint:${name}`,
        name,
        kind,
        position: { ...position },
        usedAsSource: false,
        // The direction of the route that first created this point. It is what
        // a symbol needs in order to know which side the cable arrives from, so
        // the symbol can be turned to face it. Derived from the route, never
        // asked of the user and never stored in the project file.
        createdByDirection,
      });
    },
    addTc(position, createdByDirection = null) {
      tcCounter += 1;
      return add({
        id: `tc:${tcCounter}`,
        name: `TC${tcCounter}`,
        kind: 'tc',
        position: { ...position },
        usedAsSource: false,
        createdByDirection,
      });
    },
    addFpb(position, createdByDirection = null) {
      fpbCounter += 1;
      return add({
        id: `fpb:${fpbCounter}`,
        name: `FPB${fpbCounter}`,
        kind: 'fpb',
        position: { ...position },
        usedAsSource: false,
        createdByDirection,
      });
    },
    get alphaCount() {
      return alphaCounter;
    },
    get tcCount() {
      return tcCounter;
    },
    get fpbCount() {
      return fpbCounter;
    },
    all() {
      return [...byId.values()];
    },
  };

  return registry;
}

/**
 * Normalize a marker kind to `plain`, `tc` or `fpb`.
 *
 * @param {unknown} value Raw marker kind.
 * @returns {'plain'|'tc'|'fpb'} A valid marker kind; `plain` when unrecognized.
 */
export function normalizeMarkerKind(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'tc') return 'tc';
  if (text === 'fpb') return 'fpb';
  return 'plain';
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
  if (route.tc && route.fpb) {
    return {
      code: ERROR_CODES.INVALID_MARKER,
      message: 'A destination is either a TC point or a feeder pillar box (FPB), not both.',
    };
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
  // The Origin is a pole by default but the user may declare it a TC point or a
  // feeder pillar box, in which case it is drawn with that symbol instead of an X.
  const originMarker = normalizeMarkerKind(options.originMarker);
  const graph = createGraph();
  const registry = createEndpointRegistry();
  const errors = [];

  const origin = registry.addOrigin(originPosition, originMarker);
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
        // The coordinate this unit span starts at. It is what fixes the span's
        // display orientation to the way the drawing was built, so a schedule row
        // reads in the direction the user laid the cable down.
        fromKey: coordKey(cursor),
      });
      cursor = next;
      path.push(cursor);
    }

    const destinationPosition = cursor;

    // Endpoints are identified by coordinate, so arriving at a coordinate that
    // already carries an endpoint reuses it instead of creating a second one.
    let destination = registry.all().find((e) => sameCoord(e.position, destinationPosition)) ?? null;
    if (!destination) {
      if (route.fpb) {
        destination = registry.addFpb(destinationPosition, direction);
      } else if (route.tc) {
        destination = registry.addTc(destinationPosition, direction);
      } else {
        destination = registry.addLabeled(destinationPosition, 'endpoint', direction);
      }
    } else if (route.fpb && destination.kind !== 'fpb') {
      // The same coordinate requested as a feeder pillar box becomes one.
      destination.kind = 'fpb';
      destination.createdByDirection ??= direction;
    } else if (route.tc && destination.kind !== 'tc') {
      // The same coordinate requested as a TC point upgrades it to a TC, keeping
      // its alphabetical letter for later reuse.
      destination.kind = 'tc';
      destination.tcRequested = true;
      // A point that existed as an ordinary endpoint before it was asked to be a
      // TC keeps the direction it was first reached from, so the triangle faces
      // the cable that actually arrives at it.
      destination.createdByDirection ??= direction;
    }

    // Only the route's SOURCE becomes reused. A destination is labelled when it
    // is created (see the projection below), not only when it is later reused.
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
  const fpbEndpoints = registry.all().filter((e) => e.kind === 'fpb');
  let fpbNameCounter = 0;
  for (const endpoint of fpbEndpoints) {
    if (!endpoint.fpbId) {
      fpbNameCounter += 1;
      endpoint.fpbId = endpoint.fpbId ?? `fpb:${fpbNameCounter}`;
    }
  }

  const endpoints = registry.all().map((endpoint) => {
    const node = ensureNode(graph, endpoint.position);
    let displayName;
    let alphaLabelValue = null;
    if (endpoint.kind === 'origin') {
      displayName = 'Origin';
      node.isOrigin = true;
      // The Origin's own symbol follows its declared marker kind.
      if (endpoint.originMarker === 'tc') {
        node.tcId = endpoint.id;
        node.tcName = 'TC';
      } else if (endpoint.originMarker === 'fpb') {
        node.fpbId = endpoint.id;
        node.fpbName = 'FPB';
      }
      // The Origin has no route arriving at it, so its symbol has no incoming
      // direction to face. It is given a deterministic default below.
      node.markerDirection = null;
    } else if (endpoint.kind === 'fpb') {
      // A feeder pillar box is identified by its box, not by a letter.
      displayName = fpbEndpoints.length > 1 ? endpoint.name : 'FPB';
      node.fpbId = endpoint.id;
      node.fpbName = displayName;
      node.markerDirection = endpoint.createdByDirection ?? null;
      endpoint.displayName = displayName;
    } else if (endpoint.kind === 'tc') {
      displayName = tcEndpoints.length > 1 ? endpoint.name : 'TC';
      node.tcId = endpoint.id;
      node.tcName = displayName;
      // Which side of the point the cable arrives from. The triangle is turned
      // so its base faces the cable leaving, and its apex the cable arriving.
      node.markerDirection = endpoint.createdByDirection ?? null;
      endpoint.displayName = displayName;
    } else {
      // Every ordinary endpoint is labelled as soon as it is created, so a new
      // branch is named in the drawing immediately. Reuse does not change the
      // label; it is assigned in creation order and never moves.
      alphaLabelValue = endpoint.name;
      node.alphaLabel = alphaLabelValue;
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
    fpbCount: fpbEndpoints.length,
    /** Number of alphabetical labels actually displayed (reused sources). */
    alphaCount: endpoints.filter((e) => e.kind === 'endpoint' && e.displayName).length,
    originPosition: { ...originPosition },
    originMarker,
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
