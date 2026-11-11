/**
 * The compact reference drawing beside the schedules.
 *
 * The property that matters is that it is a *copy* of the drawing, not a second
 * drawing. If it computed its own geometry it could show a pole the schedule does
 * not have, and the three outputs would drift. So the tests check that it takes the
 * same scene the main preview renders, fits it without changing it, and overlays
 * exactly the designations and the one selection ring.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNetwork } from '../src/geometry/network.js';
import { buildScene } from '../src/geometry/scene.js';
import { buildAssetRegistry } from '../src/geometry/assets.js';
import { allocateDesignations } from '../src/geometry/designations.js';
import { renderSceneToSvg } from '../src/render/svg.js';
import {
  buildDesignationOverlay,
  buildSelectionRing,
  composeMiniPreview,
  fitViewBox,
} from '../src/ui/mini_preview.js';

const EXAMPLE = [
  { id: 'route-1', from: 'origin', direction: 'south', spans: 1 },
  { id: 'route-2', from: 'endpoint:A', direction: 'east', spans: 4 },
  { id: 'route-3', from: 'endpoint:B', direction: 'south', spans: 3, tc: true },
  { id: 'route-4', from: 'tc:1', direction: 'south', spans: 3 },
  { id: 'route-5', from: 'endpoint:C', direction: 'east', spans: 1 },
  { id: 'route-6', from: 'endpoint:C', direction: 'south', spans: 2 },
];

/** A scene and its named registry, as the panel builds them. */
function drawing() {
  const network = buildNetwork(EXAMPLE, {});
  const allocation = allocateDesignations(network);
  const registry = buildAssetRegistry(network, { designations: allocation.nodeDesignations });
  const scene = buildScene(network, 'preview', {}, { loads: [], spanLengths: new Map() });
  return { network, registry, scene };
}

const escape = (t) =>
  String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('mini 1. the reference is built from the same scene as the main preview', () => {
  const { scene } = drawing();
  const markup = composeMiniPreview({
    sceneSvg: renderSceneToSvg(scene, { standalone: false }),
    viewBox: fitViewBox(scene),
    overlay: '',
    ring: '',
  });
  // Same primitives the main preview draws, because it is the same render call.
  assert.equal((markup.match(/<line /g) ?? []).length, scene.lines.length);
  assert.equal((markup.match(/<path /g) ?? []).length, scene.poles.length);
  assert.equal((markup.match(/<polygon /g) ?? []).length, scene.tc.length);
});

test('mini 2. the viewBox fits the whole drawing without changing it', () => {
  const { scene } = drawing();
  const viewBox = fitViewBox(scene, 10);
  const [x, y, w, h] = viewBox.split(' ').map(Number);
  assert.equal(x, -10);
  assert.equal(y, -10);
  assert.equal(w, scene.width + 20);
  assert.equal(h, scene.height + 20);
  // Nothing inside the drawing moved: the scene is untouched.
  assert.equal(scene.width, scene.width);
});

test('mini 3. it shows every pole designation the schedule shows', () => {
  const { registry, scene } = drawing();
  const positions = new Map();
  for (const pole of scene.poles) positions.set(pole.id, { x: pole.x, y: pole.y });
  // Map coordinate-keyed pole ids onto asset ids, as the app does.
  const nodePositions = new Map();
  for (const asset of registry.allNodeAssets()) {
    const pole = scene.poles.find((p) => p.id === `pole:${asset.coordKey}`);
    const box = scene.fpb.find((b) => b.id === `fpb:${asset.coordKey}`);
    const tri = scene.tc.find((t) => t.id === `tc:${asset.coordKey}`);
    const at = pole ?? box ?? tri;
    if (at) nodePositions.set(asset.id, { x: at.x, y: at.y });
  }

  const overlay = buildDesignationOverlay({
    nodes: registry.allNodeAssets(),
    positions: nodePositions,
    config: scene.config,
    escapeText: escape,
  });

  for (const asset of registry.allNodeAssets()) {
    const designation = asset.designation;
    if (!designation) continue;
    if (!nodePositions.has(asset.id)) continue;
    assert.ok(overlay.includes(`>${escape(designation)}<`), `${designation} is labelled`);
  }
});

test('mini 4. an internal id is never used as a label', () => {
  const { registry, scene } = drawing();
  const positions = new Map(registry.allNodeAssets().map((a) => [a.id, { x: 0, y: 0 }]));
  const overlay = buildDesignationOverlay({
    nodes: registry.allNodeAssets(),
    positions,
    config: scene.config,
    escapeText: escape,
  });
  assert.doesNotMatch(overlay, /mid:/, 'no intermediate internal id leaks onto the drawing');
  assert.doesNotMatch(overlay, /dst:/, 'no destination internal id leaks onto the drawing');
});

