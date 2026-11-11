/**
 * Network point designations: the human-readable name of every physical pole.
 *
 * WHY THIS EXISTS
 *
 * A route drawing has two kinds of important point. The named ones - the Origin,
 * the alphabetical endpoints A, B, C, the TC points and the feeder pillar boxes -
 * already have names a person can say out loud. The poles between them do not.
 * Until now those poles were anonymous, which is fine for a diagram and useless
 * for a schedule: "put 25 kVA on that one" cannot be written down.
 *
 * So every drawn pole gets a designation, derived from the point it grows out of:
 *
 *   Origin -> Origin:1, Origin:2, Origin:3 ...
 *   A      -> A1, A2, A3 ...
 *   C      -> C1, C2 ...
 *   TC1    -> TC1:1, TC1:2 ...
 *   FPB1   -> FPB1:1, FPB1:2 ...
 *
 * The colon on the special sources is deliberate. A plain `TC1` would be
 * indistinguishable from the TC point itself, and `FPB1` likewise, so the
 * separator keeps `TC1:2` (a pole) visually distinct from `TC1` (a TC point).
 * An ordinary alphabetical source needs no colon because `A1` cannot be confused
 * with anything: the letters are never followed by a digit.
 *
 * THE COUNTING RULE
 *
 * One designation per actual pole, not per span. A route of N spans from an
 * existing point to another point draws N-1 poles between them, because both ends
 * are already named. A route of N spans from the Origin to a new point also draws
 * N-1 poles: the far end becomes the destination endpoint and is named as such.
 *
 * THE SEQUENCE IS PER SOURCE, NOT PER ROUTE
 *
 * Every route leaving A draws from one shared A counter. A -> B might be A1, A2;
 * a later A -> C continues at A3, A4, never restarting at A1. That is what makes
 * `A3` mean one thing in the schedules. The counter is per source point, so a
 * branch from C has its own sequence.
 *
 * DESIGNATION IS A NAME, NOT AN IDENTITY
 *
 * This module produces a naming scheme. It never decides which physical asset a
 * record belongs to - that is `assets.js`, which keys on route provenance. The two
 * are deliberately separate:
 *
 *   - Identity answers "is this the same pole as before?" and must survive a
 *     relabelling, a re-layout and a coordinate change.
 *   - Designation answers "which pole does the reader mean?" and must be stable,
 *     readable and unique.
 *
 * The designations produced here are handed to the asset registry, which stores
 * them against the identity it already computed. A saved project therefore keeps
 * its designations, and a designation is never silently reused for a different
 * pole: `reserveDesignations` records the names already handed out, and
 * `allocateDesignation` will not hand out one of them again.
 *
 * Everything here is pure: no DOM, no renderer, no clock.
 */

/** Separator between a special source name and its pole number. */
export const SPECIAL_SEPARATOR = ':';

/** Point kinds that take the colon form for their intermediate poles. */
const SPECIAL_KINDS = new Set(['origin', 'tc', 'fpb']);

/**
 * The designation of a named point, from its endpoint record.
 *
 * Uses the display name the drawing shows, so the schedule and the drawing agree:
 * a lone TC is `TC` and a second becomes `TC2`, matching what is drawn. The Origin
 * is always `Origin`.
 *
 * @param {object|null} endpoint Endpoint record from `buildNetwork`.
 * @returns {string|null} Designation, or null when there is no endpoint.
 */
export function pointDesignation(endpoint) {
  if (!endpoint) return null;
  return endpoint.displayName ?? endpoint.name ?? null;
}

/**
 * Whether a source name takes the colon form before its intermediate poles.
 *
 * `Origin`, `TC`, `TC1`, `FPB`, `FPB2` do; `A`, `B`, `AB` do not.
 *
 * @param {string} sourceName The source point's designation.
 * @param {string} sourceKind The source point's kind (`origin`, `tc`, `fpb`, `endpoint`).
 * @returns {boolean}
 */
export function usesSpecialSeparator(sourceName, sourceKind) {
  if (SPECIAL_KINDS.has(sourceKind)) return true;
  // A name that already carries a colon is special by construction.
  return typeof sourceName === 'string' && sourceName.includes(SPECIAL_SEPARATOR);
}

/**
 * Format the k-th intermediate pole designation for a source.
 *
 * @param {string} sourceName Source point designation, e.g. `A` or `Origin`.
 * @param {string} sourceKind Source point kind.
 * @param {number} ordinal One-based pole number within that source's sequence.
 * @returns {string}
 */
export function intermediateDesignation(sourceName, sourceKind, ordinal) {
  const prefix = usesSpecialSeparator(sourceName, sourceKind)
    ? `${sourceName}${SPECIAL_SEPARATOR}`
    : String(sourceName);
  return `${prefix}${ordinal}`;
}

/**
 * Split a designation back into its source name and ordinal.
 *
 * Used to work out which sequence a designation belongs to, so a project that
 * remembers `A4` can continue from A5 rather than from A1.
 *
 * @param {string} designation A designation such as `A4` or `Origin:12`.
 * @returns {{sourceName: string, ordinal: number}|null} Parts, or null.
 */
