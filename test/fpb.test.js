import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { buildNetwork, normalizeMarkerKind } from '../src/geometry/network.js';
import { buildScene, measureFpbText } from '../src/geometry/scene.js';
import { renderSceneToSvg } from '../src/render/svg.js';
import { renderSceneToPdf } from '../src/render/pdf.js';
import { latestSource, endpointLabel } from '../src/ui/state.js';
import { createConfig } from '../src/config.js';

const require = createRequire(import.meta.url);
const { jsPDF } = require('../vendor/jspdf/jspdf.umd.cjs');

const networkWithFpb = () =>
  buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 2, tc: false },
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 2, fpb: true },
  ]);

test('an FPB destination is identified by a stable id and its own name', () => {
  const network = networkWithFpb();
  assert.ok(network.ok);
  const fpb = network.endpoints.filter((e) => e.kind === 'fpb');
  assert.equal(fpb.length, 1);
  assert.equal(fpb[0].id, 'fpb:1');
  assert.equal(fpb[0].displayName, 'FPB', 'a single FPB point is named FPB');
  assert.equal(network.fpbCount, 1);
  // It must not consume an alphabetical letter.
  assert.equal(network.alphaCount, 1, 'only A is an ordinary endpoint');
  assert.equal(network.endpoints.some((e) => e.kind === 'fpb' && e.displayName === 'B'), false);
});

test('several FPB points are distinguished as FPB1, FPB2 and are selectable', () => {
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 1, fpb: true },
    { id: 'r2', from: 'origin', direction: 'east', spans: 1, fpb: true },
    { id: 'r3', from: 'fpb:2', direction: 'north', spans: 2, tc: false },
  ]);
  assert.ok(network.ok, network.errors.map((e) => e.message).join('; '));
  assert.deepEqual(
    network.endpoints.filter((e) => e.kind === 'fpb').map((e) => e.displayName),
    ['FPB1', 'FPB2'],
  );
  // The FPB is a valid starting point, addressed by its internal id.
  assert.equal(network.routes[2].sourceId, 'fpb:2');
});

test('a destination cannot be both a TC point and an FPB', () => {
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: true, fpb: true },
  ]);
  assert.equal(network.ok, false);
  assert.match(network.errors[0].message, /not both/i);
});

test('the FPB anchor draws a box instead of an X marker, in every profile', () => {
  const network = networkWithFpb();
  for (const profile of ['preview', 'pdf', 'svg', 'print']) {
    const scene = buildScene(network, profile);
    assert.equal(scene.fpb.length, 1, `${profile} draws the box`);
    const box = scene.fpb[0];
    assert.equal(box.text, 'FPB');
    // No X sits on the box's centre.
    const overlapping = scene.poles.filter(
      (p) => Math.abs(p.x - box.x) < 0.001 && Math.abs(p.y - box.y) < 0.001,
    );
    assert.equal(overlapping.length, 0, `${profile} draws no X at the FPB anchor`);
    // Ordinary poles keep their crossings.
    assert.ok(scene.poles.length >= 1, `${profile} keeps X symbols elsewhere`);
  }
});

test('the FPB box is sized to fit its text', () => {
  const config = createConfig();
  const scene = buildScene(networkWithFpb(), 'svg', { fpbFontSize: config.fpbFontSize });
  const box = scene.fpb[0];
  const textWidth = measureFpbText(box.text, box.fontSize);
  assert.ok(box.width > textWidth, 'the box is wider than its text');
  assert.ok(box.height > box.fontSize, 'the box is taller than its text');
  // The box is centred on the anchor so the route enters and leaves evenly.
  assert.ok(Math.abs(box.boxX + box.width / 2 - box.x) < 0.001);
  assert.ok(Math.abs(box.boxY + box.height / 2 - box.y) < 0.001);
  // A longer label produces a wider box.
  assert.ok(measureFpbText('FPB12', 11) > measureFpbText('FPB', 11));
});

test('SVG export contains the FPB rectangle and its label text', () => {
  const scene = buildScene(networkWithFpb(), 'svg');
  const svg = renderSceneToSvg(scene, { standalone: false });
  assert.match(svg, /<g id="fpb-markers"/);
  assert.match(svg, /<rect /);
  assert.match(svg, />FPB</, 'the FPB text is part of the symbol');
  // Ordinary labels are still suppressed in an export.
  assert.doesNotMatch(svg, />Origin</);
  assert.doesNotMatch(svg, /<g id="labels"/);
});

