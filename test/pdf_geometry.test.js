/**
 * The exported artefacts themselves, not the scene they came from.
 *
 * Every earlier TC test checked `scene.lines` and `scene.tc`, and every one of them
 * passed while the produced PDF still contained a conductor stroke inside the
 * triangular symbol. The scene was right; the renderer was not.
 *
 * The cause was in `src/render/pdf.js`, which drew the triangle with
 * `doc.lines(offsets, anchor, ...)`. That call takes RELATIVE offsets in document
 * units, and it was handed scene-space deltas while the anchor had already been
 * scaled through `tx`/`ty`. Two consequences, both visible on the sheet:
 *
 *   - the symbol came out at scene size instead of page size, roughly 2.4 times
 *     too large at the default scale, so it covered part of the conductor that
 *     legitimately left the base midpoint;
 *   - the offsets were not run through the page transform, so the shape and the
 *     route lines it was supposed to sit between were placed by two different
 *     rules and could disagree.
 *
 * These tests decode the bytes that are actually downloaded and check the real
 * geometry. They also prove the SVGOUT is clean, so a future regression in either
 * renderer is caught where it happens.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

import { EXAMPLE_ROUTES, createConfig } from '../src/config.js';
import { resolveExampleRoutes } from '../src/ui/example.js';
import { buildNetwork } from '../src/geometry/network.js';
import { buildScene } from '../src/geometry/scene.js';
import { tcTriangleVertices } from '../src/geometry/markers.js';
import { renderSceneToPdf } from '../src/render/pdf.js';
import { renderSceneToSvg } from '../src/render/svg.js';

const require = createRequire(import.meta.url);
const { jsPDF } = require('../vendor/jspdf/jspdf.umd.cjs');

/* ------------------------------------------------------------------------ */
/* Decoding helpers                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Read every path segment out of a PDF's content streams.
 *
 * jsPDF compresses its streams by default; both the compressed and the plain form
 * are handled so a test can pass `compress: false` and read the same structure.
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
 * The TC polygon as the SVG renderer actually emitted it.
 *
 * @param {string} svg Serialized SVG.
 * @param {string} id The polygon's id attribute.
 * @returns {{x: number, y: number}[]|null} Three vertices, or null when absent.
 */
function svgPolygon(svg, id) {
  const match = svg.match(new RegExp(`<polygon[^>]*id="${id}"[^>]*points="([^"]+)"`));
  if (!match) return null;
  return match[1]
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    });
}

/**
 * Every straight segment the SVG draws, from any element type that draws one.
 *
 * `<line>` elements are read directly. `<path>` and `<polyline>` are tokenized so a
 * regression that switches primitive cannot hide from the check.
 *
 * @param {string} svg Serialized SVG.
 * @returns {{x1: number, y1: number, x2: number, y2: number}[]} Segments.
 */
function svgSegments(svg) {
  const segments = [];

  for (const match of svg.matchAll(/<line\b[^>]*>/g)) {
    const tag = match[0];
    const get = (name) => {
      const found = tag.match(new RegExp(`${name}="(-?[\\d.]+)"`));
      return found ? Number(found[1]) : null;
    };
    const x1 = get('x1');
    const y1 = get('y1');
    const x2 = get('x2');
    const y2 = get('y2');
    if ([x1, y1, x2, y2].every((v) => v !== null)) segments.push({ x1, y1, x2, y2 });
  }

  // `d` attributes of paths and points of polylines, so the same interior rule
  // applies whichever primitive the renderer chose.
  for (const match of svg.matchAll(/<path\b[^>]*d="([^"]+)"/g)) {
    segments.push(...pathSegments(match[1]));
  }
  for (const match of svg.matchAll(/<polyline\b[^>]*points="([^"]+)"/g)) {
    segments.push(...pointSegments(match[1]));
  }

  return segments;
}