export function splitDesignation(designation) {
  if (typeof designation !== 'string' || designation.length === 0) return null;
  const match = /^(.*?):?(\d+)$/.exec(designation);
  if (!match) return null;
  const sourceName = match[1].replace(/:$/, '');
  if (sourceName.length === 0) return null;
  return { sourceName, ordinal: Number(match[2]) };
}

/**
 * Allocate intermediate designations for one network, in route order.
 *
 * Walks the resolved routes the way the user entered them and hands each route's
 * intermediate poles the next number in its own source's sequence. Because a
 * route's interior poles are ordered from its start outwards, the numbers run
 * along the cable away from the named point, which is the order a reader expects.
 *
 * A route whose far end coincides with a pole another route already created does
 * not draw a new pole there, so it consumes no designation for it. That is why the
 * consumption is driven by which nodes are actually new, not by the span count.
 *
 * @param {object} network Built network.
 * @param {object} [seed]
 * @param {Map<string, number>} [seed.counters] Existing next-ordinal per source.
 * @param {Map<string, string>} [seed.nodeDesignations] Designations already held by
 *   a node id, from a saved project. These are kept as they are.
 * @param {Map<string, string>} [seed.spanOrientations] Unused here; accepted so a
 *   caller can pass one seed object to both this and the span pass.
 * @returns {{
 *   nodeDesignations: Map<string, string>,
 *   counters: Map<string, number>,
 *   sourceOf: Map<string, string>,
 * }} Node id -> designation, next ordinal per source, and node id -> source name.
 */
export function allocateDesignations(network, seed = {}) {
  const seedDesignations = seed.nodeDesignations ?? new Map();
  const counters = new Map(seed.counters ?? []);

  /** node asset id -> designation (mutable working copy). */
  const nodeDesignations = new Map();
  /** node asset id -> the source name whose sequence named it. */
  const sourceOf = new Map();

  const endpoints = network.endpoints ?? [];
  const endpointById = new Map(endpoints.map((e) => [e.id, e]));
  const endpointByCoord = new Map(
    endpoints.map((e) => [`${e.position.x},${e.position.y}`, e]),
  );

  // Named points keep their own designation: Origin, A, B, TC1, FPB2.
  for (const endpoint of endpoints) {
    const name = pointDesignation(endpoint);
    if (!name) continue;
    nodeDesignations.set(endpoint.id, name);
    // A named point that is also the far end of a route is stored in the asset
    // registry under the route's destination id, not the endpoint id. Both ids
    // stand for the same physical pole, so both carry the one designation; anything
    // else would leave a destination-looking pole with no name at all.
    const route = (network.routes ?? []).find(
      (r) => r.ok && r.destinationId === endpoint.id,
    );
    if (route) nodeDesignations.set(`dst:${route.routeId}`, name);
  }

  // Rebuild the sequence position from any designations a saved project already
  // holds, so a reload continues the numbering instead of restating it.
  for (const [nodeId, designation] of seedDesignations) {
    const parts = splitDesignation(designation);
    if (!parts) continue;
    const next = counters.get(parts.sourceName) ?? 1;
    if (parts.ordinal + 1 > next) counters.set(parts.sourceName, parts.ordinal + 1);
    // A stored designation is preserved verbatim, which is what stops a reload
    // from silently renumbering somebody's poles.
    if (!nodeDesignations.has(nodeId)) nodeDesignations.set(nodeId, designation);
  }

  /** Which physical coordinates already carry a designation. */
  const claimedCoords = new Set();

  /**
   * Reserve every coordinate a named point or a stored designation already covers,
   * so a later route that walks through one of them does not name it twice.
   */
  for (const [nodeId, designation] of [...nodeDesignations]) {
    const coord = coordinateOfNodeId(nodeId, network, endpointById);
    if (coord) claimedCoords.add(coord);
    const parts = splitDesignation(designation);
    if (parts) sourceOf.set(nodeId, parts.sourceName);
  }

  /** Take the next ordinal in a source's sequence. */
  function nextOrdinal(sourceName) {
    const value = counters.get(sourceName) ?? 1;
    counters.set(sourceName, value + 1);
    return value;
  }

  for (const route of network.routes ?? []) {
    if (!route.ok || !Array.isArray(route.path) || route.path.length < 2) continue;

    const source = endpointById.get(route.sourceId);
    const sourceName = pointDesignation(source);
    if (!sourceName) continue;
    const sourceKind = source.kind ?? 'endpoint';

    // Every interior step of the route. The far end is the destination endpoint,
    // which is named as an endpoint (or a TC, or an FPB) and is not a plain pole.
    const spanCount = route.path.length - 1;
    for (let step = 0; step < spanCount - 1; step += 1) {
      const point = route.path[step + 1];
      const coord = `${point.x},${point.y}`;

      // A pole already named - by an earlier route, by a named endpoint, or by a
      // saved designation - keeps that name. This is what makes a shared crossing
      // one pole with one designation rather than two names for one physical pole.
      if (claimedCoords.has(coord)) continue;

      // The asset id this pole has in the registry, so the designation attaches to
      // the same identity the loads and measurements are stored against.
      const nodeId = routeNodeAssetId(route, step, spanCount, endpointByCoord, coord);
      if (!nodeId) continue;

      const designation = intermediateDesignation(sourceName, sourceKind, nextOrdinal(sourceName));
      claimedCoords.add(coord);
      nodeDesignations.set(nodeId, designation);
      sourceOf.set(nodeId, sourceName);
    }
  }

  return { nodeDesignations, counters, sourceOf };
}

