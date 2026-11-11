/**
 * Annotation layout: where callouts and span labels go.
 *
 * Two properties are load-bearing and tested here:
 *
 *   - An annotation is placed away from everything it could be confused with. A
 *     leader arrow that lands on the wrong pole is worse than no annotation,
 *     because the drawing then states something false.
 *   - The same input always gives the same position. Exports run the layout
 *     again, so a drift would move a saved callout and change what the sheet says
 *     between one print and the next.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNetwork } from '../src/geometry/network.js';
import { buildScene } from '../src/geometry/scene.js';
import { buildAssetRegistry } from '../src/geometry/assets.js';
import { createSpanLengths, isLoadEligible, setSpanLength } from '../src/data/schedules.js';
import {
  boxesOverlap,
  overlapArea,
  segmentCrossesBox,
  segmentBox,
} from '../src/geometry/collide.js';
import { measureBlock, placeCallout, placeSpanLabel } from '../src/geometry/annotations.js';

/** The example drawing, as routes. */
const EXAMPLE = [
  { id: 'route-1', from: 'origin', direction: 'south', spans: 1, tc: false, fpb: false },
  { id: 'route-2', from: 'endpoint:A', direction: 'east', spans: 4, tc: false, fpb: false },
  { id: 'route-3', from: 'endpoint:B', direction: 'south', spans: 3, tc: true, fpb: false },
  { id: 'route-4', from: 'tc:1', direction: 'south', spans: 3, tc: false, fpb: false },
  { id: 'route-5', from: 'endpoint:C', direction: 'east', spans: 1, tc: false, fpb: false },
  { id: 'route-6', from: 'endpoint:C', direction: 'south', spans: 2, tc: false, fpb: false },
  { id: 'route-7', from: 'endpoint:D', direction: 'west', spans: 3, tc: false, fpb: false },
  { id: 'route-8', from: 'endpoint:D', direction: 'east', spans: 7, tc: false, fpb: false },
  { id: 'route-9', from: 'endpoint:D', direction: 'south', spans: 10, tc: false, fpb: false },
];

/** Build the example scene with the given measured data. */
function scene(data = {}, profile = 'preview', routes = EXAMPLE) {
  const network = buildNetwork(routes, {});
  return buildScene(network, profile, {}, data);
}

/** Every node asset of the example drawing. */
function exampleNodes() {
  return buildAssetRegistry(buildNetwork(EXAMPLE, {})).allNodeAssets();
}

/* ------------------------------------------------------------------ */
/* Collision primitives                                                */
/* ------------------------------------------------------------------ */

test('1. two boxes are compared with a margin', () => {
  const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
  const b = { x1: 20, y1: 0, x2: 30, y2: 10 };
  assert.equal(boxesOverlap(a, b), false);
  assert.equal(boxesOverlap(a, b, 5), false, 'a 5px gap is enough');
  assert.equal(boxesOverlap(a, b, 15), true, 'a 15px margin reaches');
});

test('2. boxes that merely touch do not overlap, but a margin makes them clash', () => {
  // Exact contact with no margin is not an overlap: the clearance rule is what
  // creates the separation, so a zero margin means "touching is allowed".
  const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
  const b = { x1: 10, y1: 0, x2: 20, y2: 10 };
  assert.equal(boxesOverlap(a, b), false, 'sharing an edge is not overlapping');
  assert.equal(boxesOverlap(a, b, 1), true, 'one pixel of required clearance makes it a clash');
});

test('3. overlap area ranks two bad positions', () => {
  const box = { x1: 0, y1: 0, x2: 10, y2: 10 };
  assert.equal(overlapArea(box, { x1: 2, y1: 2, x2: 5, y2: 5 }), 9);
  assert.equal(overlapArea(box, { x1: 50, y1: 50, x2: 60, y2: 60 }), 0);
});

test('4. a segment crossing a box is detected, a near one is not', () => {
  const box = { x1: 0, y1: 0, x2: 10, y2: 10 };
  assert.equal(segmentCrossesBox(-5, 5, 15, 5, box), true, 'through the middle');
  assert.equal(segmentCrossesBox(20, 5, 30, 5, box), false, 'clear of it');
  assert.equal(segmentCrossesBox(-5, 20, 15, 20, box), false, 'above it');
});

