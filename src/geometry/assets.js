/**
 * Asset identity: stable ids for the physical things a drawing is made of.
 *
 * WHY THIS EXISTS
 *
 * Load records belong to a pole. Span lengths belong to the cable between two
 * poles. Both outlive a single edit of the route list, so both need an identity
 * that survives an edit and never silently moves to something else.
 *
 * The canonical graph keys nodes by coordinate (`"3,-2"`) and edges by their two
 * coordinates. That is right for drawing, and wrong for ownership: a coordinate
 * says where a pole is drawn, not which pole it is. Shortening an earlier route
 * shifts everything after it, so the pole that held a 25 kVA load can end up at
 * a different coordinate - and a coordinate-keyed store would then either lose
 * the load or, worse, hand it to whatever now sits at the old coordinate.
 *
 * THE MODEL
 *
 * Every asset is identified by the route that created it:
 *
 *   node `origin`            the Origin
 *   node `dst:<routeId>`     the destination created by that route row
 *   node `mid:<routeId>:<k>` the k-th intermediate pole walked by that route
 *
 * Every intermediate pole and destination is created by exactly one route, and
 * that route's id is preserved across replans, so the id is stable for a given
 * route row. It is immutable: it is never recomputed from a label or a
 * coordinate, and it is never reused for a different asset.
 *
 * A span is the unit edge between two node ids, ordered so the pair has one key:
 *
 *   span `<nodeIdA>~<nodeIdB>`   endpoints sorted, so direction is irrelevant
 *
 * Two routes that walk the same physical edge produce the same span id, which is
 * what makes an overlapping edge carry one length and one annotation.
 *
 * THE ONE PLACE COORDINATES ARE USED
 *
 * When two routes walk the same edge, the edge has two candidate span ids - one
 * from each route's node pairing. They describe the same cable, so the first one
 * seen wins and is recorded as the alias of the other. That is a merge, not an
 * assignment: it is how "one physical edge, one id" is enforced. Ownership of
 * data still rests on the id, never on the coordinate.
 *
 * WHAT HAPPENS WHEN AN ASSET DISAPPEARS
 *
 * A removed asset's id simply stops appearing in the live registry. Its data is
 * not deleted and not reassigned: `reconcile` reports it as unresolved so the
 * user can decide. Nothing in this module ever moves a record from one asset to
 * another.
 */

/**
 * Node id of the Origin.
 *
 * The Origin is fixed at the grid origin and cannot be created by a route, so it
 * has a constant id.
 */
import { spanDesignation } from './designations.js';

export const ORIGIN_NODE = 'origin';

/**
 * Identity of the destination created by a route row.
 *
 * @param {string} routeId Route id, stable across edits.
 * @returns {string} Node asset id.
 */
export function destinationAssetId(routeId) {
  return `dst:${routeId}`;
}

/**
 * Identity of the k-th intermediate pole walked by a route.
 *
 * Intermediate poles are the ones the tool places automatically between a route's
 * start and its end. They are as real as any other pole - loads are entered on
 * them - so they need identity too, and the route that walks them plus the step
 * number is stable.
 *
 * @param {string} routeId Route id.
 * @param {number} step Zero-based index of the intermediate pole within the route.
 * @returns {string} Node asset id.
 */
export function intermediateAssetId(routeId, step) {
  return `mid:${routeId}:${step}`;
}

/**
 * Canonical id of the span between two node assets.
 *
 * Endpoints are sorted so the same physical cable has one id whichever way a
 * route walks it.
 *
 * @param {string} a First node asset id.
 * @param {string} b Second node asset id.
 * @returns {string} Span asset id.
 */
export function spanAssetId(a, b) {
  return String(a) <= String(b) ? `${a}~${b}` : `${b}~${a}`;
}