test('PDF export draws the FPB as a vector rectangle with its text', () => {
  const scene = buildScene(networkWithFpb(), 'pdf');
  const { doc, primitives } = renderSceneToPdf(scene, {
    jsPDF,
    layout: 'a4_landscape',
    compress: false,
  });
  assert.equal(primitives.fpb, 1);
  const text = new TextDecoder('latin1').decode(new Uint8Array(doc.output('arraybuffer')));
  // A filled-and-stroked rectangle is written as a `re` operator.
  assert.match(text, /\sre[\s\n]/, 'rectangle operator present');
  assert.match(text, /\(FPB\) Tj/, 'the FPB label is drawn inside the box');
  assert.doesNotMatch(text, /Origin/, 'ordinary labels remain suppressed');
  assert.doesNotMatch(text, /\/Subtype\s*\/Image/, 'still vector output');
});

test('an FPB destination is preselected for the next route', () => {
  const routes = [
    { id: 'r1', from: 'origin', direction: 'south', spans: 2, tc: false },
    { id: 'r2', from: 'endpoint:A', direction: 'east', spans: 2, fpb: true },
  ];
  const next = latestSource(routes);
  assert.equal(next.id, 'fpb:1');
  assert.equal(next.label, 'FPB');
});

test('the FPB label appears in the dropdown and reads naturally', () => {
  const network = networkWithFpb();
  const fpb = network.endpoints.find((e) => e.kind === 'fpb');
  assert.equal(endpointLabel(fpb), 'FPB');
});

test('a route ending on an FPB coordinate reuses that FPB, not a second node', () => {
  // A reaches (2,0). B goes north to (0,1) then east to (2,1), which is marked
  // as an FPB. A third branch descends from (2,1) onto (2,0), the existing
  // ordinary endpoint, so the FPB coordinate is shared by two routes.
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'east', spans: 2, tc: false }, // A at (2,0)
    { id: 'r2', from: 'origin', direction: 'north', spans: 1, tc: false }, // B at (0,1)
    { id: 'r3', from: 'endpoint:B', direction: 'east', spans: 2, fpb: true }, // FPB at (2,1)
    { id: 'r4', from: 'fpb:1', direction: 'south', spans: 1, tc: false }, // lands on A
  ]);
  assert.ok(network.ok, network.errors.map((e) => e.message).join('; '));
  // Arriving on an existing endpoint reuses it rather than creating a new one.
  assert.equal(network.routes[3].destinationId, 'endpoint:A');
  assert.equal(network.endpoints.filter((e) => e.position.x === 2 && e.position.y === 0).length, 1);

  const scene = buildScene(network, 'preview');
  assert.equal(scene.fpb.length, 1, 'one FPB box');
  const box = scene.fpb[0];
  assert.equal(scene.poles.filter((p) => Math.abs(p.x - box.x) < 0.001 && Math.abs(p.y - box.y) < 0.001).length, 0);
});

test('the Origin defaults to a pole when no marker kind is given', () => {
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'east', spans: 2, tc: false },
  ]);
  assert.equal(network.originMarker, 'plain');
  const scene = buildScene(network, 'preview');
  assert.equal(scene.poles.filter((p) => p.id === 'pole:0,0').length, 1, 'the Origin has an X');
  assert.equal(scene.tc.length, 0);
  assert.equal(scene.fpb.length, 0);
});

test('the Origin can be declared a TC point and then draws a triangle, not an X', () => {
  const network = buildNetwork(
    [{ id: 'r1', from: 'origin', direction: 'east', spans: 2, tc: false }],
    { originMarker: 'tc' },
  );
  assert.equal(network.originMarker, 'tc');
  // tcCount counts TC destinations created by routes; the Origin's own marker
  // is reported separately by originMarker.
  assert.equal(network.tcCount, 0);
  for (const profile of ['preview', 'svg', 'pdf', 'print']) {
    const scene = buildScene(network, profile);
    assert.equal(scene.tc.length, 1, `${profile} draws the Origin triangle`);
    assert.equal(
      scene.poles.filter((p) => p.id === 'pole:0,0').length,
      0,
      `${profile} draws no X at a TC Origin`,
    );
    assert.ok(scene.poles.length >= 1, `${profile} keeps X on ordinary poles`);
  }
  // The Origin is still identifiable as the Origin in the preview.
  assert.ok(buildScene(network, 'preview').labels.some((l) => l.text === 'Origin'));
});

test('the Origin can be declared an FPB and then draws a box, not an X', () => {
  const network = buildNetwork(
    [{ id: 'r1', from: 'origin', direction: 'south', spans: 3, tc: false }],
    { originMarker: 'fpb' },
  );
  assert.equal(network.originMarker, 'fpb');
  assert.equal(network.fpbCount, 0);
  for (const profile of ['preview', 'svg', 'pdf', 'print']) {
    const scene = buildScene(network, profile);
    assert.equal(scene.fpb.length, 1, `${profile} draws the Origin box`);
    assert.equal(scene.fpb[0].text, 'FPB');
    assert.equal(
      scene.poles.filter((p) => p.id === 'pole:0,0').length,
      0,
      `${profile} draws no X at an FPB Origin`,
    );
  }
});

