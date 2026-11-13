/**
 * What counts as a clash, written down before anything is optimized.
 *
 * F13 puts a broad-phase index in front of the collision test. A broad phase can only be
 * trusted if the exact rule behind it is pinned, because the dangerous cases are the ones
 * where "close enough" is wrong: boxes that touch exactly, boxes that contain each other,
 * degenerate boxes with no area, boxes at negative coordinates, and the same obstacle
 * listed twice, which must count twice.
 *
 * These tests touch only the collision rule and the exhaustive oracle. They say nothing
 * about placement policy, and they contain no timings.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { boxAround } from '../src/geometry/annotations.js';
import { annotateCollides, boxesOverlap, overlapArea } from '../src/geometry/collide.js';
import {
  collidingEntries,
  countCollisionsExhaustive,
} from './support/exhaustive_collisions.mjs';

const BOUNDS = { width: 1000, height: 1000 };
const CLEARANCE = 4;

/** A box from a corner, so a test reads as geometry rather than arithmetic. */
function box(x1, y1, x2, y2) {
  return { x1, y1, x2, y2 };
}

/** Count clashes for a candidate at a centre, with no accepted annotations yet. */
function countAt(center, size, obstacles, taken = [], clearance = CLEARANCE) {
  return countCollisionsExhaustive(center, size, obstacles, taken, BOUNDS, clearance);
}

test('two boxes that do not overlap do not clash', () => {
  assert.equal(annotateCollides(box(0, 0, 10, 10), box(20, 0, 30, 10), 0), false);
  assert.equal(countAt({ x: 5, y: 5 }, { width: 10, height: 10 }, [{ box: box(20, 0, 30, 10) }]), 0);
});

test('partial overlap and complete containment both clash exactly once', () => {
  const candidate = box(0, 0, 10, 10);
  assert.equal(annotateCollides(candidate, box(5, 5, 20, 20), 0), true);
  assert.equal(annotateCollides(candidate, box(2, 2, 4, 4), 0), true);
  assert.equal(
    countAt({ x: 5, y: 5 }, { width: 10, height: 10 }, [{ box: box(5, 5, 20, 20) }]),
    1,
  );
  assert.equal(
    countAt({ x: 5, y: 5 }, { width: 10, height: 10 }, [{ box: box(2, 2, 4, 4) }]),
    1,
  );
});

test('boxes that touch exactly along an edge do not clash without a margin', () => {
  // `boxesOverlap` uses `a.x2 <= b.x1`, so a shared edge is not an overlap. The index
  // has to preserve that: a candidate one clearance away from a marker is legal.
  assert.equal(boxesOverlap(box(0, 0, 10, 10), box(10, 0, 20, 10), 0), false);
  assert.equal(boxesOverlap(box(0, 0, 10, 10), box(0, 10, 10, 20), 0), false);
  // One thousandth of an overlap is an overlap; one thousandth of a gap is not.
  assert.equal(boxesOverlap(box(0, 0, 10, 10), box(9.9999, 0, 20, 10), 0), true);
  assert.equal(boxesOverlap(box(0, 0, 10, 10), box(10.0001, 0, 20, 10), 0), false);
});

test('the clearance margin is inclusive at the boundary', () => {
  const candidate = box(0, 0, 10, 10);
  // Gap of exactly the clearance: no clash.
  assert.equal(annotateCollides(candidate, box(14, 0, 20, 10), 4), false);
  // Gap one thousandth under the clearance: clash.
  assert.equal(annotateCollides(candidate, box(13.999, 0, 20, 10), 4), true);
  // A shared edge becomes a clash as soon as any margin is required.
  assert.equal(annotateCollides(candidate, box(10, 0, 20, 10), 0.0001), true);
});

test('a clash is counted per obstacle entry, not per area', () => {
  const obstacle = { box: box(0, 0, 20, 20) };
  // The same box twice is two collisions: the exhaustive scan walks the list, and the
  // index must not deduplicate it into one.
  assert.equal(countAt({ x: 10, y: 10 }, { width: 4, height: 4 }, [obstacle, obstacle]), 2);
  // A wrapper and a bare box are the same obstacle shape.
  assert.equal(countAt({ x: 10, y: 10 }, { width: 4, height: 4 }, [box(0, 0, 20, 20)]), 1);
});