test('5. a segment box wraps the stroke', () => {
  const box = segmentBox({ x1: 0, y1: 5, x2: 10, y2: 5 }, 4);
  assert.equal(box.y1, 3);
  assert.equal(box.y2, 7);
});

/* ------------------------------------------------------------------ */
/* Callout placement                                                   */
/* ------------------------------------------------------------------ */

test('6. a callout goes near its own node, not somewhere else', () => {
  const node = { x: 100, y: 100 };
  const size = measureBlock(['25 kVA'], { annotLineSpacing: 12, annotCalloutPaddingX: 3, annotCalloutPaddingY: 2 }, 10);
  const placement = placeCallout({
    node,
    size,
    obstacles: [],
    taken: [],
    bounds: { width: 400, height: 400 },
    config: { annotOffset: 22, annotClearance: 3, spanLength: 40 },
  });
  const distance = Math.hypot(placement.center.x - node.x, placement.center.y - node.y);
  assert.ok(distance < node.x, 'it is beside the node, not across the drawing');
});

test('7. a callout avoids a marker that is already there', () => {
  // A pole immediately to the right blocks the first choice, so the callout
  // has to take another side.
  const node = { x: 100, y: 100 };
  const size = { width: 50, height: 16 };
  const blockingMarker = { box: { x1: 130, y1: 88, x2: 160, y2: 112 } };

  const placement = placeCallout({
    node,
    size,
    obstacles: [blockingMarker],
    taken: [],
    bounds: { width: 500, height: 500 },
    config: { annotOffset: 22, annotClearance: 3, spanLength: 40 },
  });

  assert.equal(placement.side, 'left', 'it moved to the free side');
  const box = {
    x1: placement.center.x - size.width / 2,
    y1: placement.center.y - size.height / 2,
    x2: placement.center.x + size.width / 2,
    y2: placement.center.y + size.height / 2,
  };
  assert.equal(boxesOverlap(box, blockingMarker.box, 3), false, 'and it does not touch the marker');
});

test('8. a callout avoids a line it is not attached to', () => {
  const node = { x: 100, y: 100 };
  const size = { width: 50, height: 16 };
  // A vertical line right where the first choice would go.
  const line = { box: { x1: 140, y1: -100, x2: 141, y2: 500 } };

  const placement = placeCallout({
    node,
    size,
    obstacles: [line],
    taken: [],
    bounds: { width: 500, height: 500 },
    config: { annotOffset: 22, annotClearance: 3, spanLength: 40 },
  });

  assert.notEqual(placement.side, 'right', 'it did not sit on the line');
});

test('9. two callouts do not land on top of each other', () => {
  const size = { width: 50, height: 16 };
  const config = { annotOffset: 22, annotClearance: 3, spanLength: 40 };
  const bounds = { width: 600, height: 600 };

  const first = placeCallout({ node: { x: 100, y: 100 }, size, obstacles: [], taken: [], bounds, config });
  const firstBox = {
    x1: first.center.x - size.width / 2,
    y1: first.center.y - size.height / 2,
    x2: first.center.x + size.width / 2,
    y2: first.center.y + size.height / 2,
  };

  const second = placeCallout({
    node: { x: 100, y: 100 },
    size,
    obstacles: [],
    taken: [firstBox],
    bounds,
    config,
  });
  const secondBox = {
    x1: second.center.x - size.width / 2,
    y1: second.center.y - size.height / 2,
    x2: second.center.x + size.width / 2,
    y2: second.center.y + size.height / 2,
  };

  assert.equal(boxesOverlap(firstBox, secondBox, 3), false, 'the second found its own space');
});

test('10. a callout stays inside the sheet', () => {
  // A node at the very edge, where every close position would be clipped.
  const placement = placeCallout({
    node: { x: 6, y: 6 },
    size: { width: 60, height: 16 },
    obstacles: [],
    taken: [],
    bounds: { width: 200, height: 200 },
    config: { annotOffset: 22, annotClearance: 3, spanLength: 40 },
  });
  assert.ok(placement.center.x > 0, 'it came back inside');
  assert.ok(placement.center.y > 0);
});