test('an FPB Origin survives into the SVG and PDF exports', () => {
  const network = buildNetwork(
    [{ id: 'r1', from: 'origin', direction: 'east', spans: 2, tc: false }],
    { originMarker: 'fpb' },
  );
  const svg = renderSceneToSvg(buildScene(network, 'svg'), { standalone: false });
  assert.match(svg, /<g id="fpb-markers"/);
  assert.match(svg, />FPB</);

  const { doc, primitives } = renderSceneToPdf(buildScene(network, 'pdf'), {
    jsPDF,
    layout: 'a4_landscape',
    compress: false,
  });
  assert.equal(primitives.fpb, 1);
  const text = new TextDecoder('latin1').decode(new Uint8Array(doc.output('arraybuffer')));
  assert.match(text, /\sre[\s\n]/);
  assert.match(text, /\(FPB\) Tj/);
  assert.doesNotMatch(text, /Origin/);
});

test('an unknown origin marker kind falls back to a pole', () => {
  assert.equal(normalizeMarkerKind('pole'), 'plain');
  assert.equal(normalizeMarkerKind(''), 'plain');
  assert.equal(normalizeMarkerKind(undefined), 'plain');
  assert.equal(normalizeMarkerKind('TC'), 'tc');
  assert.equal(normalizeMarkerKind('fpb'), 'fpb');
  const network = buildNetwork(
    [{ id: 'r1', from: 'origin', direction: 'east', spans: 1, tc: false }],
    { originMarker: 'nonsense' },
  );
  assert.equal(network.originMarker, 'plain');
});

test('the TC triangle is drawn at the doubled marker size', () => {
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: true },
    { id: 'r2', from: 'origin', direction: 'east', spans: 1, tc: false },
  ]);
  const config = createConfig();
  const scene = buildScene(network, 'preview');
  assert.equal(scene.tc[0].halfWidth, config.tcMarkerSize, 'half-width uses the configured size');
  assert.equal(scene.tc[0].height, config.tcMarkerHeight, 'height uses the configured size');
  assert.equal(config.tcMarkerSize, 12);
  assert.equal(config.tcMarkerHeight, 20);
  // The triangle is visibly larger than an X arm, so the two read differently.
  assert.ok(scene.tc[0].height > scene.poles[0].size * 2);
});

test('the TC triangle shrinks with the spacing and never reaches the next pole', () => {
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: true },
    { id: 'r2', from: 'origin', direction: 'east', spans: 1, tc: false },
  ]);
  for (const spanLength of [12, 16, 20, 24, 30, 40, 60, 80]) {
    const scene = buildScene(network, 'preview', { spanLength });
    const triangle = scene.tc[0];
    const top = triangle.y + triangle.halfWidth * 0.35;
    const bottom = top + triangle.height;
    const below = scene.poles.filter((p) => p.y > triangle.y).sort((a, b) => a.y - b.y)[0];
    const above = scene.poles.filter((p) => p.y < triangle.y).sort((a, b) => b.y - a.y)[0];
    if (below) assert.ok(bottom < below.y, `triangle clears the pole below at span ${spanLength}`);
    if (above) assert.ok(top > above.y, `triangle clears the pole above at span ${spanLength}`);
  }
  // At the default spacing the full configured size is used.
  const atDefault = buildScene(network, 'preview').tc[0];
  assert.equal(atDefault.height, createConfig().tcMarkerHeight);
});

test('the TC triangle size also applies to PDF and SVG output', () => {
  const network = buildNetwork([
    { id: 'r1', from: 'origin', direction: 'south', spans: 1, tc: true },
    { id: 'r2', from: 'origin', direction: 'east', spans: 1, tc: false },
  ]);
  const svg = buildScene(network, 'svg');
  const pdf = buildScene(network, 'pdf');
  assert.equal(svg.tc[0].height, pdf.tc[0].height);
  assert.equal(svg.tc[0].height, createConfig().tcMarkerHeight);

  const svgMarkup = renderSceneToSvg(svg, { standalone: false });
  const points = /<polygon[^>]*points="([^"]+)"/.exec(svgMarkup)?.[1];
  assert.ok(points, 'the polygon is present');
  const [, , bottomLeft] = points.trim().split(/\s+/);
  const bottomY = Number(bottomLeft.split(',')[1]);
  const topY = Number(points.trim().split(/\s+/)[0].split(',')[1]);
  assert.ok(Math.abs(bottomY - topY - svg.tc[0].height) < 0.05, 'the drawn height matches the primitive');
});
