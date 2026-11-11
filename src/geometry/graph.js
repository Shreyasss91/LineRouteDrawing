/**
 * Canonical graph primitives.
 *
 * The graph is grid based: every span is one unit edge between two adjacent
 * integer coordinates. Edges are undirected and canonicalized so that the same
 * pair of adjacent coordinates is stored exactly once, no matter how many
 * routes traverse it or in which direction.
 */

import { coordKey } from './direction.js';

/**
 * Canonical, undirected key for a unit edge. Endpoints are ordered so that
 * `(1,0)-(2,0)` and `(2,0)-(1,0)` produce the same key.
 *
 * @param {{x: number, y: number}} a First coordinate.
 * @param {{x: number, y: number}} b Second coordinate.
 * @returns {string}
 */
export function edgeKey(a, b) {
  const ka = coordKey(a);
  const kb = coordKey(b);
  return ka <= kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/**
 * Create an empty canonical network graph.
 *
 * Nodes are keyed by coordinate string. Each node records its coordinate, the
 * canonical node id, the set of connected neighbour keys, and the labels that
 * belong to it (origin, alphabetical, TC).
 *
 * @returns {{
 *   nodes: Map<string, object>,
 *   edges: Map<string, object>,
 *   nextNodeId: number,
 * }}
 */
export function createGraph() {
  return { nodes: new Map(), edges: new Map(), nextNodeId: 1 };
}

/**
 * Get or create the canonical node at a coordinate.
 *
 * @param {ReturnType<typeof createGraph>} graph Target graph.
 * @param {{x: number, y: number}} position Coordinate.
 * @returns {object} The canonical node record.
 */
export function ensureNode(graph, position) {
  const key = coordKey(position);
  let node = graph.nodes.get(key);
  if (node) return node;
  node = {
    id: `n${graph.nextNodeId++}`,
    key,
    x: position.x,
    y: position.y,
    neighbors: new Set(),
    isOrigin: false,
    /** Sorted alphabetical label for this node, or null. */
    alphaLabel: null,
    /** Stable internal id of the TC marker anchored here, or null. */
    tcId: null,
    /** Display name of the TC marker, resolved by the scene builder. */
    tcName: null,
  };
  graph.nodes.set(key, node);
  return node;
}

/**
 * Add one unit edge to the graph, merging with any existing copy.
 *
 * @param {ReturnType<typeof createGraph>} graph Target graph.
 * @param {{x: number, y: number}} from Source coordinate.
 * @param {{x: number, y: number}} to Destination coordinate.
 * @param {object} provenance Route information for this traversal.
 * @returns {object} The canonical edge record.
 */
export function addEdge(graph, from, to, provenance) {
  const a = ensureNode(graph, from);
  const b = ensureNode(graph, to);
  const key = edgeKey(from, to);
  let edge = graph.edges.get(key);
  if (!edge) {
    edge = { key, a: a.key, b: b.key, sources: [] };
    graph.edges.set(key, edge);
    a.neighbors.add(b.key);
    b.neighbors.add(a.key);
  }
  edge.sources.push(provenance);
  return edge;
}

/**
 * Count how many distinct routes traverse an edge.
 *
 * @param {object} edge Canonical edge record.
 * @returns {number}
 */
export function edgeRouteCount(edge) {
  return new Set(edge.sources.map((s) => s.routeId)).size;
}