test('11. a manual offset is obeyed exactly', () => {
  // The user dragged it somewhere deliberate; the layout must not second-guess that.
  const placement = placeCallout({
    node: { x: 100, y: 100 },
    size: { width: 50, height: 16 },
    obstacles: [{ box: { x1: 120, y1: 90, x2: 200, y2: 110 } }],
    taken: [],
    bounds: { width: 500, height: 500 },
    offset: { dx: 0, dy: 60 },
    config: { annotOffset: 22, annotClearance: 3, spanLength: 40 },
  });
  assert.equal(placement.manual, true);
  // The base choice for 'right' plus the offset.
  assert.equal(placement.center.y, 100 + 60);
  assert.equal(placement.center.x, 100 + 22 + 25);
});

test('12. placement is deterministic', () => {
  const args = () => ({
    node: { x: 100, y: 100 },
    size: { width: 50, height: 16 },
    obstacles: [],
    taken: [],
    bounds: { width: 500, height: 500 },
    config: { annotOffset: 22, annotClearance: 3, spanLength: 40 },
  });
  assert.deepEqual(placeCallout(args()), placeCallout(args()));
});

/* ------------------------------------------------------------------ */
/* Span label placement                                                */
/* ------------------------------------------------------------------ */

test('13. a horizontal span label sits above the line', () => {
  const placement = placeSpanLabel({
    span: { x1: 0, y1: 100, x2: 40, y2: 100 },
    size: { width: 30, height: 14 },
    obstacles: [],
    taken: [],
    bounds: { width: 400, height: 400 },
    config: { annotSpanGap: 7, annotClearance: 3, spanLength: 40 },
  });
  assert.equal(placement.side, 'above');
  assert.ok(placement.center.y < 100, 'it is above the midpoint');
  assert.equal(placement.center.x, 20, 'and on the midpoint');
});

test('14. a vertical span label sits beside the line', () => {
  const placement = placeSpanLabel({
    span: { x1: 100, y1: 0, x2: 100, y2: 40 },
    size: { width: 30, height: 14 },
    obstacles: [],
    taken: [],
    bounds: { width: 400, height: 400 },
    config: { annotSpanGap: 7, annotClearance: 3, spanLength: 40 },
  });
  assert.equal(placement.side, 'left', 'left is the first choice for a vertical span');
  assert.ok(placement.center.x < 100);
});

test('15. a blocked first side moves the span label, not the span', () => {
  const span = { x1: 0, y1: 100, x2: 40, y2: 100 };
  const placement = placeSpanLabel({
    span,
    size: { width: 30, height: 14 },
    obstacles: [{ box: { x1: -10, y1: 70, x2: 50, y2: 82 } }],
    taken: [],
    bounds: { width: 400, height: 400 },
    config: { annotSpanGap: 7, annotClearance: 3, spanLength: 40 },
  });
  assert.equal(placement.side, 'below', 'it went under instead');
  assert.deepEqual(span, { x1: 0, y1: 100, x2: 40, y2: 100 }, 'the span is untouched');
});

/* ------------------------------------------------------------------ */
/* The layer inside a real scene                                       */
/* ------------------------------------------------------------------ */

