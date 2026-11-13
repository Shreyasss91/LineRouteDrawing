/**
 * Annotation layer: computes callout and span-length placements for a scene.
 *
 * The scene builder calls this after every symbol, line and label is final, so
 * the layer can avoid them all. It produces two lists of annotations - callouts
 * for node loads and labels for span lengths - which the SVG, PDF and print
 * renderers each draw from the same records.
 *
 * Determinism matters here as much as correctness: the layout pass must produce
 * the same positions for the same input every time, or a re-export would drift
 * and a saved placement would point at the wrong place. So there is no
 * randomness, and the pass order is fixed: callouts first (they are the denser,
 * more constrained objects), then span labels, with each taking the others'
 * claimed boxes into account.
 */

import {
  annotation,
  arrowHead,
  buildLeader,
  measureBlock,
  placeCallout,
  placeSpanLabel,
} from './annotations.js';
import { boxesOverlap } from './collide.js';
import { createObstacleIndex } from './spatial_index.js';
import { buildAssetRegistry } from './assets.js';
import { loadCalloutLines } from '../data/schedules.js';

/**
 * Build the annotation records for a scene.
 *
 * @param {object} input
 * @param {object} input.network Built network.
 * @param {object} input.profile Active render profile.
 * @param {object} input.config Drawing configuration.
 * @param {Array<object>} input.lines Final line primitives.
 * @param {Array<object>} input.poles Pole primitives.
 * @param {Array<object>} input.tc TC primitives.
 * @param {Array<object>} input.fpb FPB primitives.
 * @param {Array<object>} input.labels Label primitives.
 * @param {number} input.width Scene width in px.
 * @param {number} input.height Scene height in px.
 * @param {object} input.data Measured data `{loads, spanLengths, loadPlacements, spanPlacements}`.
 * @returns {{callouts: Array<object>, spans: Array<object>, obstacles: Array<object>}}
 */