/** Whether a string looks like one of the ids this module produces. */
export function isAssetId(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The identity of the node a route step lands on.
 *
 * A route walks `spans` steps. Every step but the last lands on an intermediate
 * pole; the last lands on the route's destination. Both are derived from the
 * route id, never from the coordinate.
 *
 * @param {string} routeId Route id.
 * @param {number} stepIndex Zero-based step within the route.
 * @param {number} spanCount Total steps in the route.
 * @returns {string} Node asset id.
 */
export function nodeAssetIdForStep(routeId, stepIndex, spanCount) {
  return stepIndex === spanCount - 1
    ? destinationAssetId(routeId)
    : intermediateAssetId(routeId, stepIndex);
}

/**
 * Build the asset identity registry for one built network.
 *
 * Walks the resolved routes in order and records, for every node and every edge
 * the drawing contains, which asset it is. The result is a lookup from the
 * graph's own coordinate keys to asset ids, plus the reverse.
 *
 * A node reached by more than one route keeps the id of the first route that
 * created it. That is what makes a junction shared by two branches one asset
 * with one set of loads, rather than two assets that happen to be drawn at the
 * same point.
 *
 * @param {ReturnType<import('./network.js').buildNetwork>} network Built network.
 * @param {object} [options]
 * @param {Map<string, string>} [options.designations] Node asset id -> point
 *   designation, from `designations.allocateDesignations`. When absent a node's
 *   designation is the label it is drawn with, so a caller that does not care
 *   about schedule names still gets a usable one.
 * @returns {{
 *   nodeIds: Map<string, string>,
 *   nodeKeys: Map<string, string>,
 *   edgeIds: Map<string, string>,
 *   edgeAliases: Map<string, string>,
 *   nodeAsset(id: string): object|null,
 *   edgeAsset(id: string): object|null,
 *   allNodeAssets(): Array<object>,
 *   allSpanAssets(): Array<object>,
 * }}
 */
export function buildAssetRegistry(network, options = {}) {
  /** asset id -> {id, kind, coordKey, x, y, label, nodeType} */
  const nodeAssets = new Map();
  /** coordKey -> asset id */
  const nodeIds = new Map();
  /** asset id -> coordKey */
  const nodeKeys = new Map();
  /** canonical span id -> {id, a, b, coordKey, fromKey, toKey, aliases} */
  const spanAssets = new Map();
  /** coordKey of an edge -> canonical span id */
  const edgeIds = new Map();
  /** non-canonical candidate id -> canonical id, for merged overlaps */
  const edgeAliases = new Map();

  const graph = network.graph;
  const endpoints = network.endpoints ?? [];
  const designationOf = options.designations ?? null;

  /** The display name a node is drawn with, if any. */
  function labelFor(coordKeyValue) {
    const endpoint = endpoints.find((e) => `${e.position.x},${e.position.y}` === coordKeyValue);
    if (endpoint) return endpoint.displayName ?? endpoint.name ?? null;
    return null;
  }

  /** Which of the three kinds of ordinary point a node is drawn as. */
  function kindFor(node) {
    if (node.isOrigin) return 'origin';
    if (node.fpbId) return 'fpb';
    if (node.tcId) return 'tc';
    return 'pole';
  }

  /**
   * Record a node under an asset id, unless it already has one.
   *
   * First writer wins: the earliest route to reach a coordinate owns it, so
   * identity follows creation order the same way the alphabetical labels do.
   */
  function claimNode(coordKeyValue, assetId) {
    if (nodeIds.has(coordKeyValue)) return nodeIds.get(coordKeyValue);
    const node = graph.nodes.get(coordKeyValue);
    if (!node) return null;
    nodeIds.set(coordKeyValue, assetId);
    nodeKeys.set(assetId, coordKeyValue);
    nodeAssets.set(assetId, {
      id: assetId,
      kind: 'node',
      coordKey: coordKeyValue,
      x: node.x,
      y: node.y,
      label: labelFor(coordKeyValue),
      // The name a schedule uses. A designation keyed by asset id wins, because it
      // is what survives an edit; the drawn label is the fallback so a plain caller
      // still gets a name rather than a blank column.
      designation: designationOf?.get(assetId) ?? labelFor(coordKeyValue),
      nodeType: kindFor(node),
      isOrigin: Boolean(node.isOrigin),
    });
    return assetId;
  }

  // The Origin is claimed first: it is the anchor every coordinate is relative
  // to, and it is never created by a route.
  claimNode(`${network.originPosition.x},${network.originPosition.y}`, ORIGIN_NODE);

  // Each resolved route walks its own steps, claiming the nodes along the way.
  for (const route of network.routes ?? []) {
    if (!route.ok || !Array.isArray(route.path)) continue;
    const spanCount = route.path.length - 1;
    for (let step = 0; step < spanCount; step += 1) {
      const to = route.path[step + 1];
      const assetId = nodeAssetIdForStep(route.routeId, step, spanCount);
      const claimed = claimNode(`${to.x},${to.y}`, assetId);
      if (claimed && claimed !== assetId) {
        // The coordinate already belonged to an earlier asset. This is the same
        // physical pole reached by a second route, so no new asset is created.
        continue;
      }
    }
  }

  // Any node with no route walking it is still a real drawn pole, so it gets an
  // id derived from its own coordinate. This only happens for nodes that exist
  // without being a route step, which the current builder does not produce, but
  // leaving a drawn node unidentified would be worse than a positional fallback.
  for (const node of graph.nodes.values()) {
    if (!nodeIds.has(node.key)) claimNode(node.key, `node:${node.key}`);
  }

  // Span identity: the unit edge between the two node assets on either side.
  for (const edge of graph.edges.values()) {
    const aAsset = nodeIds.get(edge.a);
    const bAsset = nodeIds.get(edge.b);
    if (!aAsset || !bAsset) continue;
    const candidate = spanAssetId(aAsset, bAsset);

    if (edgeIds.has(edge.key)) {
      const canonical = edgeIds.get(edge.key);
      if (canonical !== candidate) edgeAliases.set(candidate, canonical);
      continue;
    }

    // Another edge may already have produced this same pair of assets by a
    // different route. That would mean two edges joining the same two assets,
    // which the grid cannot produce; the first is canonical regardless.
    const existing = [...spanAssets.values()].find((s) => s.id === candidate);
    const canonicalId = existing ? existing.id : candidate;
    if (!existing) {
      // Orientation is a display decision, not an identity one: a cable has no
      // intrinsic direction. It is fixed from the first route that walked it, so a
      // schedule reads `A1 -> A2` the way the drawing was built, and a later route
      // walking it backwards reuses the same record rather than producing a
      // mirrored duplicate. Because it is chosen once, it is deterministic.
      const provenance = (edge.sources ?? [])[0] ?? null;
      const firstFrom = provenance ? provenance.fromId : null;
      const firstCoord = provenance ? provenance.fromId : null;
      // The edge stores canonical (sorted) ends; `fromKey` is the coordinate the
      // first traversing route started that unit span at, which is what the reader
      // should see on the left.
      const startKey = firstTraversalCoord(provenance, edge);
      const forward = startKey === null || startKey === edge.a;
      const fromAsset = forward ? aAsset : bAsset;
      const toAsset = forward ? bAsset : aAsset;
      spanAssets.set(candidate, {
        id: candidate,
        kind: 'span',
        a: aAsset,
        b: bAsset,
        coordKey: edge.key,
        fromKey: edge.a,
        toKey: edge.b,
        // Display orientation and names. `from`/`to` are asset ids, and the
        // designations are filled in below, once every node is named.
        from: fromAsset,
        to: toAsset,
        fromNodeId: fromAsset,
        toNodeId: toAsset,
      });
    }
    edgeIds.set(edge.key, canonicalId);
    if (canonicalId !== candidate) edgeAliases.set(candidate, canonicalId);
  }

  // Give every span its readable name now that every pole has one. The two halves
  // come from the endpoint designations, so renaming a pole changes the span's
  // display name while its id - the key everything is stored against - does not.
  for (const span of spanAssets.values()) {
    span.fromDesignation = nodeAssets.get(span.fromNodeId)?.designation ?? null;
    span.toDesignation = nodeAssets.get(span.toNodeId)?.designation ?? null;
    span.designation = spanDesignation(span.fromDesignation, span.toDesignation);
  }

  return {
    nodeIds,
    nodeKeys,
    edgeIds,
    edgeAliases,
    nodeAsset(id) {
      return nodeAssets.get(id) ?? null;
    },
    edgeAsset(id) {
      const canonical = edgeAliases.get(id) ?? id;
      return spanAssets.get(canonical) ?? null;
    },
    /** Every node asset, in a stable order. */
    allNodeAssets() {
      return [...nodeAssets.values()].sort((a, b) =>
        a.coordKey === b.coordKey ? 0 : a.coordKey < b.coordKey ? -1 : 1,
      );
    },
    /** Every span asset, in a stable order. */
    allSpanAssets() {
      return [...spanAssets.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    /** Resolve any accepted id spelling to the canonical span id. */
    canonicalSpanId(id) {
      return edgeAliases.get(id) ?? id;
    },
    /** Resolve any accepted node id spelling. Coordinates are accepted as input. */
    canonicalNodeId(id) {
      if (nodeAssets.has(id)) return id;
      return nodeIds.get(String(id)) ?? null;
    },
  };
}

/**
 * The coordinate a unit span was first walked from.
 *
 * The canonical edge stores its two ends sorted, which says nothing about which
 * way the drawing was built. The first provenance record does, so this is how a
 * span decides which end belongs on the left of its schedule row. Returns null
 * when there is no provenance, in which case the canonical order is used.
 *
 * @param {object|null} provenance First traversal record on the edge.
 * @param {object} edge Canonical edge record.
 * @returns {string|null} Coordinate key of the traversal's starting end.
 */
function firstTraversalCoord(provenance, edge) {
  if (!provenance) return null;
  // The provenance records which direction was walked and where from, but not the
  // resolved coordinate pair. The edge's own ends are the candidates, so the one
  // that matches the route's current cursor is reported; failing that the
  // canonical order is kept rather than inventing a third answer.
  if (provenance.fromKey) return provenance.fromKey;
  return null;
}

/**
 * Compare the asset ids a project's stored data refers to against the ids the
 * current network provides.
 *
 * The answer is what the user needs to know after an edit: which of their loads
 * and measurements still have a home, and which are now orphaned. Nothing is
 * moved; orphaned ids are reported so the user can reassign or discard them.
 *
 * An orphan is never "recovered" by looking for something at the same coordinate,
 * because that something is a different physical asset.
 *
 * The first argument is normally the registry `buildAssetRegistry` returned. It is
 * also accepted as `{nodeIds, spanIds}` where both are plain collections of asset
 * ids, because the registry's own `nodeIds` is keyed by coordinate - passing a
 * registry and passing a set of ids must not quietly give different answers, so the
 * registry's asset list is what is actually read.
 *
 * @param {object} live A registry from `buildAssetRegistry`, or
 *   `{nodeIds: Iterable<string>, spanIds: Iterable<string>}` of asset ids.
 * @param {Array<{nodeId?: string}>} loads Load records.
 * @param {Array<{spanId: string}>} spans Span length records.
 * @returns {{unresolvedLoads: Array<object>, unresolvedSpans: Array<object>}}
 */
export function reconcile(live, loads, spans) {
  const liveNodes = liveNodeIdSet(live);
  const liveSpans = liveSpanIdSet(live);

  return {
    unresolvedLoads: (loads ?? []).filter((load) => !liveNodes.has(load.nodeId)),
    unresolvedSpans: (spans ?? []).filter((span) => !liveSpans.has(span.spanId)),
  };
}

/**
 * Every live asset id from a registry, or from a plain id collection.
 *
 * A registry is recognised by its own functions rather than by shape, because its
 * `nodeIds` property is a coordinate-keyed Map and treating that as the id set
 * would silently mark every record unresolved.
 */
function liveNodeIdSet(live) {
  if (live && typeof live.allNodeAssets === 'function') {
    return new Set(live.allNodeAssets().map((asset) => asset.id));
  }
  const ids = live?.nodeIds ?? [];
  return ids instanceof Set ? ids : new Set(ids);
}

/** Every live span asset id, from a registry or from a plain id collection. */
function liveSpanIdSet(live) {
  if (live && typeof live.allSpanAssets === 'function') {
    return new Set(live.allSpanAssets().map((span) => span.id));
  }
  const ids = live?.spanIds ?? [];
  return ids instanceof Set ? ids : new Set(ids);
}
