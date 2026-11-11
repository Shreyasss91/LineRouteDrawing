import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { buildNetwork } from '../src/geometry/network.js';
import { buildScene } from '../src/geometry/scene.js';
import { renderSceneToSvg, escapeXml, poleCrossPath } from '../src/render/svg.js';
import { renderSceneToPdf, fitSceneToPage, parsePairedPath } from '../src/render/pdf.js';
import { EXAMPLE_ROUTES, PAGE_LAYOUTS } from '../src/config.js';

const require = createRequire(import.meta.url);

// The vendored UMD build is stored with a .cjs extension so Node always loads
// it as CommonJS, mirroring the <script> tag the browser uses.
const { jsPDF } = require('../vendor/jspdf/jspdf.umd.cjs');

function routes(list) {
  return list.map((r, i) => ({ id: `r${i + 1}`, ...r }));
}

function exampleNetwork() {
  return buildNetwork(routes([...EXAMPLE_ROUTES]));
}

const simple = buildNetwork(
  routes([
    { from: 'origin', direction: 'east', spans: 2, tc: false },
    { from: 'endpoint:A', direction: 'south', spans: 2, tc: true },
  ]),
);

test('SVG output is editable vector primitives, not an image', () => {
  const scene = buildScene(simple, 'svg');
  const svg = renderSceneToSvg(scene);
  assert.match(svg, /^<\?xml/);
  assert.match(svg, /<svg [^>]*viewBox="0 0 [\d.]+ [\d.]+"/);
  assert.match(svg, /<line /);
  assert.match(svg, /<path /);
  assert.match(svg, /<polygon /);
  assert.doesNotMatch(svg, /<image/);
  assert.doesNotMatch(svg, /data:image/);
  assert.doesNotMatch(svg, /<text/);
});

test('SVG export carries no labels but keeps X and TC symbols', () => {
  const scene = buildScene(simple, 'svg');
  const svg = renderSceneToSvg(scene);
  assert.doesNotMatch(svg, /Origin/);
  assert.doesNotMatch(svg, /<text/);
  assert.equal((svg.match(/<path /g) ?? []).length, scene.poles.length);
  assert.equal((svg.match(/<polygon /g) ?? []).length, scene.tc.length);
  assert.ok(scene.tc.length >= 1);
});

test('SVG preview markup does include labels', () => {
  const scene = buildScene(simple, 'preview');
  const svg = renderSceneToSvg(scene);
  assert.match(svg, /<text[^>]*>Origin<\/text>/);
  assert.match(svg, /<text[^>]*>A<\/text>/);
});

test('SVG escapes text safely', () => {
  assert.equal(escapeXml('a<b>&"c\''), 'a&lt;b&gt;&amp;&quot;c&apos;');
});

test('pole cross path contains two crossing strokes', () => {
  const d = poleCrossPath({ x: 10, y: 20, size: 4 });
  const segments = parsePairedPath(d);
  assert.equal(segments.length, 4, 'two M/L pairs');
  assert.deepEqual(segments[0], { type: 'M', x: 6, y: 16 });
  assert.deepEqual(segments[1], { type: 'L', x: 14, y: 24 });
  assert.deepEqual(segments[2], { type: 'M', x: 14, y: 16 });
  assert.deepEqual(segments[3], { type: 'L', x: 6, y: 24 });
});

test('PDF fit preserves the scene aspect ratio without clipping', () => {
  const scene = buildScene(exampleNetwork(), 'pdf');
  for (const layout of Object.values(PAGE_LAYOUTS)) {
    const fit = fitSceneToPage(scene, layout, 28);
    const drawnW = scene.width * fit.scale;
    const drawnH = scene.height * fit.scale;
    assert.ok(drawnW <= layout.widthPt - 56 + 1e-6, `${layout.id} width fits`);
    assert.ok(drawnH <= layout.heightPt - 56 + 1e-6, `${layout.id} height fits`);
    assert.ok(drawnW >= 0 && drawnH >= 0);
    // Exactly one axis is tight, which is what "aspect preserving" means.
    const slackX = Math.abs(layout.widthPt - 56 - drawnW);
    const slackY = Math.abs(layout.heightPt - 56 - drawnH);
    assert.ok(Math.min(slackX, slackY) < 1e-6, `${layout.id} uses the full one axis`);
  }
});

