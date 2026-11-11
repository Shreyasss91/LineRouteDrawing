/**
 * Scene builder: converts the canonical network graph into a normalized,
 * renderer-agnostic drawing scene.
 *
 * The scene is the ONLY thing the SVG, PDF and print renderers consume. It
 * contains already-resolved primitives in pixel space:
 *   - lines   (one per canonical edge)
 *   - poles   (one X per canonical node)
 *   - tc      (one triangle per TC node)
 *   - labels  (origin text and alphabetical labels, filtered by the profile)
 *
 * A visibility profile decides which primitive groups the scene carries. The
 * canonical network model itself is never modified, so exporting is always a
 * pure function of the model plus a profile.
 */

import { RENDER_PROFILES, createConfig } from '../config.js';
import { computeBoundingBox } from './network.js';

/**
 * Resolve a render profile by id.
 *
 * @param {string|object} profile Profile id or profile object.
 * @returns {object} Profile configuration.
 */
export function resolveProfile(profile) {
  if (profile && typeof profile === 'object' && profile.id) return profile;
  const resolved = RENDER_PROFILES[profile];
  if (!resolved) {
    throw new RangeError(`Unknown render profile: ${String(profile)}`);
  }
  return resolved;
}

/**
 * Map a grid coordinate to pixel space. Y is flipped because grid North is +Y
 * while SVG/PDF user space grows downward.
 *
 * @param {{x: number, y: number}} coord Grid coordinate.
 * @param {{x: number, y: number}} bbox Grid bounding box.
 * @param {number} spanLength Pixel length of one span.
 * @param {{x: number, y: number}} offset Pixel offset applied after scaling.
 * @returns {{x: number, y: number}}
 */
export function gridToPixel(coord, bbox, spanLength, offset = { x: 0, y: 0 }) {
  return {
    x: (coord.x - bbox.minX) * spanLength + offset.x,
    y: (bbox.maxY - coord.y) * spanLength + offset.y,
  };
}

/**
 * Compute the pixel size of the drawing for a given configuration.
 *
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} bbox Grid box.
 * @param {object} config Drawing configuration.
 * @param {number} [padding] Optional padding override in px.
 * @returns {{width: number, height: number, padding: number, contentWidth: number, contentHeight: number}}
 */
export function measureDrawing(bbox, config, padding = config.exportPadding) {
  const cols = bbox.maxX - bbox.minX;
  const rows = bbox.maxY - bbox.minY;
  const contentWidth = cols * config.spanLength;
  const contentHeight = rows * config.spanLength;
  return {
    width: contentWidth + padding * 2,
    height: contentHeight + padding * 2,
    contentWidth,
    contentHeight,
    padding,
  };
}

/** Convert a graph node set into a plain array of nodes. */
function nodeList(graph) {
  return [...graph.nodes.values()];
}

/**
 * Build the normalized render scene.
 *
 * @param {ReturnType<import('./network.js').buildNetwork>} network Built network.
 * @param {object|string} [profile] Render profile id or object.
 * @param {object} [configOverrides] Drawing configuration overrides.
 * @returns {object} Scene with `lines`, `poles`, `tc`, `labels` and metrics.
 */
export function buildScene(network, profile = 'preview', configOverrides = {}) {
  const activeProfile = resolveProfile(profile);
  const config = createConfig(configOverrides);
  const bbox = network.boundingBox ?? computeBoundingBox(network.graph);
  const padding = activeProfile.id === 'preview' ? config.viewPadding : config.exportPadding;
  const metrics = measureDrawing(bbox, config, padding);
  const offset = { x: metrics.padding, y: metrics.padding };

  const nodes = nodeList(network.graph);
  const toPixel = (coord) => gridToPixel(coord, bbox, config.spanLength, offset);

  const lines = [];
  const poles = [];
  const tc = [];
  const labels = [];
  const junctions = [];

  if (activeProfile.showLines) {
    for (const edge of network.graph.edges.values()) {
      const a = network.graph.nodes.get(edge.a);
      const b = network.graph.nodes.get(edge.b);
      if (!a || !b) continue;
      const pa = toPixel(a);
      const pb = toPixel(b);
      lines.push({
        id: `line:${edge.key}`,
        x1: pa.x,
        y1: pa.y,
        x2: pb.x,
        y2: pb.y,
        strokeWidth: config.lineWidth,
        sources: edge.sources.map((s) => s.routeId),
      });
    }
  }

  for (const node of nodes) {
    const p = toPixel(node);
    if (activeProfile.showPoleMarkers) {
      poles.push({
        id: `pole:${node.key}`,
        x: p.x,
        y: p.y,
        size: config.poleMarkerSize,
        degree: node.neighbors.size,
      });
    }
    if (activeProfile.showJunctionMarkers && node.neighbors.size > 2) {
      junctions.push({ id: `junction:${node.key}`, x: p.x, y: p.y, degree: node.neighbors.size });
    }
    if (activeProfile.showTcMarkers && node.tcId) {
      tc.push({
        id: `tc:${node.key}`,
        x: p.x,
        y: p.y,
        halfWidth: config.tcMarkerSize,
        height: config.tcMarkerHeight,
        name: node.tcName,
      });
    }
    if (activeProfile.showOriginLabel && node.isOrigin) {
      labels.push({
        id: `label-origin:${node.key}`,
        kind: 'origin',
        x: p.x,
        y: p.y,
        text: 'Origin',
        anchor: 'start',
        fontSize: config.labelFontSize,
        offsetX: config.poleMarkerSize + 5,
        offsetY: -config.poleMarkerSize - 5,
      });
    }
    if (activeProfile.showAlphaLabels && node.alphaLabel) {
      labels.push({
        id: `label-alpha:${node.key}`,
        kind: 'alpha',
        x: p.x,
        y: p.y,
        text: node.alphaLabel,
        anchor: 'middle',
        fontSize: config.labelFontSize,
        offsetX: 0,
        offsetY: -config.poleMarkerSize - 6,
      });
    }
  }

  // Deterministic ordering keeps diffing, tests and exports stable.
  const byXThenY = (a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x);
  lines.sort(byXThenY);
  poles.sort(byXThenY);
  tc.sort(byXThenY);
  labels.sort((a, b) => a.id.localeCompare(b.id));

  return {
    profile: activeProfile,
    config,
    bbox,
    width: metrics.width,
    height: metrics.height,
    padding: metrics.padding,
    spanLength: config.spanLength,
    fontFamily: config.fontFamily,
    lines,
    poles,
    tc,
    labels,
    junctions,
    /** True when any visible text exists; exports must be false. */
    hasVisibleText: labels.length > 0,
  };
}
