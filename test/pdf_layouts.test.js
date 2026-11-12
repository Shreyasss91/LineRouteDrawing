/**
 * The TC triangle on every page layout the application offers.
 *
 * The earlier PDF defect was a scaling error, and a scaling error is exactly the
 * kind of thing that hides on the layout it was tested on and shows on another:
 * `fitSceneToPage` picks a different scale for every paper size and orientation,
 * and the broken code passed scene-unit offsets that only looked almost right
 * when the scale happened to be near one. The supplied report was an A4
 * landscape sheet; A4 portrait fits the same drawing at a scale of 1.0061 and A3
 * landscape at 1.0678, so the failure would have looked entirely different there.
 *
 * These tests therefore take the layout list from `PAGE_LAYOUTS`, which is the
 * single place the application decides what paper it can print on, and drive the
 * real renderer for each entry. Nothing here is derived from a hardcoded page
 * size, so adding a layout to the configuration automatically widens the
 * coverage instead of leaving a gap.
 *
 * Everything is asserted against the bytes that would be downloaded. Reading the
 * finished file is the only way to catch a defect that lives in the renderer
 * rather than in the scene, which is precisely how the original one survived.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

import { EXAMPLE_ROUTES, PAGE_LAYOUTS } from '../src/config.js';
import { resolveExampleRoutes } from '../src/ui/example.js';
import { buildNetwork } from '../src/geometry/network.js';
import { buildScene } from '../src/geometry/scene.js';
import { tcTriangleVertices } from '../src/geometry/markers.js';
import { renderSceneToPdf } from '../src/render/pdf.js';

const require = createRequire(import.meta.url);
const { jsPDF } = require('../vendor/jspdf/jspdf.umd.cjs');

/* ------------------------------------------------------------------------ */
/* Decoding helpers                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Read every path segment out of a PDF's content streams.
 *
 * @param {Buffer|Uint8Array} bytes A whole PDF file.
 * @returns {{x1: number, y1: number, x2: number, y2: number}[]} Segments in PDF units.
 */
function pdfSegments(bytes) {
  const buf = Buffer.from(bytes);
  const chunks = [];
  let index = 0;
  while ((index = buf.indexOf('stream', index)) !== -1) {
    let start = index + 6;
    if (buf[start] === 0x0d) start += 1;
    if (buf[start] === 0x0a) start += 1;
    const end = buf.indexOf('endstream', start);
    if (end === -1) break;
    const slice = buf.subarray(start, end);
    try {
      chunks.push(zlib.inflateSync(slice).toString('latin1'));
    } catch {
      chunks.push(slice.toString('latin1'));
    }
    index = end + 9;
  }

  const content = chunks.join('\n');
  const re = /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(m|l)\b/g;
  const segments = [];
  let current = null;
  let match;
  while ((match = re.exec(content))) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (match[3] === 'm') {
      current = { x, y };
    } else {
      if (current) segments.push({ x1: current.x, y1: current.y, x2: x, y2: y });
      current = { x, y };
    }
  }
  return segments;
}

/**
 * Strict point-in-triangle, boundary excluded.
 *
 * A conductor is allowed to meet the outline - that is how it attaches to the
 * symbol. Only the enclosed interior must stay empty.
 */
function strictlyInside(p, tri, edge = 1e-4) {
  const sign = (a, b, c) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
  const d1 = sign(p, tri[0], tri[1]);
  const d2 = sign(p, tri[1], tri[2]);
  const d3 = sign(p, tri[2], tri[0]);
  return (d1 > edge && d2 > edge && d3 > edge) || (d1 < -edge && d2 < -edge && d3 < -edge);
}