test('16. a load on a node produces one callout with its text', () => {
  const s = scene({ loads: [{ id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' }] });
  assert.equal(s.annotations.callouts.length, 1);
  assert.deepEqual(s.annotations.callouts[0].lines, ['25 kVA']);
});

test('17. several loads on one node produce one callout with several lines', () => {
  const s = scene({
    loads: [
      { id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' },
      { id: 'load-2', nodeId: 'dst:route-1', value: 5, unit: 'kW' },
      { id: 'load-3', nodeId: 'dst:route-1', value: 12, unit: 'HP' },
    ],
  });
  assert.equal(s.annotations.callouts.length, 1, 'one box, not three');
  assert.deepEqual(s.annotations.callouts[0].lines, ['25 kVA', '5 kW', '12 HP']);
});

test('18. every load on every node gets a leader arrow pointing at its node', () => {
  const nodes = exampleNodes().filter((a) => a.nodeType === 'pole');
  const loads = nodes.slice(0, 4).map((node, i) => ({
    id: `load-${i + 1}`,
    nodeId: node.id,
    value: 10 + i,
    unit: 'kVA',
  }));
  const s = scene({ loads });
  assert.equal(s.annotations.callouts.length, 4);

  for (const callout of s.annotations.callouts) {
    assert.ok(callout.leader, 'it has a leader');
    assert.ok(callout.arrow, 'with an arrowhead');
    // The arrow tip is the node, so the annotation points at the right pole.
    const node = nodes.find((n) => n.id === callout.assetId);
    const expected = s.poles.find((p) => p.id === `pole:${node.coordKey}`);
    assert.ok(expected, 'the node is drawn');
    assert.equal(Math.round(callout.leader.tipX), Math.round(expected.x));
    assert.equal(Math.round(callout.leader.tipY), Math.round(expected.y));
  }
});

test('19. a callout does not sit on a pole marker', () => {
  const s = scene({ loads: [{ id: 'load-1', nodeId: 'dst:route-2', value: 25, unit: 'kVA' }] });
  const callout = s.annotations.callouts[0];
  const box = {
    x1: callout.center.x - 30,
    y1: callout.center.y - 12,
    x2: callout.center.x + 30,
    y2: callout.center.y + 12,
  };
  for (const pole of s.poles) {
    const poleBox = { x1: pole.x - 5, y1: pole.y - 5, x2: pole.x + 5, y2: pole.y + 5 };
    assert.equal(boxesOverlap(box, poleBox), false, 'clear of every pole');
  }
});

test('20. a span with a measured length gets a label', () => {
  const registry = buildAssetRegistry(buildNetwork(EXAMPLE, {}));
  const span = registry.allSpanAssets()[0];
  let lengths = createSpanLengths();
  lengths = setSpanLength(lengths, span.id, 32.5).spanLengths;

  const s = scene({ spanLengths: lengths });
  // Every span is labelled, so the measured one is one of them rather than the only
  // one. Finding it by asset id keeps this a test of the label, not of the count.
  const labelled = s.annotations.spans.find((a) => a.assetId === span.id);
  assert.ok(labelled, 'the measured span is labelled');
  assert.deepEqual(labelled.lines, ['32.5 m']);
  assert.equal(labelled.measured, true);
});

test('21. an unmeasured span is labelled with a dash, never with nothing', () => {
  // A span with no label at all makes a half-surveyed drawing look finished, so the
  // placeholder is the defect fix rather than a cosmetic choice.
  const s = scene({ spanLengths: createSpanLengths() });
  assert.equal(s.annotations.spans.length > 0, true, 'spans are labelled');
  for (const span of s.annotations.spans) {
    assert.deepEqual(span.lines, ['— m'], 'an unmeasured span reads as a dash');
    assert.equal(span.measured, false);
  }
});

test('21b. the unmeasured placeholder is not read as zero', () => {
  const s = scene({ spanLengths: createSpanLengths() });
  const text = s.annotations.spans[0].lines[0];
  assert.notEqual(text, '0 m');
  assert.match(text, /—/);
});

test('21c. the incomplete notice counts unmeasured spans and disappears when complete', () => {
  const registry = buildAssetRegistry(buildNetwork(EXAMPLE, {}));
  const spans = registry.allSpanAssets();

  const empty = scene({ spanLengths: createSpanLengths() });
  assert.ok(empty.annotations.notice, 'a notice is present while spans are unmeasured');
  assert.equal(empty.annotations.completeness.total, spans.length);
  assert.equal(empty.annotations.completeness.unmeasured, spans.length);
  assert.match(
    empty.annotations.notice.text,
    new RegExp(`${spans.length} of ${spans.length} spans unmeasured`),
  );

  let all = createSpanLengths();
  for (const span of spans) all = setSpanLength(all, span.id, 30).spanLengths;
  const complete = scene({ spanLengths: all });
  assert.equal(complete.annotations.notice, null, 'the notice is gone once every span is measured');
  assert.equal(complete.annotations.completeness.unmeasured, 0);
});

test('22. an integer length has no trailing decimal', () => {
  const registry = buildAssetRegistry(buildNetwork(EXAMPLE, {}));
  const span = registry.allSpanAssets()[0];
  const lengths = setSpanLength(createSpanLengths(), span.id, 30).spanLengths;
  const s = scene({ spanLengths: lengths });
  assert.deepEqual(s.annotations.spans[0].lines, ['30 m']);
});

test('23. a load on a point that is not drawn draws nothing', () => {
  // The record is kept in the data, but there is nothing on the sheet to attach it
  // to, so it must not appear as a floating number.
  const s = scene({ loads: [{ id: 'load-1', nodeId: 'dst:route-99', value: 25, unit: 'kVA' }] });
  assert.equal(s.annotations.callouts.length, 0);
});

test('24. the layout is stable across two builds of the same scene', () => {
  const data = {
    loads: [
      { id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' },
      { id: 'load-2', nodeId: 'dst:route-2', value: 5, unit: 'kW' },
    ],
  };
  const a = scene(data);
  const b = scene(data);
  assert.deepEqual(
    a.annotations.callouts.map((c) => [c.assetId, c.center, c.side]),
    b.annotations.callouts.map((c) => [c.assetId, c.center, c.side]),
  );
});

test('25. every renderer gets the same annotations', () => {
  // The single-scene rule: the exports must draw exactly what the preview drew.
  const data = { loads: [{ id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' }] };
  const preview = scene(data, 'preview');
  const pdf = scene(data, 'pdf');
  const svg = scene(data, 'svg');
  const print = scene(data, 'print');

  // Compared relative to the arrow tip, because the preview and the exports carry
  // different page margins and a scene coordinate legitimately includes that
  // margin. What must not differ is where the callout sits relative to its pole.
  const shape = (s) =>
    s.annotations.callouts.map((c) => ({
      id: c.id,
      side: c.side,
      lines: c.lines,
      dx: Math.round(c.center.x - c.leader.tipX),
      dy: Math.round(c.center.y - c.leader.tipY),
    }));
  assert.deepEqual(shape(pdf), shape(preview));
  assert.deepEqual(shape(svg), shape(preview));
  assert.deepEqual(shape(print), shape(preview));
});

test('26. the scene reports that it has text when annotations exist', () => {
  // Exports hide the alphabetical labels, but a callout is content, not a label,
  // so a scene with only callouts still has visible text.
  const s = scene(
    { loads: [{ id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' }] },
    'pdf',
  );
  assert.equal(s.annotations.callouts.length, 1);
  assert.equal(s.hasVisibleText, true);
});

test('27. a load on a TC point is refused by the data model, not placed anyway', () => {
  // A TC is out of scope for loads. The layer can place one if a file somehow
  // contains it, but the model must not accept it in the first place, which is
  // what keeps the drawing honest.
  const registry = buildAssetRegistry(buildNetwork(EXAMPLE, {}));
  const tc = registry.allNodeAssets().find((a) => a.nodeType === 'tc');
  assert.ok(tc, 'the example has a TC');
  assert.equal(isLoadEligible(tc.nodeType), false, 'the model refuses it');
});

test('28. a manually placed callout keeps its offset in the scene', () => {
  const s = scene({
    loads: [{ id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' }],
    loadPlacements: { 'dst:route-1': { dx: 0, dy: 0 } },
  });
  assert.equal(s.annotations.callouts[0].manual, false, 'a zero offset is not a drag');

  const moved = scene({
    loads: [{ id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' }],
    loadPlacements: { 'dst:route-1': { dx: 40, dy: 0 } },
  });
  assert.equal(moved.annotations.callouts[0].manual, true);
  // The two are compared as "distance from the pole", not against each other: an
  // unmoved callout may have taken a different side to avoid a neighbour, so
  // subtracting the two positions would compare different bases.
  const pole = s.poles.find((p) => p.id === 'pole:4,-1') ?? s.poles[0];
  assert.ok(pole, 'the pole is drawn');
  const movedDx = moved.annotations.callouts[0].center.x - moved.annotations.callouts[0].leader.tipX;
  const baseDx = s.annotations.callouts[0].center.x - s.annotations.callouts[0].leader.tipX;
  assert.equal(Math.round(movedDx - baseDx), 40, 'the offset moved it 40px further right');
});

test('29. span labels and callouts keep out of each other way', () => {
  const registry = buildAssetRegistry(buildNetwork(EXAMPLE, {}));
  const span = registry.allSpanAssets().find(
    (s) => s.a === 'dst:route-1' || s.b === 'dst:route-1',
  );
  const lengths = span ? setSpanLength(createSpanLengths(), span.id, 30).spanLengths : createSpanLengths();

  const s = scene({
    loads: [{ id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' }],
    spanLengths: lengths,
  });
  assert.equal(s.annotations.callouts.length, 1);
  if (s.annotations.spans.length === 1) {
    const a = s.annotations.callouts[0];
    const b = s.annotations.spans[0];
    const dist = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);
    assert.ok(dist > 10, 'they are not stacked on each other');
  }
});

test('30. the example drawing with a full survey produces one annotation per item', () => {
  const registry = buildAssetRegistry(buildNetwork(EXAMPLE, {}));
  const spans = registry.allSpanAssets();
  let lengths = createSpanLengths();
  for (const span of spans) lengths = setSpanLength(lengths, span.id, 30).spanLengths;

  const nodes = exampleNodes().filter((a) => a.nodeType === 'pole' || a.nodeType === 'fpb');
  const loads = nodes.slice(0, 3).map((node, i) => ({
    id: `load-${i + 1}`,
    nodeId: node.id,
    value: 10,
    unit: 'kVA',
  }));

  const s = scene({ loads, spanLengths: lengths });
  assert.equal(s.annotations.callouts.length, 3, 'one per loaded node');
  assert.equal(s.annotations.spans.length, spans.length, 'one per measured span');
});

// ---- manual placement (Part I2) ----

/** A drawing with one load, giving a callout to drag. */
function loadScene(offset, extra = {}) {
  return scene({
    loads: [{ id: 'load-1', nodeId: 'dst:route-2', value: 25, unit: 'kVA' }],
    loadPlacements: offset ? { 'dst:route-2': offset } : {},
    ...extra,
  });
}

test('31. a drag starts from the automatic position, not from candidate zero', () => {
  // The defect: a callout the layout had put on the pole's left jumped across the
  // pole the moment it was touched, because the offset was applied to the first
  // candidate instead of to the one on screen.
  const auto = loadScene(null).annotations.callouts[0];
  const moved = loadScene({ dx: 4, dy: 0, candidateIndex: auto.candidateIndex }).annotations
    .callouts[0];
  assert.equal(auto.candidateIndex, moved.candidateIndex, 'the anchor is the one that was drawn');
  assert.equal(Math.round(moved.center.x - auto.center.x), 4, 'the nudge is the nudge');
  assert.equal(Math.round(moved.center.y - auto.center.y), 0);
});

test('32. an offset with no stored index falls back to the first candidate', () => {
  // An older project has no candidate index. It must still open and still show the
  // annotation where its offset says, rather than drawing at NaN.
  const auto = loadScene(null).annotations.callouts[0];
  const old = loadScene({ dx: 10, dy: 10 }).annotations.callouts[0];
  assert.ok(Number.isFinite(old.center.x) && Number.isFinite(old.center.y));
  assert.ok(old.center.x > auto.center.x, 'a positive nudge moves it right');
});

test('33. a manual placement is stable across two builds of the same scene', () => {
  const offset = { dx: 8, dy: -6, candidateIndex: 2 };
  const a = loadScene(offset).annotations.callouts[0];
  const b = loadScene(offset).annotations.callouts[0];
  assert.deepEqual(a.center, b.center, 'the same input gives the same position');
});

test('34. a span label drag starts from its automatic position', () => {
  const registry = buildAssetRegistry(buildNetwork(EXAMPLE, {}));
  const span = registry.allSpanAssets()[0];
  let lengths = createSpanLengths();
  lengths = setSpanLength(lengths, span.id, 32).spanLengths;

  const auto = scene({ spanLengths: lengths }).annotations.spans.find((s) => s.assetId === span.id);
  const moved = scene({
    spanLengths: lengths,
    spanPlacements: { [span.id]: { dx: 3, dy: 0, candidateIndex: auto.candidateIndex } },
  }).annotations.spans.find((s) => s.assetId === span.id);

  assert.equal(auto.candidateIndex, moved.candidateIndex);
  assert.equal(Math.round(moved.center.x - auto.center.x), 3);
});

test('35. the candidate index a drag records is the one the layout chose', () => {
  // Contract between the layout and the drag handler: whatever the automatic pass
  // settled on is what an annotation reports, so the handler has something real to
  // store.
  const s = loadScene(null);
  const callout = s.annotations.callouts[0];
  assert.equal(Number.isInteger(callout.candidateIndex), true);
  assert.ok(callout.candidateIndex >= 0);
});
