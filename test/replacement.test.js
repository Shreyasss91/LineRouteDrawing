/**
 * Asking before a project is replaced.
 *
 * The first implementation asked only when the table had rows:
 *
 *     const hasWork = state.routes.length > 0
 *
 * That is the wrong question. A project with no routes still holds an Origin
 * symbol, a span spacing and a page layout the user chose, and replacing those
 * without asking loses exactly as much - just less visibly. It also asked when
 * nothing would change, so re-opening the project already on screen produced a
 * pointless scare.
 *
 * The rule now: compare the whole authored project, ask only when opening the
 * file would actually change something, and never ask when the file is invalid.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProjectJson, sameAuthoredProject, serializeProjectJson } from '../src/ui/project.js';

const FIXED_DATE = new Date('2026-09-10T11:12:13.000Z');

function project(overrides = {}) {
  return {
    routes: [],
    originMarker: 'plain',
    spanLength: 40,
    layout: 'a4_landscape',
    ...overrides,
  };
}

function withRoutes() {
  return project({
    routes: [
      { id: 'route-1', from: 'origin', direction: 'south', spans: 3, tc: false, fpb: false },
      { id: 'route-2', from: 'endpoint:A', direction: 'east', spans: 2, tc: true, fpb: false },
    ],
  });
}

test('1. a non-empty project is replaced by a different project, so it asks', () => {
  const prompted = !sameAuthoredProject(withRoutes(), project({ originMarker: 'fpb' }));
  assert.equal(prompted, true);
});

test('2. an empty project with an FPB Origin differs from an empty project with a Pole Origin', () => {
  // The case the route count alone could not see: no routes either side, but the
  // Origin symbol and therefore the drawing are different.
  const a = project({ originMarker: 'fpb' });
  const b = project({ originMarker: 'plain' });
  assert.equal(sameAuthoredProject(a, b), false, 'these are not the same project');
});

test('3. an empty project with different spacing differs', () => {
  assert.equal(sameAuthoredProject(project({ spanLength: 40 }), project({ spanLength: 60 })), false);
});

test('4. an empty project with a different page layout differs', () => {
  assert.equal(
    sameAuthoredProject(project({ layout: 'a4_landscape' }), project({ layout: 'a3_landscape' })),
    false,
  );
});

test('5. an identical project needs no confirmation', () => {
  const a = withRoutes();
  const b = withRoutes();
  assert.equal(sameAuthoredProject(a, b), true);

  // Also across a save and load, which is how the file actually arrives.
  const reloaded = parseProjectJson(serializeProjectJson(a, { now: FIXED_DATE }));
  assert.equal(reloaded.ok, true);
  assert.equal(
    sameAuthoredProject(a, reloaded.project),
    true,
    're-opening the project already on screen asks nothing',
  );
});

test('6. declining leaves the current project untouched', () => {
  // The decision is a pure comparison, so declining is simply "do not call
  // applyProject". What must be true is that no state was mutated by asking.
  const current = withRoutes();
  const snapshot = JSON.stringify(current);
  const incoming = project({ originMarker: 'tc' });

  const differs = !sameAuthoredProject(current, incoming);
  assert.equal(differs, true);
  // Nothing about building the answer changes the current project.
  assert.equal(JSON.stringify(current), snapshot);
});

test('7. an invalid file is refused before any confirmation is considered', () => {
  // A malformed file must be reported, not turned into a replacement question.
  for (const text of ['{ broken', '[]', '{"format":"line-route-drawing-project"}']) {
    const parsed = parseProjectJson(text);
    assert.equal(parsed.ok, false, `${text} does not reach the comparison`);
    assert.ok(parsed.message.length > 0);
  }
});

test('8. a difference in route identity alone is a difference', () => {
  const a = withRoutes();
  const b = withRoutes();
  b.routes[1] = { ...b.routes[1], id: 'route-99' };
  assert.equal(sameAuthoredProject(a, b), false, 'route identity is part of the project');
});

test('9. a difference in route order alone is a difference', () => {
  // Order matters: a later route may only start from an endpoint an earlier one
  // created, so swapping two rows can change what the drawing is.
  const a = withRoutes();
  const b = withRoutes();
  b.routes.reverse();
  assert.equal(sameAuthoredProject(a, b), false);
});

test('10. every authored route field participates in the comparison', () => {
  const base = withRoutes();
  const variants = [
    ['from', (r) => ({ ...r, from: 'origin' })],
    ['direction', (r) => ({ ...r, direction: 'west' })],
    ['spans', (r) => ({ ...r, spans: 5 })],
    ['tc', (r) => ({ ...r, tc: false })],
    ['fpb', (r) => ({ ...r, fpb: true })],
    ['id', (r) => ({ ...r, id: 'route-77' })],
  ];

  for (const [field, mutate] of variants) {
    const changed = withRoutes();
    changed.routes[1] = mutate(changed.routes[1]);
    assert.equal(
      sameAuthoredProject(base, changed),
      false,
      `a change to ${field} is a change to the project`,
    );
  }
});

test('11. a numeric string and a number are the same value', () => {
  const typed = project({ spanLength: '48' });
  const restored = project({ spanLength: 48 });
  assert.equal(sameAuthoredProject(typed, restored), true, 'the field is a number either way');
});

test('12. a flag that is truthy and the boolean true are the same', () => {
  const truthy = project({
    routes: [{ id: 'route-1', from: 'origin', direction: 'south', spans: 1, tc: 1, fpb: 0 }],
  });
  const boolean = project({
    routes: [{ id: 'route-1', from: 'origin', direction: 'south', spans: 1, tc: true, fpb: false }],
  });
  assert.equal(sameAuthoredProject(truthy, boolean), true);
});

test('13. the comparison ignores nothing the schema stores', () => {
  // Guards the schema: if a field is added to the payload it must also be added
  // to the comparison, or a file could replace it without asking.
  const payloadKeys = Object.keys(
    JSON.parse(serializeProjectJson(withRoutes(), { now: FIXED_DATE })).project,
  );
  assert.deepEqual(payloadKeys.sort(), [
    'layout',
    'loadPlacements',
    'loads',
    'originMarker',
    'routes',
    'spanLength',
    'spanLengths',
    'spanPlacements',
  ]);

  // Every stored field except the routes (covered by their own case) must make
  // two projects compare as different, or a file could replace it without asking.
  for (const key of payloadKeys) {
    if (key === 'routes') continue;
    const a = { ...withRoutes(), loads: [], spanLengths: new Map(), loadPlacements: {}, spanPlacements: {} };
    const b = JSON.parse(JSON.stringify({ ...a, spanLengths: {} }));
    const changed = {
      spanLength: a.spanLength + 1,
      originMarker: 'tc',
      layout: 'a3_landscape',
      loads: [{ id: 'load-1', nodeId: 'origin', value: 5, unit: 'kVA' }],
      spanLengths: { 'origin~dst:route-1': 30 },
      loadPlacements: { origin: { dx: 4, dy: 4 } },
      spanPlacements: { 'origin~dst:route-1': { dx: 2, dy: 2 } },
    };
    b[key] = changed[key];
    assert.equal(sameAuthoredProject(a, b), false, `${key} is compared`);
  }
});

test('14. two empty projects that match need no confirmation', () => {
  assert.equal(sameAuthoredProject(project(), project()), true);
});

test('15. a project and nothing at all are different', () => {
  assert.equal(sameAuthoredProject(project(), null), false);
  assert.equal(sameAuthoredProject(null, project()), false);
  assert.equal(sameAuthoredProject(null, null), true);
});