/**
 * The asset id a route's step produced, matching `assets.js`.
 *
 * Duplicated in form, not in policy: the two must agree on which node a route
 * created, so this mirrors `nodeAssetIdForStep` and refuses to guess when the
 * coordinate turns out to belong to a named endpoint instead.
 *
 * @param {object} route Resolved route record.
 * @param {number} step Zero-based step within the route.
 * @param {number} spanCount Total spans in the route.
 * @param {Map<string, object>} endpointByCoord Endpoints keyed by `x,y`.
 * @param {string} coord The step's coordinate key.
 * @returns {string|null}
 */
function routeNodeAssetId(route, step, spanCount, endpointByCoord, coord) {
  if (endpointByCoord.has(coord)) return null;
  return step === spanCount - 1
    ? `dst:${route.routeId}`
    : `mid:${route.routeId}:${step}`;
}

/**
 * The coordinate key a node asset id stands for, when it can be known from the id.
 *
 * A `mid:`/`dst:` id does not carry a coordinate, so this reads it from the route
 * record instead. Used only to seed the claimed-coordinate set from a saved
 * project.
 *
 * @param {string} nodeId Node asset id.
 * @param {object} network Built network.
 * @param {Map<string, object>} endpointById Endpoints by id.
 * @returns {string|null}
 */
function coordinateOfNodeId(nodeId, network, endpointById) {
  if (nodeId === 'origin') return `${network.originPosition.x},${network.originPosition.y}`;
  const endpoint = endpointById.get(nodeId);
  if (endpoint) return `${endpoint.position.x},${endpoint.position.y}`;
  const match = /^(?:mid|dst):(.+?)(?::(\d+))?$/.exec(nodeId);
  if (!match) return null;
  const route = (network.routes ?? []).find((r) => r.routeId === match[1]);
  if (!route || !route.ok || !Array.isArray(route.path)) return null;
  // `path` starts at the route's source, so the k-th intermediate pole is the point
  // at `k + 1`, and a destination id is the path's last point. Reading `path[k]`
  // would put every intermediate pole on the source it started from.
  const index = match[2] === undefined ? route.path.length - 1 : Number(match[2]) + 1;
  const point = route.path[index];
  return point ? `${point.x},${point.y}` : null;
}

/**
 * The human-readable designation of a span, from its two endpoints' designations.
 *
 * A span has no name of its own that a reader could learn, so its name is the pair
 * of points it joins, in the order the span was first drawn:
 *
 *   Origin–Origin:1     A–A1     A1–A2     A2–B     FPB1–FPB1:1
 *
 * The separator is an en dash, which is what a printed schedule uses and what
 * distinguishes `A1–A2` (one span) from `A1, A2` (two points).
 *
 * @param {string} fromDesignation Designation of the span's first endpoint.
 * @param {string} toDesignation Designation of the span's second endpoint.
 * @returns {string}
 */
export function spanDesignation(fromDesignation, toDesignation) {
  const from = fromDesignation ?? '?';
  const to = toDesignation ?? '?';
  return `${from}\u2013${to}`;
}

/** The separator used between the two halves of a span designation. */
export const SPAN_SEPARATOR = '\u2013';

/**
 * Continue a set of source counters from a set of designations in use.
 *
 * A project that stored designations but not counters can rebuild them, so a new
 * pole never takes a number that is already visible in the schedules.
 *
 * @param {Iterable<string>} designations Designations in use.
 * @returns {Map<string, number>} Source name -> next unused ordinal.
 */
export function countersFromDesignations(designations) {
  const counters = new Map();
  for (const designation of designations) {
    const parts = splitDesignation(designation);
    if (!parts) continue;
    const next = counters.get(parts.sourceName) ?? 1;
    if (parts.ordinal + 1 > next) counters.set(parts.sourceName, parts.ordinal + 1);
  }
  return counters;
}

/**
 * Whether a designation belongs to a pole sequence rather than a named point.
 *
 * The said-as-out-loud test: `A1` and `Origin:3` are poles; `A`, `Origin`, `TC2`
 * and `FPB1` are the named points themselves.
 *
 * @param {string} designation Designation to test.
 * @param {Set<string>|Array<string>} namedPoints Designations of the named points.
 * @returns {boolean}
 */
export function isPoleDesignation(designation, namedPoints) {
  const named = namedPoints instanceof Set ? namedPoints : new Set(namedPoints ?? []);
  if (named.has(designation)) return false;
  return Boolean(splitDesignation(designation));
}
