/**
 * Export visibility: which annotations an exported sheet may carry.
 *
 * Two independent switches govern an export - node loads and span lengths - and a
 * third thing, the completeness notice, is an application status message that no
 * exported sheet carries at all. These tests pin all of it, including the four
 * combinations of the two switches, because "both on" is the only case a quick manual
 * check ever exercises and the interesting failures live in the other three.
 *
 * The scene is the single source: the same `buildScene` call with a different profile
 * decides what every renderer draws. So these tests exercise the scene and then the
 * SVG and PDF, which is the whole pipeline rather than one layer of it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNetwork } from '../src/geometry/network.js';
import { buildScene } from '../src/geometry/scene.js';
import { renderSceneToSvg } from '../src/render/svg.js';
import { renderSceneToPdf } from '../src/render/pdf.js';
import { RENDER_PROFILES } from '../src/config.js';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { jsPDF } = require('../vendor/jspdf/jspdf.umd.cjs');

const ROUTES = [
  { id: 'route-1', from: 'origin', direction: 'south', spans: 2 },
  { id: 'route-2', from: 'endpoint:A', direction: 'east', spans: 3 },
];

/** A scene with one load, one measured span and one unmeasured span. */
function sceneWith(profileName, overrides = {}) {
  const network = buildNetwork(ROUTES, { originMarker: 'plain' });
  const loads = [{ id: 'load-1', nodeId: 'dst:route-2', value: 25, unit: 'kVA' }];
  const spanLengths = new Map([['mid:route-1:0~origin', 30]]);
  // A real profile object carrying the overrides, handed straight to `buildScene`, so
  // the gate inside the annotation layer is what decides - not a helper that filters
  // afterwards. If the gate were removed these tests would fail.
  const profile = { ...RENDER_PROFILES[profileName], ...overrides };
  return buildScene(network, profile, {}, { loads, spanLengths });
}

/** Inflate a PDF's content streams so its text can be searched. */
function pdfText(bytes) {
  const buffer = Buffer.from(bytes);
  const chunks = [];
  let index = 0;
  while ((index = buffer.indexOf('stream', index)) !== -1) {
    let start = index + 6;
    if (buffer[start] === 0x0d) start += 1;
    if (buffer[start] === 0x0a) start += 1;
    const end = buffer.indexOf('endstream', start);
    if (end === -1) break;
    const slice = buffer.subarray(start, end);
    try {
      chunks.push(zlib.inflateSync(slice).toString('latin1'));
    } catch {
      chunks.push(slice.toString('latin1'));
    }
    index = end + 9;
  }
  return chunks.join('\n');
}

test('export 1. the preview profile shows both annotation kinds and the notice', () => {
  const scene = sceneWith('preview');
  assert.ok(scene.annotations.callouts.length > 0, 'the working view shows loads');
  assert.ok(scene.annotations.spans.length > 0, 'the working view shows span lengths');
  assert.ok(scene.annotations.notice, 'the working view shows the completeness notice');
});

test('export 2. no exported profile carries the completeness notice or its box', () => {
  for (const name of ['pdf', 'svg', 'print']) {
    const scene = sceneWith(name);
    assert.equal(scene.annotations.notice, null, `${name} draws no notice record`);
    const svg = renderSceneToSvg({ ...scene, profile: RENDER_PROFILES[name] });
    assert.doesNotMatch(svg, /Span measurements incomplete/, `${name} SVG has no banner text`);
    assert.doesNotMatch(svg, /<g id="notice"/, `${name} SVG has no banner group`);
  }
});

test('export 3. the PDF carries no banner text in either direction', () => {
  const scene = sceneWith('pdf');
  const { doc } = renderSceneToPdf(scene, { jsPDF, layout: 'a4_landscape', compress: false });
  const text = pdfText(doc.output('arraybuffer'));
  assert.doesNotMatch(text, /Span measurements incomplete/);
  // The unmeasured span still reads "— m" when span lengths are on: removing the
  // notice must not take the honest placeholder with it.
  assert.match(text, /m\b/, 'span length text is still present');
});

test('export 4. node loads on, span lengths on: both are drawn', () => {
  const scene = sceneWith('svg', { showNodeLoads: true, showSpanLengths: true });
  assert.ok(scene.annotations.callouts.length > 0);
  assert.ok(scene.annotations.spans.length > 0);
  const svg = renderSceneToSvg({ ...scene, profile: { ...RENDER_PROFILES.svg } });
  assert.match(svg, /25 kVA/);
  assert.match(svg, /class="leader"/);
});