export function buildAnnotationLayer(input) {
  const { network, profile, config, lines, poles, tc, fpb, width, height, data } = input;
  // Placement must not depend on the profile. The exports draw no letters, but the
  // space those letters occupy still governs where an annotation can go, so the
  // unfiltered label slots are what the layout reads.
  const labels = input.labelSlots ?? input.labels ?? [];
  const loads = data.loads ?? [];
  const spanLengths = data.spanLengths instanceof Map ? data.spanLengths : new Map();
  const loadPlacements = data.loadPlacements ?? {};
  const spanPlacements = data.spanPlacements ?? {};

  const callouts = [];
  const spans = [];
  // The layout runs in a frame with no padding, then every coordinate is shifted
  // into the scene by the padding actually in use. Doing it this way is what makes
  // the preview and the exports agree: the preview and the sheet have different
  // margins, and a layout computed against the padded frame would place the same
  // callout in two different spots depending only on which margin was chosen.
  const padIn = input.padding ?? 0;
  const bounds = {
    width: width - padIn * 2,
    height: height - padIn * 2,
  };
  const toFrame = (point) => ({ x: point.x - padIn, y: point.y - padIn });
  const fromFrame = (point) => ({ x: point.x + padIn, y: point.y + padIn });

  if (!profile.showAnnotations) {
    return { callouts, spans, obstacles: [], notice: null, completeness: null };
  }

  // The registry is what links measured records to drawn geometry. A load is
  // stored against a node asset id; the registry says which pixel that node has.
  const registry = buildAssetRegistry(network);
  const nodeById = new Map(registry.allNodeAssets().map((a) => [a.id, a]));
  const spanAssets = registry.allSpanAssets();
  const spanById = new Map(spanAssets.map((s) => [s.id, s]));

  // Pixel position of every node with a drawn marker. The X marks the pole and
  // the FPB box marks its own centre.
  const nodePixel = new Map();
  // Scene primitives are keyed by coordinate, because that is what the drawing
  // needs; the measured records are keyed by asset id. `coordKey` is the bridge.
  const nodeByCoord = new Map(registry.allNodeAssets().map((a) => [a.coordKey, a]));
  for (const pole of poles) {
    const coord = String(pole.id).replace(/^pole:/, '');
    const node = nodeByCoord.get(coord);
    if (node) nodePixel.set(node.id, toFrame({ x: pole.x, y: pole.y }));
  }
  for (const box of fpb) {
    const coord = String(box.id).replace(/^fpb:/, '');
    const node = nodeByCoord.get(coord);
    if (node) nodePixel.set(node.id, toFrame({ x: box.x, y: box.y }));
  }
  // A TC has no pole and no box, but a span can end at one, and its length still
  // has to be shown. The triangle's anchor is the node's position, so a label
  // placed from here sits beside the symbol correctly.
  for (const triangle of tc) {
    const coord = String(triangle.id).replace(/^tc:/, '');
    const node = nodeByCoord.get(coord);
    if (node) nodePixel.set(node.id, toFrame({ x: triangle.x, y: triangle.y }));
  }

  // A static obstacle per line. Using the final (clipped) line primitives means a
  // callout also avoids the trimmed parts, which is where the symbols are.
  const lineBoxes = lines.map((line) => ({
    box: {
      x1: Math.min(line.x1, line.x2) - 1 - padIn,
      y1: Math.min(line.y1, line.y2) - 1 - padIn,
      x2: Math.max(line.x1, line.x2) + 1 - padIn,
      y2: Math.max(line.y1, line.y2) + 1 - padIn,
    },
  }));

  // Marker extents as boxes, from the same primitives the renderers draw.
  const markerBoxes = [];
  for (const shape of [...tc, ...fpb]) {
    const p = {
      x: shape.x - padIn,
      y: shape.y - padIn,
      width: shape.width ?? shape.halfWidth * 2,
      height: shape.height,
    };
    markerBoxes.push({ box: { x1: p.x - p.width / 2, y1: p.y - p.height / 2, x2: p.x + p.width / 2, y2: p.y + p.height / 2 } });
  }
  for (const pole of poles) {
    const size = config.poleMarkerSize / 2 + 1;
    const x = pole.x - padIn;
    const y = pole.y - padIn;
    markerBoxes.push({ box: { x1: x - size, y1: y - size, x2: x + size, y2: y + size } });
  }
  for (const label of labels) {
    const w = measureBlock([label.text], config, label.fontSize).width;
    const lx = label.x - padIn + label.offsetX;
    const ly = label.y - padIn + label.offsetY;
    markerBoxes.push({
      box: {
        x1: lx - w / 2,
        y1: ly - label.fontSize / 2,
        x2: lx + w / 2,
        y2: ly + label.fontSize / 2,
      },
    });
  }

  const obstacles = [...lineBoxes, ...markerBoxes];
  const taken = [];

  // One broad-phase index for this scene (F13). It is built here, seeded with the static
  // obstacles in the order they were collected, and then grows with each accepted
  // annotation. It is local to this call and to nothing else: no module-level state, so two
  // scenes cannot affect each other and a reload starts from an empty grid.
  //
  // The index never decides anything. It narrows which obstacles are worth asking about;
  // `annotateCollides` still answers every one of them, so the placements this pass
  // produces are the placements the exhaustive scan produced.
  const index = createObstacleIndex({ clearance: config.annotClearance });
  for (const obstacle of obstacles) index.insert(obstacle.box ?? obstacle);

  // Export visibility is decided HERE, once, from the profile - not inside a renderer.
  // Both the SVG and the PDF draw whatever this layer hands them, so a switch applied
  // at this single point cannot drift between the two formats. Nothing is deleted: the
  // measured data and the placements stay exactly as they were, and only the records
  // this particular output is allowed to show are built. The preview profile keeps
  // both flags true, so the working view always shows everything entered.
  const showNodeLoads = profile.showNodeLoads !== false;
  const showSpanLengths = profile.showSpanLengths !== false;

  // ---- Callouts: group every load on a node into one box ----
  const byNode = new Map();
  for (const load of loads) {
    if (!byNode.has(load.nodeId)) byNode.set(load.nodeId, []);
    byNode.get(load.nodeId).push(load);
  }

  for (const [nodeId, nodeLoads] of byNode) {
    if (!showNodeLoads) break;
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const position = nodePixel.get(nodeId);
    if (!position) continue;

    const lines = loadCalloutLines(loads, nodeId);
    if (lines.length === 0) continue;
    const size = measureBlock(lines, config, config.annotLoadFontSize);
    const placement = placeCallout({
      node: position,
      size,
      obstacles,
      taken,
      bounds,
      offset: loadPlacements[nodeId],
      config,
      index,
    });

    const callout = annotation(
      { ...placement, center: fromFrame(placement.center) },
      `callout:${nodeId}`,
      'load',
      nodeId,
      lines,
      config.annotLoadFontSize,
    );
    // The leader is built in the same unpadded frame the placement was solved in,
    // so the arrow tip lands on the pole rather than padding pixels away from it.
    callout.leader = buildLeader(
      position,
      { x: placement.center.x, y: placement.center.y },
      size,
      config,
    );
    callout.leader = {
      ...callout.leader,
      x1: callout.leader.x1 + padIn,
      y1: callout.leader.y1 + padIn,
      x2: callout.leader.x2 + padIn,
      y2: callout.leader.y2 + padIn,
      tipX: callout.leader.tipX + padIn,
      tipY: callout.leader.tipY + padIn,
    };
    callout.arrow = arrowHead(callout.leader, config);
    // The callout claims its box for the span labels, and enters the index at the same
    // moment so the next annotation sees exactly what `taken` holds - no earlier, no later.
    const claimed = {
      x1: placement.center.x - size.width / 2,
      y1: placement.center.y - size.height / 2,
      x2: placement.center.x + size.width / 2,
      y2: placement.center.y + size.height / 2,
    };
    taken.push(claimed);
    index.insert(claimed);
    callouts.push(callout);
  }

  // ---- Span labels: one per physical span, measured or not ----
  //
  // An unmeasured span is drawn too, with a dash for the number. A span with no
  // label at all is worse than a span with an honest placeholder: the drawing then
  // looks finished while a measurement is missing, and nobody reading the sheet
  // can tell the difference between "not surveyed" and "no span here".
  for (const asset of spanAssets) {
    if (!showSpanLengths) break;
    const a = nodeById.get(asset.a);
    const b = nodeById.get(asset.b);
    const pa = nodePixel.get(asset.a);
    const pb = nodePixel.get(asset.b);
    if (!pa || !pb) continue;

    const record = spanLengths.get(asset.id);
    const lengthM = record && typeof record === 'object' ? record.lengthM : record;
    const measured = lengthM !== null && lengthM !== undefined && Number.isFinite(Number(lengthM));
    const text = `${formatLength(lengthM)} m`;
    const size = measureBlock([text], config, config.annotSpanFontSize);
    const span = { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y };

    const placement = placeSpanLabel({
      span,
      size,
      obstacles,
      taken,
      bounds,
      offset: spanPlacements[asset.id],
      config,
      index,
    });

    const spanAnnot = annotation(
      { ...placement, center: fromFrame(placement.center) },
      `span:${asset.id}`,
      'span',
      asset.id,
      [text],
      config.annotSpanFontSize,
    );
    spanAnnot.a = a;
    spanAnnot.b = b;
    spanAnnot.measured = measured;
    spans.push(spanAnnot);
    const claimed = {
      x1: placement.center.x - size.width / 2,
      y1: placement.center.y - size.height / 2,
      x2: placement.center.x + size.width / 2,
      y2: placement.center.y + size.height / 2,
    };
    taken.push(claimed);
    index.insert(claimed);
  }

  // ---- The incomplete-data notice ----
  //
  // Placed after everything else so it can claim a corner no annotation wanted. It
  // is deliberately a scene record rather than a DOM element: the preview, the PDF,
  // the SVG and the print all have to carry it, and the only way to guarantee that
  // is for all four to draw it from the same source.
  const totalSpans = spanAssets.length;
  const measuredCount = spans.filter((span) => span.measured).length;
  const completeness =
    totalSpans > 0
      ? { total: totalSpans, measured: measuredCount, unmeasured: totalSpans - measuredCount }
      : { total: 0, measured: 0, unmeasured: 0 };
  // The notice is an application status message, not a mark that belongs on a
  // technical sheet, so an export profile turns it off entirely - text and box both.
  // The completeness numbers are still computed above, because the schedule headers
  // and the browser summary report them regardless of which profile is rendering.
  let notice = null;
  if (profile.showCompleteNotice !== false && completeness.unmeasured > 0) {
    const text = `Span measurements incomplete: ${completeness.unmeasured} of ${completeness.total} spans unmeasured.`;
    const size = measureBlock([text], config, config.annotSpanFontSize);
    // Bottom-left of the drawing frame, inside the padding, where a route drawing
    // is least likely to have content and where a footnote belongs.
    const pad = 6;
    const center = {
      x: bounds.width / 2,
      y: bounds.height - size.height / 2 - pad,
    };
    notice = {
      id: 'notice:completeness',
      text,
      center: fromFrame(center),
      size,
      fontSize: config.annotSpanFontSize,
      boxes: {
        x1: center.x - size.width / 2 - 4,
        y1: center.y - size.height / 2 - 3,
        x2: center.x + size.width / 2 + 4,
        y2: center.y + size.height / 2 + 3,
      },
    };
  }

  return { callouts, spans, obstacles, notice, completeness };
}

/** Format a measured length for a label. */
export function formatLength(lengthM) {
  if (lengthM === null || lengthM === undefined) return '—';
  const value = Number(lengthM);
  if (!Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

// boxesOverlap is re-exported so the caller can reuse the same rule without
// importing the collision module twice.
export { boxesOverlap };
