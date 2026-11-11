/**
 * PDF renderer.
 *
 * Consumes ONLY the normalized scene produced by `buildScene`, translating the
 * already-resolved pixel primitives into jsPDF vector operations. It performs
 * no network geometry of its own: no pole positions, no junctions, no endpoint
 * coordinates are calculated here. The only arithmetic is a uniform
 * aspect-preserving fit from scene pixels into the page box.
 *
 * jsPDF is supplied by the caller so that the renderer can be exercised (and
 * tested) with any compatible implementation, and so the browser can load the
 * vendored copy without a bundler.
 */

import { PAGE_LAYOUTS } from '../config.js';
import { poleCrossPath, tcTrianglePoints } from './svg.js';

/** Marker placed in the PDF so automated checks can assert vector content. */
export const PDF_GENERATOR_TAG = 'LineRouteDrawingGenerator';

/**
 * Parse a paired coordinate path properly (x and y alternate).
 *
 * @param {string} d SVG path data with M/L commands only.
 * @returns {Array<{type: 'M'|'L', x: number, y: number}>}
 */
export function parsePairedPath(d) {
  const tokens = String(d).match(/[ML]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const out = [];
  let command = null;
  let pendingX = null;
  for (const token of tokens) {
    if (/^[ML]$/i.test(token)) {
      command = token.toUpperCase();
      continue;
    }
    const value = Number(token);
    if (pendingX === null) {
      pendingX = value;
      continue;
    }
    if (command) out.push({ type: command, x: pendingX, y: value });
    pendingX = null;
  }
  return out;
}

/**
 * Compute the aspect-preserving placement of the scene inside a page box.
 *
 * @param {{width: number, height: number}} scene Scene pixel size.
 * @param {object} layout Page layout from PAGE_LAYOUTS.
 * @param {number} margin Page margin in pt.
 * @returns {{scale: number, offsetX: number, offsetY: number, boxWidth: number, boxHeight: number}}
 */
export function fitSceneToPage(scene, layout, margin) {
  const boxWidth = layout.widthPt - margin * 2;
  const boxHeight = layout.heightPt - margin * 2;
  if (!(boxWidth > 0) || !(boxHeight > 0)) {
    throw new RangeError('The page margin leaves no room for the drawing.');
  }
  const scale = Math.min(boxWidth / scene.width, boxHeight / scene.height);
  const drawWidth = scene.width * scale;
  const drawHeight = scene.height * scale;
  return {
    scale,
    // Centre the drawing in the content box.
    offsetX: margin + (boxWidth - drawWidth) / 2,
    offsetY: margin + (boxHeight - drawHeight) / 2,
    boxWidth,
    boxHeight,
  };
}

/**
 * Render a scene into a PDF document.
 *
 * @param {object} scene Scene from `buildScene` with the `pdf` profile.
 * @param {object} options
 * @param {Function} options.jsPDF jsPDF constructor.
 * @param {string} [options.layout='a4_landscape'] Page layout id.
 * @param {number} [options.margin] Page margin in pt, defaults to scene config.
 * @param {string} [options.title] Optional document title metadata.
 * @param {boolean} [options.compress=true] Disable to inspect raw operators.
 * @returns {{doc: object, fit: object, layout: object, primitives: object}}
 */
export function renderSceneToPdf(scene, options) {
  const { jsPDF } = options;
  if (typeof jsPDF !== 'function') {
    throw new TypeError('renderSceneToPdf requires a jsPDF constructor.');
  }
  const layout = PAGE_LAYOUTS[options.layout ?? 'a4_landscape'];
  if (!layout) {
    throw new RangeError(`Unknown page layout: ${String(options.layout)}`);
  }
  const margin = options.margin ?? scene.config.pdfMarginPt;
  const fit = fitSceneToPage(scene, layout, margin);

  const doc = new jsPDF({
    orientation: layout.orientation,
    unit: 'pt',
    format: layout.format,
    // Compression is on for production size; tests pass `compress: false` so the
    // vector drawing operators can be asserted on the raw stream.
    compress: options.compress !== false,
  });

  doc.setProperties({
    title: options.title ?? `Line route drawing (${PDF_GENERATOR_TAG})`,
    subject: PDF_GENERATOR_TAG,
    creator: PDF_GENERATOR_TAG,
  });

  const tx = (x) => fit.offsetX + x * fit.scale;
  const ty = (y) => fit.offsetY + y * fit.scale;

  doc.setLineCap('butt');

  // Route lines.
  if (scene.lines.length) {
    doc.setLineWidth(Math.max(0.2, scene.config.lineWidth * fit.scale));
    doc.setDrawColor(0, 0, 0);
    for (const line of scene.lines) {
      doc.line(tx(line.x1), ty(line.y1), tx(line.x2), ty(line.y2));
    }
  }

  // X symbols at every span position: redrawn from the scene's own path data.
  const poleWidth = Math.max(0.3, 1.4 * fit.scale);
  if (scene.poles.length) {
    doc.setLineWidth(poleWidth);
    doc.setDrawColor(0, 0, 0);
    for (const pole of scene.poles) {
      const segments = parsePairedPath(poleCrossPath(pole));
      let previous = null;
      for (const segment of segments) {
        if (segment.type === 'M') {
          previous = segment;
          continue;
        }
        if (previous) {
          doc.line(tx(previous.x), ty(previous.y), tx(segment.x), ty(segment.y));
        }
        previous = segment;
      }
    }
  }

  // TC triangles, from the scene's own polygon points.
  if (scene.tc.length) {
    doc.setLineWidth(poleWidth);
    doc.setDrawColor(0, 0, 0);
    for (const tc of scene.tc) {
      const pts = tcTrianglePoints(tc)
        .trim()
        .split(/\s+/)
        .map((pair) => pair.split(',').map(Number));
      const [a, b, c] = pts;
      if (!a || !b || !c) continue;
      doc.lines(
        [
          [b[0] - a[0], b[1] - a[1]],
          [c[0] - b[0], c[1] - b[1]],
          [a[0] - c[0], a[1] - c[1]],
        ],
        tx(a[0]),
        ty(a[1]),
        [1, 1],
        'S',
        false,
      );
    }
  }

  // Labels only exist for the preview profile; exports carry none.
  if (scene.labels.length) {
    doc.setFont(scene.fontFamily.split(',')[0].trim(), 'normal');
    doc.setFontSize(10);
    doc.setTextColor(0, 0, 0);
    for (const label of scene.labels) {
      doc.text(String(label.text), tx(label.x + label.offsetX), ty(label.y + label.offsetY));
    }
  }

  return {
    doc,
    fit,
    layout,
    primitives: {
      lines: scene.lines.length,
      poles: scene.poles.length,
      tc: scene.tc.length,
      labels: scene.labels.length,
    },
  };
}