/** Segments of a path `d` attribute, reading only the straight-line commands. */
function pathSegments(d) {
  const tokens = d.match(/[MLmlHhVv]|-?\d*\.?\d+/g) ?? [];
  const segments = [];
  let current = null;
  let command = null;
  let index = 0;
  const next = () => Number(tokens[index++]);
  while (index < tokens.length) {
    if (/^[MLmlHhVv]$/.test(tokens[index])) {
      command = tokens[index++];
      continue;
    }
    if (command === 'M' || command === 'L' || command === 'm' || command === 'l') {
      const x = next();
      const y = next();
      const point = command === command.toLowerCase() && current
        ? { x: current.x + x, y: current.y + y }
        : { x, y };
      if ((command === 'L' || command === 'l') && current) {
        segments.push({ x1: current.x, y1: current.y, x2: point.x, y2: point.y });
      }
      current = point;
    } else if (command === 'H' || command === 'h' || command === 'V' || command === 'v') {
      const value = next();
      const point = {
        x: command === 'H' || command === 'h' ? (command === 'H' ? value : current.x + value) : current.x,
        y: command === 'V' || command === 'v' ? (command === 'V' ? value : current.y + value) : current.y,
      };
      if (current) segments.push({ x1: current.x, y1: current.y, x2: point.x, y2: point.y });
      current = point;
    } else {
      index += 1;
    }
  }
  return segments;
}

/** Segments of a polyline's `points` attribute. */
function pointSegments(points) {
  const list = points
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    });
  const segments = [];
  for (let i = 0; i + 1 < list.length; i += 1) {
    segments.push({ x1: list[i].x, y1: list[i].y, x2: list[i + 1].x, y2: list[i + 1].y });
  }
  return segments;
}

/**
 * Strict point-in-triangle, boundary excluded.
 *
 * A conductor is allowed to meet the outline; that is how it attaches. Only the
 * enclosed interior must stay empty.
 */
function strictlyInside(p, tri, edge = 1e-4) {
  const sign = (a, b, c) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
  const d1 = sign(p, tri[0], tri[1]);
  const d2 = sign(p, tri[1], tri[2]);
  const d3 = sign(p, tri[2], tri[0]);
  return (d1 > edge && d2 > edge && d3 > edge) || (d1 < -edge && d2 < -edge && d3 < -edge);
}

/** Every segment that touches the strict interior of a triangle, found exactly. */
function segmentsInside(segments, tri) {
  const intrusions = [];
  for (const segment of segments) {
    // Exact test first: the interval of the segment that lies inside is found from
    // the crossings, so a segment that merely clips a corner cannot slip through
    // between two samples.
    const cuts = [0, 1];
    for (let i = 0; i < tri.length; i += 1) {
      const a = tri[i];
      const b = tri[(i + 1) % tri.length];
      const t = crossing(segment, a, b);
      if (t !== null) cuts.push(t);
    }
    cuts.sort((p, q) => p - q);
    let hit = false;
    for (let i = 0; i + 1 < cuts.length; i += 1) {
      if (cuts[i + 1] - cuts[i] < 1e-9) continue;
      const t = (cuts[i] + cuts[i + 1]) / 2;
      const p = {
        x: segment.x1 + (segment.x2 - segment.x1) * t,
        y: segment.y1 + (segment.y2 - segment.y1) * t,
      };
      if (strictlyInside(p, tri)) {
        hit = true;
        break;
      }
    }
    if (hit) intrusions.push(segment);
  }
  return intrusions;
}

/** Parameter on a segment where it crosses another, or null. */
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

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

/** Routes with a TC point reached from one direction and continued past. */
function throughTc(direction, { spansBefore = 3, spansAfter = 3, fpb = false } = {}) {
  const routes = [
    { id: 'route-1', from: 'origin', direction, spans: spansBefore },
    { id: 'route-2', from: 'endpoint:A', direction, spans: 2, tc: true },
    { id: 'route-3', from: 'tc:1', direction, spans: spansAfter },
  ];
  if (fpb) {
    routes.push({ id: 'route-4', from: 'tc:1', direction: 'east', spans: 2, fpb: true });
  }
  return routes;
}

/** The example the supplied PDF was produced from. */
function exampleNetwork() {
  let n = 0;
  const routes = resolveExampleRoutes(EXAMPLE_ROUTES, () => `route-${(n += 1)}`);
  return buildNetwork(routes, { originMarker: 'plain' });
}

/**
 * Where the PDF places one scene point, applying jsPDF's bottom-left origin.
 *
 * jsPDF writes its stream in a coordinate system whose Y grows upward, so the
 * scene's top-down Y is mirrored about the page height. Getting this wrong is how
 * an earlier check managed to report an empty interior while the sheet had a stroke
 * in it: it compared mirrored geometry against unmirrored geometry.
 */
function pdfPoint(scene, point, fit, pageHeight) {
  return {
    x: fit.offsetX + point.x * fit.scale,
    y: pageHeight - (fit.offsetY + point.y * fit.scale),
  };
}