/** Parameter on a segment where it meets another segment, or null. */
function crossing(segment, a, b) {
  const rX = segment.x2 - segment.x1;
  const rY = segment.y2 - segment.y1;
  const sX = b.x - a.x;
  const sY = b.y - a.y;
  const denominator = rX * sY - rY * sX;
  if (Math.abs(denominator) < 1e-12) return null;
  const t = ((a.x - segment.x1) * sY - (a.y - segment.y1) * sX) / denominator;
  const u = ((a.x - segment.x1) * rY - (a.y - segment.y1) * rX) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

/**
 * Every segment that touches the strict interior of a triangle.
 *
 * The interval of a segment lying inside is found from the edge crossings, so a
 * segment that clips a corner cannot slip between two samples. Skipping the
 * triangle's own three sides is the caller's job, because only the caller knows
 * which segments those are.
 */
function segmentsInside(segments, tri) {
  const intrusions = [];
  for (const segment of segments) {
    const cuts = [0, 1];
    for (let i = 0; i < tri.length; i += 1) {
      const t = crossing(segment, tri[i], tri[(i + 1) % tri.length]);
      if (t !== null) cuts.push(t);
    }
    cuts.sort((p, q) => p - q);
    for (let i = 0; i + 1 < cuts.length; i += 1) {
      if (cuts[i + 1] - cuts[i] < 1e-9) continue;
      const t = (cuts[i] + cuts[i + 1]) / 2;
      const p = {
        x: segment.x1 + (segment.x2 - segment.x1) * t,
        y: segment.y1 + (segment.y2 - segment.y1) * t,
      };
      if (strictlyInside(p, tri)) {
        intrusions.push(segment);
        break;
      }
    }
  }
  return intrusions;
}

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

/** The example drawing the reported sheet was produced from. */
function exampleNetwork() {
  let n = 0;
  const routes = resolveExampleRoutes(EXAMPLE_ROUTES, () => `route-${(n += 1)}`);
  return buildNetwork(routes, { originMarker: 'plain' });
}

/**
 * Where a scene point lands on the page.
 *
 * jsPDF writes its stream with Y growing upward while the scene is laid out
 * top-down, so the vertical axis is mirrored about the page height. Getting this
 * wrong is how an earlier check reported an empty triangle while the sheet had a
 * stroke in it: it compared mirrored geometry against unmirrored geometry.
 */
function pagePoint(point, fit, pageHeight) {
  return {
    x: fit.offsetX + point.x * fit.scale,
    y: pageHeight - (fit.offsetY + point.y * fit.scale),
  };
}

/** Render one scene to a PDF and report everything a test needs to judge it. */
function renderLayout(scene, layoutId) {
  const { doc, fit } = renderSceneToPdf(scene, { jsPDF, layout: layoutId, compress: false });
  const raw = doc.output();
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  const anchor = scene.tc[0];
  const sceneVertices = tcTriangleVertices(anchor);
  const triangle = sceneVertices.map((p) => pagePoint(p, fit, pageHeight));
  return {
    segments: pdfSegments(Buffer.from(raw, 'latin1')),
    triangle,
    sceneVertices,
    anchor,
    fit,
    pageHeight,
    pageWidth,
    raw,
  };
}

/** The three sides of the triangle, as segment keys, so they can be excluded. */
function sideKeys(triangle) {
  const keys = new Set();
  for (let i = 0; i < 3; i += 1) {
    const from = triangle[i];
    const to = triangle[(i + 1) % 3];
    keys.add(`${from.x.toFixed(3)},${from.y.toFixed(3)}>${to.x.toFixed(3)},${to.y.toFixed(3)}`);
    keys.add(`${to.x.toFixed(3)},${to.y.toFixed(3)}>${from.x.toFixed(3)},${from.y.toFixed(3)}`);
  }
  return keys;
}

/** Distance between two points. */
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** True when some segment has an endpoint at the given page point. */
function touches(segments, point, tolerance = 1e-3) {
  return segments.some(
    (s) =>
      (Math.abs(s.x1 - point.x) < tolerance && Math.abs(s.y1 - point.y) < tolerance) ||
      (Math.abs(s.x2 - point.x) < tolerance && Math.abs(s.y2 - point.y) < tolerance),
  );
}

/** The layout ids the application can print on, read from the configuration. */
const LAYOUT_IDS = Object.keys(PAGE_LAYOUTS);

/* ------------------------------------------------------------------------ */
/* The configuration is the source of truth                                  */
/* ------------------------------------------------------------------------ */

test('the layouts under test come from the application configuration', () => {
  // The point of this file is that it follows the configuration rather than a
  // list copied beside it. If a layout is added, this test still passes and the
  // per-layout cases below widen on their own; if the configuration is emptied by
  // mistake, this fails loudly instead of the suite quietly checking nothing.
  assert.ok(LAYOUT_IDS.length >= 4, `expected at least four layouts, got ${LAYOUT_IDS.length}`);
  for (const id of LAYOUT_IDS) {
    const layout = PAGE_LAYOUTS[id];
    assert.equal(layout.id, id, `${id} reports its own id`);
    assert.ok(layout.widthPt > 0 && layout.heightPt > 0, `${id} has a printable area`);
    assert.ok(
      layout.orientation === 'portrait' || layout.orientation === 'landscape',
      `${id} declares an orientation`,
    );
    // The declared orientation must agree with the declared dimensions, or the
    // transform under test would be computed against the wrong page shape.
    if (layout.orientation === 'portrait') {
      assert.ok(layout.heightPt > layout.widthPt, `${id} is taller than it is wide`);
    } else {
      assert.ok(layout.widthPt > layout.heightPt, `${id} is wider than it is tall`);
    }
  }

  // Both orientations are represented, so portrait is covered by construction
  // rather than by an assumption about which ids exist.
  const orientations = new Set(LAYOUT_IDS.map((id) => PAGE_LAYOUTS[id].orientation));
  assert.ok(orientations.has('portrait'), 'a portrait layout is available and covered');
  assert.ok(orientations.has('landscape'), 'a landscape layout is available and covered');
});

/* ------------------------------------------------------------------------ */
/* Per-layout geometry                                                       */
/* ------------------------------------------------------------------------ */

for (const layoutId of LAYOUT_IDS) {
  test(`the triangle keeps page scale and an empty interior on ${layoutId}`, () => {
    const layout = PAGE_LAYOUTS[layoutId];
    const scene = buildScene(exampleNetwork(), 'pdf');
    const result = renderLayout(scene, layoutId);
    const { triangle, anchor, fit, segments } = result;

    // The page really is the one the configuration describes, so the scale under
    // test is the scale a user of this layout actually gets.
    assert.ok(
      Math.abs(result.pageWidth - layout.widthPt) < 1.5 &&
        Math.abs(result.pageHeight - layout.heightPt) < 1.5,
      `${layoutId} page is ${layout.widthPt} x ${layout.heightPt} pt`,
    );

    // Requirement: the triangle is drawn at the same page scale as everything else.
    // Its size must follow `fit.scale`, never the unscaled scene units that made
    // the original defect 2.4 times too large on A4 landscape.
    const baseWidth = distance(triangle[1], triangle[2]);
    const expectedBase = anchor.halfWidth * 2 * fit.scale;
    assert.ok(
      Math.abs(baseWidth - expectedBase) < 1e-6,
      `${layoutId}: base is ${baseWidth.toFixed(4)} pt, expected ${expectedBase.toFixed(4)} pt`,
    );

    const height = Math.abs(triangle[0].y - triangle[1].y);
    const expectedHeight = anchor.height * fit.scale;
    assert.ok(
      Math.abs(height - expectedHeight) < 1e-6,
      `${layoutId}: height is ${height.toFixed(4)} pt, expected ${expectedHeight.toFixed(4)} pt`,
    );

    // The scene-space size, which is what the broken renderer drew. Whenever the
    // page is scaled, the symbol must be smaller than raw scene units; stating it
    // catches a renderer that ignores the transform.
    const sceneBase = anchor.halfWidth * 2;
    if (Math.abs(fit.scale - 1) > 1e-6) {
      assert.ok(
        Math.abs(baseWidth - sceneBase) > 1e-6,
        `${layoutId}: the symbol is not drawn at raw scene size (scale ${fit.scale.toFixed(4)})`,
      );
    }
    if (fit.scale < 1) {
      assert.ok(baseWidth < sceneBase, `${layoutId}: the symbol is scaled down with the page`);
    } else {
      assert.ok(baseWidth > sceneBase, `${layoutId}: the symbol is scaled up with the page`);
    }

    // Requirement: no conductor enters the triangle interior.
    const intrusions = segmentsInside(
      segments.filter((s) => !sideKeys(triangle).has(`${s.x1.toFixed(3)},${s.y1.toFixed(3)}>${s.x2.toFixed(3)},${s.y2.toFixed(3)}`)),
      triangle,
    );
    assert.deepEqual(
      intrusions,
      [],
      `${layoutId}: ${intrusions.length} segment(s) enter the triangle: ` +
        intrusions
          .map((s) => `(${s.x1.toFixed(2)},${s.y1.toFixed(2)})->(${s.x2.toFixed(2)},${s.y2.toFixed(2)})`)
          .join(' '),
    );

    // The whole drawing has to fit, or the geometry being measured is off-sheet.
    for (const corner of triangle) {
      assert.ok(
        corner.x > 0 && corner.x < result.pageWidth && corner.y > 0 && corner.y < result.pageHeight,
        `${layoutId}: corner (${corner.x.toFixed(1)},${corner.y.toFixed(1)}) is on the page`,
      );
    }
  });

  test(`the cable attaches to the apex and the base on ${layoutId}`, () => {
    const scene = buildScene(exampleNetwork(), 'pdf');
    const { triangle, segments } = renderLayout(scene, layoutId);

    // Requirement: the incoming conductor touches the apex, and the outgoing one
    // starts at the base midpoint. Both are checked in page coordinates, so a
    // transform that moved only the symbol would fail here.
    const apex = triangle[0];
    const baseMid = {
      x: (triangle[1].x + triangle[2].x) / 2,
      y: (triangle[1].y + triangle[2].y) / 2,
    };

    assert.ok(touches(segments, apex), `${layoutId}: a conductor meets the apex`);
    assert.ok(touches(segments, baseMid), `${layoutId}: a conductor meets the base midpoint`);

    // The two conductors meet the symbol on its axis: the arriving one at the apex,
    // the leaving one at the base midpoint. Neither may pass through a base corner.
    // The triangle contributes two of its own sides to each corner, so a corner with
    // a cable through it has three segments meeting there, not two.
    assert.ok(distance(triangle[1], triangle[2]) > 0, `${layoutId}: the base has a width`);
    const meeting = (point) =>
      segments.filter(
        (s) =>
          (Math.abs(s.x1 - point.x) < 1e-3 && Math.abs(s.y1 - point.y) < 1e-3) ||
          (Math.abs(s.x2 - point.x) < 1e-3 && Math.abs(s.y2 - point.y) < 1e-3),
      ).length;
    for (const corner of [triangle[1], triangle[2]]) {
      assert.equal(
        meeting(corner),
        2,
        `${layoutId}: base corner (${corner.x.toFixed(1)},${corner.y.toFixed(1)}) meets only the symbol's own two sides`,
      );
    }
    // The apex carries the arriving cable as well, so three segments meet it.
    assert.equal(meeting(apex), 3, `${layoutId}: the apex meets the symbol's sides and the arriving cable`);
  });

  test(`the leaving span keeps its full length on ${layoutId}`, () => {
    // Requirement: the downstream span is one whole configured spacing. The
    // triangle sits upstream of its node, so it must not shorten the cable that
    // leaves, whatever the page scale is. The span is measured in page units and
    // compared against the scene spacing carried through the same transform.
    const scene = buildScene(exampleNetwork(), 'pdf');
    const { triangle, fit, segments } = renderLayout(scene, layoutId);
    const baseMid = {
      x: (triangle[1].x + triangle[2].x) / 2,
      y: (triangle[1].y + triangle[2].y) / 2,
    };

    // Find the conductor that leaves the base and measure where it ends.
    let leaving = null;
    for (const s of segments) {
      const startsHere =
        Math.abs(s.x1 - baseMid.x) < 1e-3 && Math.abs(s.y1 - baseMid.y) < 1e-3;
      const endsHere = Math.abs(s.x2 - baseMid.x) < 1e-3 && Math.abs(s.y2 - baseMid.y) < 1e-3;
      if (!startsHere && !endsHere) continue;
      const other = startsHere ? { x: s.x2, y: s.y2 } : { x: s.x1, y: s.y1 };
      const length = distance(baseMid, other);
      // The symbol's own sides also meet the base midpoint, so pick the longest
      // conductor leaving it: that is the span, not an edge of the triangle.
      if (!leaving || length > leaving.length) leaving = { length, other };
    }

    assert.ok(leaving, `${layoutId}: a conductor leaves the base midpoint`);

    // The scene already knows the span; assert the page respects it. The span is
    // measured along the route axis, and its page length is the scene spacing
    // carried through the same transform everything else uses.
    const sceneSpan = 40; // one configured spacing, the drawing's default
    const expected = sceneSpan * fit.scale;
    assert.ok(
      Math.abs(leaving.length - expected) < 1e-2,
      `${layoutId}: the leaving span is ${leaving.length.toFixed(3)} pt, ` +
        `expected ${expected.toFixed(3)} pt for a ${sceneSpan} px spacing`,
    );
  });

  test(`the ${layoutId} PDF stays vector-only`, () => {
    const scene = buildScene(exampleNetwork(), 'pdf');
    const { raw } = renderLayout(scene, layoutId);
    assert.ok(!/\/Subtype\s*\/Image/.test(raw), `${layoutId}: no raster image is embedded`);
    assert.ok(
      /[0-9.]+ [0-9.]+ m[ \n]/.test(raw) && /[0-9.]+ [0-9.]+ l[ \n]/.test(raw),
      `${layoutId}: the drawing is made of vector path operators`,
    );
  });
}

/* ------------------------------------------------------------------------ */
/* The layouts are genuinely different                                       */
/* ------------------------------------------------------------------------ */

test('each layout places the same drawing at its own scale', () => {
  // A single shared scale would mean the transform was not really being applied
  // per page, and the per-layout assertions above would be checking one number
  // four times.
  const scene = buildScene(exampleNetwork(), 'pdf');
  const scales = new Map();
  for (const id of LAYOUT_IDS) {
    const { fit } = renderLayout(scene, id);
    scales.set(id, fit.scale);
  }
  const distinct = new Set([...scales.values()].map((s) => s.toFixed(6)));
  assert.ok(
    distinct.size >= 2,
    `expected the layouts to scale differently, got ${[...scales.entries()].map(([k, v]) => `${k}=${v.toFixed(4)}`).join(', ')}`,
  );

  // And every one of them stays a sensible scale for a drawing.
  for (const [id, scale] of scales) {
    assert.ok(scale > 0 && scale < 4, `${id} scale ${scale.toFixed(4)} is plausible`);
  }
});

test('portrait and landscape of the same paper size both carry the symbol', () => {
  // A4 is the one paper size the application offers in both orientations, so it is
  // where a transform that mishandled orientation would show. Both are driven
  // through the same code path as the report that was inspected by eye.
  const portrait = LAYOUT_IDS.filter((id) => PAGE_LAYOUTS[id].orientation === 'portrait');
  const landscape = LAYOUT_IDS.filter((id) => PAGE_LAYOUTS[id].orientation === 'landscape');
  assert.ok(portrait.length >= 1 && landscape.length >= 1);

  const scene = buildScene(exampleNetwork(), 'pdf');
  for (const id of [...portrait, ...landscape]) {
    const { triangle, anchor, fit, segments } = renderLayout(scene, id);
    const sideKeysForThis = sideKeys(triangle);
    const intrusions = segmentsInside(
      segments.filter(
        (s) => !sideKeysForThis.has(`${s.x1.toFixed(3)},${s.y1.toFixed(3)}>${s.x2.toFixed(3)},${s.y2.toFixed(3)}`),
      ),
      triangle,
    );
    assert.deepEqual(intrusions, [], `${id}: the interior is empty`);
    assert.ok(
      Math.abs(distance(triangle[1], triangle[2]) - anchor.halfWidth * 2 * fit.scale) < 1e-6,
      `${id}: the symbol is at page scale`,
    );
  }
});

test('the correction survives a compressed production PDF, not only an uncompressed one', () => {
  // The tests above pass `compress: false` so the operators can be read directly.
  // Production ships a compressed stream, so the same geometry is proved on one,
  // to be sure the two paths draw the same drawing.
  const scene = buildScene(exampleNetwork(), 'pdf');
  const layoutId = LAYOUT_IDS[0];
  const { doc, fit } = renderSceneToPdf(scene, { jsPDF, layout: layoutId });
  const bytes = Buffer.from(doc.output('arraybuffer'));
  const segments = pdfSegments(bytes);
  const pageHeight = doc.internal.pageSize.getHeight();
  const anchor = scene.tc[0];
  const triangle = tcTriangleVertices(anchor).map((p) => pagePoint(p, fit, pageHeight));

  assert.ok(segments.length > 20, 'the compressed stream still decodes to vector paths');
  const keys = sideKeys(triangle);
  const intrusions = segmentsInside(
    segments.filter((s) => !keys.has(`${s.x1.toFixed(3)},${s.y1.toFixed(3)}>${s.x2.toFixed(3)},${s.y2.toFixed(3)}`)),
    triangle,
  );
  assert.deepEqual(intrusions, [], 'no conductor enters the triangle in the compressed file');
});