test('export 5. node loads on, span lengths off: loads only', () => {
  const scene = sceneWith('svg', { showNodeLoads: true, showSpanLengths: false });
  assert.ok(scene.annotations.callouts.length > 0, 'loads present');
  assert.equal(scene.annotations.spans.length, 0, 'no span labels');
  const svg = renderSceneToSvg({ ...scene, profile: RENDER_PROFILES.svg });
  assert.match(svg, /25 kVA/, 'the load text is there');
  assert.doesNotMatch(svg, /— m/, 'no unmeasured placeholder');
});

test('export 6. node loads off, span lengths on: span lengths only', () => {
  const scene = sceneWith('svg', { showNodeLoads: false, showSpanLengths: true });
  assert.equal(scene.annotations.callouts.length, 0, 'no callouts');
  assert.ok(scene.annotations.spans.length > 0, 'span labels present');
  const svg = renderSceneToSvg({ ...scene, profile: RENDER_PROFILES.svg });
  assert.doesNotMatch(svg, /25 kVA/, 'no load text');
  assert.doesNotMatch(svg, /class="leader"/, 'no leader geometry');
  assert.match(svg, /30 m/, 'the measured span length is drawn');
});

test('export 7. both off: neither annotation kind is drawn', () => {
  const scene = sceneWith('pdf', { showNodeLoads: false, showSpanLengths: false });
  assert.equal(scene.annotations.callouts.length, 0);
  assert.equal(scene.annotations.spans.length, 0);
  const { doc } = renderSceneToPdf(scene, { jsPDF, layout: 'a4_landscape', compress: false });
  const text = pdfText(doc.output('arraybuffer'));
  assert.doesNotMatch(text, /25 kVA/);
  assert.doesNotMatch(text, /30 m/);
});

test('export 8. turning an annotation off never deletes the underlying data', () => {
  // The scene is filtered; the measured data handed in is untouched, which is why a
  // switch can be flipped back without re-entering anything.
  const network = buildNetwork(ROUTES, { originMarker: 'plain' });
  const loads = [{ id: 'load-1', nodeId: 'dst:route-2', value: 25, unit: 'kVA' }];
  const spanLengths = new Map([['mid:route-1:0~origin', 30]]);
  buildScene(network, 'pdf', {}, { loads, spanLengths });
  assert.equal(loads.length, 1, 'the load record survives');
  assert.equal(spanLengths.size, 1, 'the measurement survives');
  assert.equal(spanLengths.get('mid:route-1:0~origin'), 30);
});

test('export 9. the exports hide letters and the Origin label as they always did', () => {
  for (const name of ['pdf', 'svg', 'print']) {
    const scene = sceneWith(name);
    const svg = renderSceneToSvg({ ...scene, profile: RENDER_PROFILES[name] });
    assert.doesNotMatch(svg, /<g id="labels"/, `${name} has no label group`);
  }
});

test('export 10. FPB boxes and TC triangles survive the banner removal', () => {
  // Removing a rectangle must be a targeted removal, not "hide the rectangles". The
  // markers are drawn from their own primitives and are unaffected.
  const network = buildNetwork(
    [
      { id: 'route-1', from: 'origin', direction: 'south', spans: 2, fpb: true },
      { id: 'route-2', from: 'origin', direction: 'east', spans: 3, tc: true },
    ],
    { originMarker: 'plain' },
  );
  const scene = buildScene(network, 'svg', {}, { loads: [], spanLengths: new Map() });
  assert.ok(scene.fpb.length >= 1, 'an FPB box is drawn');
  assert.ok(scene.tc.length >= 1, 'a TC triangle is drawn');
  const svg = renderSceneToSvg({ ...scene, profile: RENDER_PROFILES.svg });
  assert.equal((svg.match(/<rect /g) ?? []).length, scene.fpb.length, 'one rect per FPB and no banner rect');
});

test('export 11. the exported PDF stays vector-only with the switches in play', () => {
  const scene = sceneWith('pdf', { showNodeLoads: true, showSpanLengths: true });
  const { doc } = renderSceneToPdf(scene, { jsPDF, layout: 'a4_landscape', compress: false });
  const text = pdfText(doc.output('arraybuffer'));
  assert.doesNotMatch(text, /\/Subtype\s*\/Image/, 'no raster image object');
});