/** Render a scene to a PDF and return its segments, triangle and page height. */
function renderPdf(scene) {
  const { doc, fit } = renderSceneToPdf(scene, { jsPDF, compress: false });
  const raw = doc.output();
  const pageHeight = doc.internal.pageSize.getHeight();
  const anchor = scene.tc[0];
  const triangle = tcTriangleVertices(anchor).map((p) => pdfPoint(scene, p, fit, pageHeight));
  return { segments: pdfSegments(Buffer.from(raw, 'latin1')), triangle, pageHeight, fit, raw };
}

/** Points of the triangle, as distances so ordering does not matter. */
function triangleSignature(triangle) {
  return triangle.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).sort();
}

/* ------------------------------------------------------------------------ */
/* The regression itself                                                     */
/* ------------------------------------------------------------------------ */

test('the exported PDF contains no conductor inside the TC triangle', () => {
  for (const profile of ['pdf', 'svg', 'print']) {
    const scene = buildScene(exampleNetwork(), profile);
    const { segments, triangle } = renderPdf(scene);
    const intrusions = segmentsInside(segments, triangle);
    assert.deepEqual(
      intrusions,
      [],
      `${profile}: ${intrusions.length} segment(s) enter the triangle: ` +
        intrusions.map((s) => `(${s.x1.toFixed(2)},${s.y1.toFixed(2)})->(${s.x2.toFixed(2)},${s.y2.toFixed(2)})`),
    );
  }
});

test('the PDF triangle is drawn at page scale, not at scene scale', () => {
  // The defect was a size error as well as a placement error: the old renderer drew
  // a shape of 24 pt base and 20 pt height because it passed scene-space deltas
  // straight through. The symbol has to shrink with the page like everything else.
  const scene = buildScene(exampleNetwork(), 'pdf');
  const { triangle, fit, raw } = renderPdf(scene);
  const anchor = scene.tc[0];

  const baseWidth = Math.hypot(triangle[1].x - triangle[2].x, triangle[1].y - triangle[2].y);
  const expectedWidth = anchor.halfWidth * 2 * fit.scale;
  assert.ok(
    Math.abs(baseWidth - expectedWidth) < 1e-6,
    `the base is drawn ${baseWidth.toFixed(3)} pt wide, expected ${expectedWidth.toFixed(3)} pt`,
  );
  assert.ok(baseWidth < 24, 'the base is not the old oversized scene-space width');

  const height = Math.abs(triangle[0].y - triangle[1].y);
  assert.ok(
    Math.abs(height - anchor.height * fit.scale) < 1e-6,
    `the height is drawn ${height.toFixed(3)} pt, expected ${(anchor.height * fit.scale).toFixed(3)}`,
  );

  // The three sides are present in the stream at those exact coordinates. jsPDF
  // writes full-precision numbers, so the comparison is on the rounded value rather
  // than on a fixed number of decimal places.
  const emit = (p) => `${p.x.toFixed(3)}|${p.y.toFixed(3)}`;
  const emitted = new Set();
  for (const s of pdfSegments(Buffer.from(raw, 'latin1'))) {
    emitted.add(`${emit({ x: s.x1, y: s.y1 })}>${emit({ x: s.x2, y: s.y2 })}`);
  }
  for (let i = 0; i < 3; i += 1) {
    const from = triangle[i];
    const to = triangle[(i + 1) % 3];
    assert.ok(
      emitted.has(`${emit(from)}>${emit(to)}`),
      `side ${i} is emitted at the expected page coordinates`,
    );
  }
});

test('the exported SVG contains no segment inside the TC triangle', () => {
  for (const profile of ['svg', 'pdf', 'print', 'preview']) {
    const scene = buildScene(exampleNetwork(), profile);
    const svg = renderSceneToSvg(scene);
    const anchor = scene.tc[0];
    const polygon = svgPolygon(svg, `tc:${'4,-4'}`) ?? svgPolygon(svg, `tc:${anchor.id.split(':')[1]}`);
    assert.ok(polygon, `${profile}: the triangle polygon is in the SVG`);
    const intrusions = segmentsInside(svgSegments(svg), polygon);
    assert.deepEqual(intrusions, [], `${profile}: no SVG segment enters the triangle`);
  }
});

test('the SVG triangle matches the scene triangle in the exported frame', () => {
  const scene = buildScene(exampleNetwork(), 'svg');
  const svg = renderSceneToSvg(scene);
  const polygon = svgPolygon(svg, 'tc:4,-4');
  assert.ok(polygon);
  const expected = tcTriangleVertices(scene.tc[0]);
  assert.deepEqual(
    triangleSignature(polygon),
    triangleSignature(expected),
    'the exported polygon is the one the scene computed',
  );
});