test('accepted annotations are counted alongside static obstacles', () => {
  const obstacles = [{ box: box(0, 0, 20, 20) }];
  // The candidate is box(8, 8, 12, 12); the first accepted box is within the clearance,
  // the second is nowhere near.
  const taken = [box(14, 0, 34, 20), box(400, 400, 500, 500)];
  assert.equal(countAt({ x: 10, y: 10 }, { width: 4, height: 4 }, obstacles, taken), 2);
  assert.equal(countAt({ x: 200, y: 200 }, { width: 4, height: 4 }, obstacles, taken), 0);
});

test('a candidate that leaves the frame counts one extra collision', () => {
  // Nothing else is in the way, so the only clash is the frame itself.
  assert.equal(countAt({ x: 2, y: 500 }, { width: 10, height: 10 }, []), 1);
  assert.equal(countAt({ x: 500, y: 2 }, { width: 10, height: 10 }, []), 1);
  assert.equal(countAt({ x: 998, y: 500 }, { width: 10, height: 10 }, []), 1);
  assert.equal(countAt({ x: 500, y: 500 }, { width: 10, height: 10 }, []), 0);
  // The frame penalty stacks with a real clash.
  assert.equal(
    countAt({ x: 2, y: 500 }, { width: 10, height: 10 }, [{ box: box(0, 490, 20, 510) }]),
    2,
  );
  // Touching the frame edge exactly is inside.
  assert.equal(countAt({ x: 5, y: 500 }, { width: 10, height: 10 }, []), 0);
});

test('negative coordinates are ordinary coordinates', () => {
  assert.equal(
    countAt({ x: -50, y: 500 }, { width: 10, height: 10 }, [{ box: box(-60, 490, -40, 510) }]),
    2, // one obstacle plus the frame, because it also starts before zero
  );
  assert.equal(
    countAt({ x: 100, y: 100 }, { width: 10, height: 10 }, [{ box: box(-60, 490, -40, 510) }]),
    0,
  );
});

test('degenerate boxes follow the same inclusive-edge rule', () => {
  // A zero-height box is what a horizontal route line becomes before its stroke is added.
  // With no clearance its top and bottom edges are the same line, so it overlaps nothing -
  // including a copy of itself - and the exact predicate is what says so. Any real
  // clearance makes it behave like any other box within that distance.
  const flat = box(0, 10, 40, 10);
  assert.equal(boxesOverlap(box(0, 10, 40, 10), flat, 0), false);
  assert.equal(boxesOverlap(box(0, 10, 40, 10), flat, 4), true);
  assert.equal(boxesOverlap(box(0, 20, 40, 20), flat, 0), false);
  assert.equal(boxesOverlap(box(0, 14, 40, 14), flat, 4), false);
  assert.equal(boxesOverlap(box(0, 13.5, 40, 13.5), flat, 4), true);
  // A zero-area box overlapping nothing has no shared area, which is why overlap area is
  // only ever used to rank two positions that already collide.
  assert.equal(overlapArea(box(0, 0, 10, 10), flat), 0);
});

test('overlap area ranks larger overlaps higher', () => {
  const candidate = box(0, 0, 10, 10);
  assert.equal(overlapArea(candidate, box(5, 5, 15, 15)), 25);
  assert.equal(overlapArea(candidate, box(9, 9, 20, 20)), 1);
  assert.equal(overlapArea(candidate, box(10, 0, 20, 10)), 0);
});

test('the oracle names the entries it counted, not just how many', () => {
  const obstacles = [{ box: box(0, 0, 20, 20) }, { box: box(100, 100, 120, 120) }];
  const taken = [box(400, 400, 500, 500), box(14, 0, 34, 20)];
  const hits = collidingEntries({ x: 10, y: 10 }, { width: 4, height: 4 }, obstacles, taken, BOUNDS, CLEARANCE);
  assert.deepEqual(hits.static, [0]);
  assert.deepEqual(hits.taken, [1]);
  assert.equal(hits.outOfBounds, false);
  assert.equal(
    hits.static.length + hits.taken.length + (hits.outOfBounds ? 1 : 0),
    countAt({ x: 10, y: 10 }, { width: 4, height: 4 }, obstacles, taken),
  );
});

test('boxAround is the only definition of a candidate box', () => {
  assert.deepEqual(boxAround({ x: 100, y: 50 }, { width: 20, height: 10 }), box(90, 45, 110, 55));
});