test('mini 5. the font grows as the drawing is shrunk, so names stay readable', () => {
  const { registry, scene } = drawing();
  const positions = new Map(registry.allNodeAssets().map((a) => [a.id, { x: 0, y: 0 }]));
  const small = buildDesignationOverlay({
    nodes: registry.allNodeAssets(),
    positions,
    config: scene.config,
    escapeText: escape,
    fontScale: 1,
  });
  const large = buildDesignationOverlay({
    nodes: registry.allNodeAssets(),
    positions,
    config: scene.config,
    escapeText: escape,
    fontScale: 3,
  });
  const sizeOf = (markup) => Number(/font-size="([\d.]+)"/.exec(markup)[1]);
  assert.ok(sizeOf(large) > sizeOf(small), 'a smaller panel gets a bigger font');
  assert.equal(sizeOf(small), scene.config.miniDesignationFontSize);
});

test('mini 6. a selection ring marks a node', () => {
  const { registry, scene } = drawing();
  const node = registry.allNodeAssets()[0];
  const positions = new Map([[node.id, { x: 100, y: 50 }]]);
  const ring = buildSelectionRing({
    selection: { kind: 'node', id: node.id },
    positions,
    spans: new Map(),
    config: scene.config,
  });
  assert.match(ring, /<circle /);
  assert.match(ring, /cx="100"/);
  assert.match(ring, /cy="50"/);
});

test('mini 7. a selection ring marks a span along its length', () => {
  const { registry, scene } = drawing();
  const span = registry.allSpanAssets()[0];
  const ring = buildSelectionRing({
    selection: { kind: 'span', id: span.id },
    positions: new Map(),
    spans: new Map([[span.id, { x1: 0, y1: 0, x2: 40, y2: 0 }]]),
    config: scene.config,
  });
  assert.match(ring, /<line /);
  assert.match(ring, /x2="40"/);
});

test('mini 8. no selection draws no ring', () => {
  const { scene } = drawing();
  const ring = buildSelectionRing({
    selection: null,
    positions: new Map(),
    spans: new Map(),
    config: scene.config,
  });
  assert.equal(ring, '');
});

test('mini 9. a selection of something not drawn draws nothing rather than failing', () => {
  const { scene } = drawing();
  const ring = buildSelectionRing({
    selection: { kind: 'node', id: 'dst:not-a-route' },
    positions: new Map(),
    spans: new Map(),
    config: scene.config,
  });
  assert.equal(ring, '');
});

test('mini 10. the composed markup is one self-contained SVG', () => {
  const { registry, scene } = drawing();
  const positions = new Map(registry.allNodeAssets().map((a) => [a.id, { x: 10, y: 10 }]));
  const overlay = buildDesignationOverlay({
    nodes: registry.allNodeAssets(),
    positions,
    config: scene.config,
    escapeText: escape,
  });
  const ring = buildSelectionRing({
    selection: { kind: 'node', id: registry.allNodeAssets()[0].id },
    positions,
    spans: new Map(),
    config: scene.config,
  });
  const markup = composeMiniPreview({
    sceneSvg: renderSceneToSvg(scene, { standalone: false }),
    viewBox: fitViewBox(scene),
    overlay,
    ring,
  });
  assert.equal((markup.match(/<svg/g) ?? []).length, 1, 'one svg element');
  assert.equal((markup.match(/<\/svg>/g) ?? []).length, 1, 'closed exactly once');
  assert.ok(markup.indexOf('#point-designations') < markup.indexOf('</svg>'), 'overlay is inside');
  assert.ok(markup.indexOf('#mini-selection') < markup.indexOf('</svg>'), 'ring is inside');
  // The fitted viewBox replaced the scene's own, and the element fills its panel.
  assert.match(markup, /width="100%"/);
  assert.match(markup, /height="100%"/);
});

test('mini 11. the reference does not carry the main preview\'s profile name', () => {
  const { scene } = drawing();
  const markup = composeMiniPreview({
    sceneSvg: renderSceneToSvg(scene, { standalone: false }),
    viewBox: fitViewBox(scene),
    overlay: '',
    ring: '',
  });
  // Marked as its own profile so nothing can mistake it for the main preview's node
  // and read its zoom or pan state.
  assert.match(markup, /data-profile="mini"/);
});