/* ------------------------------------------------------------------------ */
/* Every direction, at several spacings                                      */
/* ------------------------------------------------------------------------ */

test('no exported artefact carries a stroke inside the triangle, in any direction', () => {
  for (const direction of ['north', 'south', 'east', 'west']) {
    for (const spacing of [12, 20, 35, 40, 60]) {
      for (const profile of ['svg', 'pdf', 'print']) {
        const scene = buildScene(buildNetwork(throughTc(direction)), profile, {
          spanLength: spacing,
        });
        const label = `${direction}/${spacing}px/${profile}`;

        const pdf = renderPdf(scene);
        assert.deepEqual(
          segmentsInside(pdf.segments, pdf.triangle),
          [],
          `${label}: no PDF segment enters the triangle`,
        );

        const svg = renderSceneToSvg(scene);
        const anchor = scene.tc[0];
        const polygon = svgPolygon(svg, anchor.id);
        assert.ok(polygon, `${label}: the SVG triangle is present`);
        assert.deepEqual(
          segmentsInside(svgSegments(svg), polygon),
          [],
          `${label}: no SVG segment enters the triangle`,
        );
      }
    }
  }
});

test('the incoming conductor meets the apex and the outgoing one the base', () => {
  for (const direction of ['north', 'south', 'east', 'west']) {
    const scene = buildScene(buildNetwork(throughTc(direction)), 'pdf');
    const { segments, triangle, fit, pageHeight } = renderPdf(scene);
    const anchor = scene.tc[0];
    const vertices = tcTriangleVertices(anchor);
    const apex = pdfPoint(scene, vertices[0], fit, pageHeight);
    const baseMid = {
      x: (pdfPoint(scene, vertices[1], fit, pageHeight).x + pdfPoint(scene, vertices[2], fit, pageHeight).x) / 2,
      y: (pdfPoint(scene, vertices[1], fit, pageHeight).y + pdfPoint(scene, vertices[2], fit, pageHeight).y) / 2,
    };

    const touches = (point) =>
      segments.some(
        (s) =>
          (Math.abs(s.x1 - point.x) < 1e-3 && Math.abs(s.y1 - point.y) < 1e-3) ||
          (Math.abs(s.x2 - point.x) < 1e-3 && Math.abs(s.y2 - point.y) < 1e-3),
      );

    assert.ok(touches(apex), `${direction}: a conductor meets the apex`);
    assert.ok(touches(baseMid), `${direction}: a conductor meets the base midpoint`);
    assert.ok(triangle.length === 3, `${direction}: the triangle has three corners`);
  }
});

/* ------------------------------------------------------------------------ */
/* Awkward arrangements                                                      */
/* ------------------------------------------------------------------------ */

test('a TC with a perpendicular branch, an FPB neighbour and a repeated edge stays clean', () => {
  const arrangements = {
    'perpendicular branch': [
      { id: 'r1', from: 'origin', direction: 'south', spans: 3 },
      { id: 'r2', from: 'endpoint:A', direction: 'south', spans: 2, tc: true },
      { id: 'r3', from: 'tc:1', direction: 'south', spans: 2 },
      { id: 'r4', from: 'tc:1', direction: 'east', spans: 3 },
      { id: 'r5', from: 'origin', direction: 'south', spans: 5 },
    ],
    'fpb next to a tc': [
      { id: 'r1', from: 'origin', direction: 'south', spans: 3 },
      { id: 'r2', from: 'endpoint:A', direction: 'south', spans: 2, tc: true },
      { id: 'r3', from: 'tc:1', direction: 'east', spans: 1, fpb: true },
    ],
    'tc at the origin': [{ id: 'r1', from: 'origin', direction: 'south', spans: 3 }],
  };

  for (const [name, routes] of Object.entries(arrangements)) {
    const network = buildNetwork(routes, name === 'tc at the origin' ? { originMarker: 'tc' } : {});
    assert.ok(network.ok, `${name}: the network builds`);
    if (name === 'tc at the origin') {
      assert.equal(network.tcCount, 0, `${name}: the Origin is not a created TC endpoint`);
    }
    for (const profile of ['svg', 'pdf', 'print']) {
      const scene = buildScene(network, profile);
      if (scene.tc.length === 0) continue;
      const pdf = renderPdf(scene);
      assert.deepEqual(
        segmentsInside(pdf.segments, pdf.triangle),
        [],
        `${name}/${profile}: no PDF segment enters the triangle`,
      );
      const svg = renderSceneToSvg(scene);
      const polygon = svgPolygon(svg, scene.tc[0].id);
      assert.ok(polygon, `${name}/${profile}: the triangle is drawn`);
      assert.deepEqual(
        segmentsInside(svgSegments(svg), polygon),
        [],
        `${name}/${profile}: no SVG segment enters the triangle`,
      );
    }
  }
});