test('PDF output is a real vector PDF with drawing operators', () => {
  const scene = buildScene(simple, 'pdf');
  const { doc, primitives } = renderSceneToPdf(scene, {
    jsPDF,
    layout: 'a4_landscape',
    compress: false,
  });
  const bytes = doc.output('arraybuffer');
  const text = new TextDecoder('latin1').decode(new Uint8Array(bytes));

  assert.ok(text.startsWith('%PDF-'), 'PDF header present');
  assert.match(text, /%%EOF/);
  // Drawing operators rather than an embedded raster image.
  assert.match(text, /\sm[\s\n]/, 'move-to operator');
  assert.match(text, /\sl[\s\n]/, 'line-to operator');
  assert.match(text, /\sS[\s\n]/, 'stroke operator');
  assert.doesNotMatch(text, /\/Subtype\s*\/Image/);
  assert.doesNotMatch(text, /\/DCTDecode/);
  assert.doesNotMatch(text, /FlateDecode/, 'uncompressed so operators are inspectable');
  // Label suppression survives into the file.
  assert.doesNotMatch(text, /Origin/);
  assert.doesNotMatch(text, /BT\s/, 'no text object is emitted for an export');
  assert.equal(primitives.lines, scene.lines.length);
  assert.equal(primitives.tc, scene.tc.length);
  assert.ok(primitives.poles > 0);
});

test('compressed production PDF is still vector, not raster', () => {
  const scene = buildScene(exampleNetwork(), 'pdf');
  const { doc } = renderSceneToPdf(scene, { jsPDF, layout: 'a4_landscape' });
  const text = new TextDecoder('latin1').decode(new Uint8Array(doc.output('arraybuffer')));
  assert.ok(text.startsWith('%PDF-'));
  assert.doesNotMatch(text, /\/Subtype\s*\/Image/);
  assert.doesNotMatch(text, /\/DCTDecode/);
  assert.equal(doc.getNumberOfPages(), 1);
});

test('PDF and SVG renderers agree on the same canonical geometry', () => {
  const network = exampleNetwork();
  const svgScene = buildScene(network, 'svg');
  const pdfScene = buildScene(network, 'pdf');
  assert.equal(svgScene.lines.length, pdfScene.lines.length);
  assert.equal(svgScene.poles.length, pdfScene.poles.length);
  assert.equal(svgScene.tc.length, pdfScene.tc.length);
  assert.deepEqual(svgScene.lines, pdfScene.lines);
  // Same scene therefore yields the same primitive count in the PDF.
  const { primitives } = renderSceneToPdf(pdfScene, { jsPDF, layout: 'a4_landscape' });
  assert.equal(primitives.lines, svgScene.lines.length);
});

test('print profile matches the PDF visibility policy exactly', () => {
  const network = exampleNetwork();
  const pdf = buildScene(network, 'pdf');
  const print = buildScene(network, 'print');
  assert.deepEqual(
    { l: print.labels.length, p: print.poles.length, t: print.tc.length, ln: print.lines.length },
    { l: pdf.labels.length, p: pdf.poles.length, t: pdf.tc.length, ln: pdf.lines.length },
  );
});

test('PDF never exceeds one page for the example drawing', () => {
  const scene = buildScene(exampleNetwork(), 'pdf');
  const { doc } = renderSceneToPdf(scene, { jsPDF, layout: 'a4_landscape' });
  assert.equal(doc.getNumberOfPages(), 1);
});

test('every page layout produces a valid PDF', () => {
  const scene = buildScene(exampleNetwork(), 'pdf');
  for (const id of Object.keys(PAGE_LAYOUTS)) {
    const { doc } = renderSceneToPdf(scene, { jsPDF, layout: id });
    const head = new TextDecoder('latin1').decode(new Uint8Array(doc.output('arraybuffer')).slice(0, 5));
    assert.equal(head, '%PDF-', `${id} produced a PDF`);
    const layout = PAGE_LAYOUTS[id];
    const size = doc.internal.pageSize;
    assert.ok(Math.abs(size.getWidth() - layout.widthPt) < 1.5, `${id} page width`);
    assert.ok(Math.abs(size.getHeight() - layout.heightPt) < 1.5, `${id} page height`);
  }
});
