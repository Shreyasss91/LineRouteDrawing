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
import {
  clipSegmentOutsidePolygon,
  fpbRectVertices,
  tcTriangleVertices,
} from './markers.js';

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

/**
 * Approximate rendered width of a string for a given font size.
 *
 * The marker box must fit its text in every renderer, and neither SVG nor PDF
 * can measure text at build time, so a conservative per-character width is used
 * for Helvetica/Arial. It is deliberately slightly generous: an over-wide box
 * looks correct, a tight one clips the label.
 *
 * @param {string} text Text to measure.
 * @param {number} fontSize Font size in px.
 * @returns {number} Estimated width in px.
 */
export function measureFpbText(text, fontSize) {
  return String(text).length * fontSize * 0.62;
}

/**
 * Build a feeder pillar box primitive.
 *
 * This is the single definition of an FPB box's geometry. The scene builder
 * writes it into the scene, the renderers draw it from the scene, and the line
 * clipping reads its corners through `fpbRectVertices`. Nothing else calculates
 * a box size, so the symbol drawn and the hole left in the lines always agree.
 *
 * @param {{key: string, fpbName?: string}} node Node carrying the FPB marker.
 * @param {{x: number, y: number}} p Pixel position of the anchor.
 * @param {object} config Drawing configuration.
 * @returns {object} FPB primitive, sized from its own label.
 */
function createFpbPrimitive(node, p, config) {
  // The box is sized from its own text, so it always fits the label.
  const text = config.fpbText;
  const fontSize = config.fpbFontSize;
  const textWidth = measureFpbText(text, fontSize);
  const boxWidth = textWidth + config.fpbPaddingX * 2;
  const boxHeight = fontSize + config.fpbPaddingY * 2;
  return {
    id: `fpb:${node.key}`,
    x: p.x,
    y: p.y,
    width: boxWidth,
    height: boxHeight,
    text,
    name: node.fpbName,
    fontSize,
    // Centre the box on the anchor so the line enters and leaves it evenly.
    boxX: p.x - boxWidth / 2,
    boxY: p.y - boxHeight / 2,
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

  // Keep the TC triangle inside one span however the spacing is set, so a
  // marker can never overlap the neighbouring pole. At and above the default
  // spacing this is 1 and the configured size is used unchanged.
  const tcScale = Math.min(
    1,
    (config.spanLength * config.tcMaxSpanFraction) / config.tcMarkerHeight,
  );

  const lines = [];
  const poles = [];
  const tc = [];
  const fpb = [];
  const labels = [];
  const junctions = [];

  // Every marker is resolved before the lines, because no line may be drawn
  // through the inside of a symbol. Each marker becomes a hole the lines are
  // trimmed against, so all of their geometry is known before a line is final.
  const tcShapes = [];
  if (activeProfile.showTcMarkers) {
    for (const node of nodes) {
      if (!node.tcId) continue;
      const p = toPixel(node);
      const shape = {
        id: `tc:${node.key}`,
        x: p.x,
        y: p.y,
        halfWidth: config.tcMarkerSize * tcScale,
        height: config.tcMarkerHeight * tcScale,
        name: node.tcName,
      };
      shape.vertices = tcTriangleVertices(shape);
      tcShapes.push(shape);
    }
  }

  // The feeder pillar boxes are resolved the same way. Their outline is read
  // from the same primitive the renderers draw, so the trimmed gap matches the
  // rectangle exactly.
  const fpbShapes = [];
  if (activeProfile.showFpbMarkers) {
    for (const node of nodes) {
      if (!node.fpbId) continue;
      const shape = createFpbPrimitive(node, toPixel(node), config);
      shape.vertices = fpbRectVertices(shape);
      fpbShapes.push(shape);
    }
  }

  // One hole per marker, of either kind, trimmed in a single pass.
  const holes = [...tcShapes, ...fpbShapes];

  if (activeProfile.showLines) {
    for (const edge of network.graph.edges.values()) {
      const a = network.graph.nodes.get(edge.a);
      const b = network.graph.nodes.get(edge.b);
      if (!a || !b) continue;
      const pa = toPixel(a);
      const pb = toPixel(b);
      // Trim the line to the outside of every marker it crosses, so the route
      // appears to enter and leave the symbol without running over it. This is
      // a scene operation on pixel coordinates: the canonical network graph and
      // its topology are never modified.
      let parts = [{ x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y }];
      for (const shape of holes) {
        parts = parts.flatMap((part) =>
          clipSegmentOutsidePolygon(part.x1, part.y1, part.x2, part.y2, shape.vertices),
        );
        if (parts.length === 0) break;
      }
      parts.forEach((part, index) => {
        lines.push({
          id: parts.length > 1 ? `line:${edge.key}#${index}` : `line:${edge.key}`,
          parentId: `line:${edge.key}`,
          x1: part.x1,
          y1: part.y1,
          x2: part.x2,
          y2: part.y2,
          strokeWidth: config.lineWidth,
          sources: edge.sources.map((s) => s.routeId),
        });
      });
    }
  }

  for (const node of nodes) {
    const p = toPixel(node);
    // A TC point is shown by its triangle only, and a feeder pillar box by its
    // rectangle only. Drawing an X on top of either would put two symbols at one
    // coordinate and muddy both, so the marker takes the place of the crossing.
    const isTcAnchor = Boolean(node.tcId) && activeProfile.showTcMarkers;
    const isFpbAnchor = Boolean(node.fpbId) && activeProfile.showFpbMarkers;
    if (activeProfile.showPoleMarkers && !isTcAnchor && !isFpbAnchor) {
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
    if (activeProfile.showOriginLabel && node.isOrigin) {
      labels.push({
        id: `label-origin:${node.key}`,
        kind: 'origin',
        x: p.x,
        y: p.y,
        text: 'Origin',
        anchor: 'start',
        fontSize: config.labelFontSize,
        offsetX: config.poleMarkerSize + 8,
        offsetY: -config.poleMarkerSize - 9,
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
        offsetY: -config.poleMarkerSize - 9,
      });
    }
  }

  for (const shape of tcShapes) {
    const { vertices, ...primitive } = shape;
    tc.push(primitive);
  }
  for (const shape of fpbShapes) {
    const { vertices, ...primitive } = shape;
    fpb.push(primitive);
  }

  // Deterministic ordering keeps diffing, tests and exports stable.
  const byXThenY = (a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x);
  lines.sort(byXThenY);
  poles.sort(byXThenY);
  tc.sort(byXThenY);
  fpb.sort(byXThenY);
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
    fpb,
    labels,
    junctions,
    /** True when any visible text exists; exports must be false. */
    hasVisibleText: labels.length > 0,
  };
}