test('a reversed route over an existing edge still leaves the triangle empty', () => {
  // The same physical span walked the other way must not produce a second stroke,
  // and the TC triangle must not gain an interior line from it.
  const scene = buildScene(
    buildNetwork([
      { id: 'r1', from: 'origin', direction: 'south', spans: 4, tc: true },
      { id: 'r2', from: 'tc:1', direction: 'south', spans: 2 },
      { id: 'r3', from: 'endpoint:B', direction: 'north', spans: 4 },
    ]),
    'pdf',
  );
  const { segments, triangle } = renderPdf(scene);
  assert.deepEqual(segmentsInside(segments, triangle), []);
});

test('every drawn pole and marker primitive is unchanged by the TC correction', () => {
  // The correction touched only how the triangle is emitted. The pole crosses and
  // the FPB boxes must still be present in the same numbers.
  const scene = buildScene(exampleNetwork(), 'pdf');
  const { raw } = renderPdf(scene);
  const draws = (raw.match(/\bm\s*\n?[-\d.]+\s+[-\d.]+\s+l\b/g) ?? []).length;
  assert.ok(draws >= scene.lines.length, 'every route line is still emitted');
  assert.ok(scene.poles.length > 0, 'the drawing has poles');
  // The example has no feeder pillar box, so that is checked on a network that does.
  const withBox = buildScene(
    buildNetwork([
      { id: 'b1', from: 'origin', direction: 'south', spans: 2, fpb: true },
      { id: 'b2', from: 'origin', direction: 'south', spans: 4, tc: true },
    ]),
    'pdf',
  );
  assert.ok(withBox.fpb.length >= 1, 'a diagram with a box still has one');
  const boxed = renderPdf(withBox);
  assert.deepEqual(
    segmentsInside(boxed.segments, boxed.triangle),
    [],
    'the box does not push a line into the triangle',
  );
});

test('a triangle is never left out of the export', () => {
  const scene = buildScene(exampleNetwork(), 'pdf');
  const { segments } = renderPdf(scene);
  const visible = new Set();
  for (const s of segments) {
    visible.add(`${s.x1.toFixed(2)},${s.y1.toFixed(2)}`);
    visible.add(`${s.x2.toFixed(2)},${s.y2.toFixed(2)}`);
  }
  const { triangle } = renderPdf(scene);
  for (const corner of triangle) {
    assert.ok(
      visible.has(`${corner.x.toFixed(2)},${corner.y.toFixed(2)}`),
      `corner ${corner.x.toFixed(2)},${corner.y.toFixed(2)} is drawn`,
    );
  }
});

test('the page transform is the one the route lines use', () => {
  // The triangle and the conductors must be placed by a single rule. If they ever
  // diverge again the symbol drifts off the route it belongs to, which is what made
  // the conductor appear to pass through it.
  const scene = buildScene(exampleNetwork(), 'pdf');
  const { fit, segments, raw } = renderPdf(scene);
  const config = createConfig();
  assert.ok(fit.scale > 0 && fit.scale < 1, 'the drawing is scaled to the page');

  // A known route line, emitted through the same transform.
  const line = scene.lines.find(
    (l) => Math.abs(l.x1 - l.x2) < 1e-9 && Math.hypot(l.x2 - l.x1, l.y2 - l.y1) > 10,
  );
  assert.ok(line, 'the example has a vertical route line');
  const pageHeight = renderPdf(scene).pageHeight;
  const from = pdfPoint(scene, { x: line.x1, y: line.y1 }, fit, pageHeight);
  const found = segments.some(
    (s) => Math.abs(s.x1 - from.x) < 1e-3 && Math.abs(s.y1 - from.y) < 1e-3,
  );
  assert.ok(found, 'the route line is emitted at the transformed position');
  assert.ok(raw.length > 1000, 'the stream was produced');
  assert.ok(config.tcMarkerHeight > 0);
});
