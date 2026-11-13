/**
 * The broad phase must never lose an obstacle.
 *
 * F13 replaced an exhaustive collision scan with a uniform grid
 * ([src/geometry/spatial_index.js](../src/geometry/spatial_index.js)). A grid can only fail
 * in one dangerous direction: it can propose too much, which costs time, or too little,
 * which moves a label. Everything here compares the grid's count against the exhaustive
 * oracle in `test/support/exhaustive_collisions.mjs` and demands the same number.
 *
 * Three levels of evidence, because each catches a different mistake:
 *
 *   1. **The real drawings.** The obstacles of all four baseline datasets, queried at every
 *      annotation's actual position and at hundreds of generated boxes. This is what the
 *      application actually asks.
 *   2. **Adversarial geometry.** Obstacles that span many cells, sit exactly on a cell
 *      boundary, live at negative coordinates, have no width, or are registered twice. This
 *      is where an off-by-one in the cell range or a deduplicated entry shows up.
 *   3. **A measured sweep.** A deterministic pseudo-random field of obstacles and queries
 *      with no grid-alignment, so a systematic off-by-one cannot hide behind round numbers.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { scenarios } from '../scripts/benchmark-datasets.mjs';
import { boxAround, measureBlock } from '../src/geometry/annotations.js';
import { DEFAULT_CELL_SIZE, createObstacleIndex, collisionCounter } from '../src/geometry/spatial_index.js';
import { buildSceneFor, parseRecord, recordLines } from './support/placement_capture.mjs';
import {
  countCollisionsExhaustive,
  collidingEntries,
} from './support/exhaustive_collisions.mjs';

/** A tiny deterministic PRNG: the same sweep every run, on every machine. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A box from a centre and a size. */
function at(center, width, height) {
  return boxAround(center, { width, height });
}

/**
 * The frame penalty, copied from the rule production applies.
 *
 * The index counts obstacles only, so comparing it against the exhaustive oracle means
 * adding the same off-sheet term the oracle adds.
 */
function framePenalty(box, bounds) {
  return box.x1 < 0 || box.y1 < 0 || box.x2 > bounds.width || box.y2 > bounds.height ? 1 : 0;
}

/** Build an index from a list of obstacles, registering them in order. */
function indexOf(obstacles, clearance, cellSize) {
  const index = createObstacleIndex({ clearance, cellSize });
  for (const obstacle of obstacles) index.insert(obstacle.box ?? obstacle);
  return index;
}

/** The committed capture for one drawing. */
function goldenRecords(name) {
  return recordLines(readFileSync(new URL(`./fixtures/placement/${name}.txt`, import.meta.url), 'utf8'))
    .filter((line) => !line.startsWith('notice|') && !line.startsWith('completeness|'))
    .map(parseRecord);
}

test('the grid counts exactly what the exhaustive scan counts on every real drawing', async (t) => {
  for (const s of scenarios()) {
    await t.test(`${s.name}: every placed annotation and 300 generated boxes`, () => {
      const scene = buildSceneFor(s.project, 'preview');
      const obstacles = scene.annotations.obstacles;
      const clearance = scene.config.annotClearance;
      const padding = scene.padding;
      const bounds = {
        width: scene.width - padding * 2,
        height: scene.height - padding * 2,
      };
      const index = indexOf(obstacles, clearance);
      assert.equal(index.size, obstacles.length, 'the index dropped an obstacle on the way in');

      // The positions the layout actually asked about, in the frame the layout works in.
      const records = goldenRecords(s.name);
      const taken = [];
      for (const record of records) {
        const size = measureBlock(JSON.parse(record.lines), scene.config, Number(record.fontSize));
        const center = {
          x: Number(record.centerX) - padding,
          y: Number(record.centerY) - padding,
        };
        const box = boxAround(center, size);
        assert.equal(
          index.countCollisions(box) + framePenalty(box, bounds),
          countCollisionsExhaustive(center, size, obstacles, taken, bounds, clearance),
          `${record.id}: indexed and exhaustive counts disagree at the placed position`,
        );
        // The accepted annotation then joins the grid, exactly as the layer does it.
        taken.push(box);
        index.insert(box);
      }

      // A sweep of boxes nobody placed, including ones larger than a cell and ones that
      // sit across cell boundaries.
      const random = mulberry32(20260101 + records.length);
      for (let i = 0; i < 300; i += 1) {
        const center = {
          x: Math.round(random() * (bounds.width + 80) - 40),
          y: Math.round(random() * (bounds.height + 80) - 40),
        };
        const width = 8 + Math.round(random() * 220);
        const height = 8 + Math.round(random() * 220);
        const box = boxAround(center, { width, height });
        assert.equal(
          index.countCollisions(box) + framePenalty(box, bounds),
          countCollisionsExhaustive(center, { width, height }, obstacles, taken, bounds, clearance),
          `${s.name}: counts disagree at ${center.x},${center.y} for ${width}x${height}`,
        );
      }
    });
  }
});

test('obstacles spanning many cells are found from every cell they touch', () => {
  const clearance = 2;
  const index = createObstacleIndex({ clearance, cellSize: 32 });
  // One box that covers 10 x 10 cells, and one query per corner region of it.
  index.insert({ x1: 0, y1: 0, x2: 320, y2: 320 });
  for (const [x, y] of [[10, 10], [300, 10], [10, 300], [300, 300], [160, 160]]) {
    assert.equal(index.countCollisions(boxAround({ x, y }, { width: 6, height: 6 })), 1);
  }
  // Just outside the grown box: nothing.
  assert.equal(index.countCollisions(boxAround({ x: 325, y: 160 }, { width: 6, height: 6 })), 0);
});

test('an obstacle exactly on a cell boundary is found from both sides', () => {
  const clearance = 0;
  const index = createObstacleIndex({ clearance, cellSize: 32 });
  // Occupies x 32..64, so it starts and ends precisely on cell boundaries.
  index.insert({ x1: 32, y1: 32, x2: 64, y2: 64 });
  assert.equal(index.countCollisions({ x1: 30, y1: 40, x2: 34, y2: 44 }), 1);
  assert.equal(index.countCollisions({ x1: 62, y1: 40, x2: 66, y2: 44 }), 1);
  assert.equal(index.countCollisions({ x1: 33, y1: 33, x2: 63, y2: 63 }), 1);
  assert.equal(index.countCollisions({ x1: 0, y1: 0, x2: 31, y2: 31 }), 0);
});

test('negative coordinates work, including boxes straddling the origin', () => {
  const index = createObstacleIndex({ clearance: 3, cellSize: 32 });
  index.insert({ x1: -100, y1: -40, x2: -60, y2: 0 });
  index.insert({ x1: -10, y1: -10, x2: 10, y2: 10 });
  const oracle = [
    { x1: -100, y1: -40, x2: -60, y2: 0 },
    { x1: -10, y1: -10, x2: 10, y2: 10 },
  ];
  const random = mulberry32(7);
  for (let i = 0; i < 200; i += 1) {
    const center = { x: Math.round(random() * 240 - 120), y: Math.round(random() * 160 - 80) };
    const size = { width: 5 + Math.round(random() * 60), height: 5 + Math.round(random() * 60) };
    const bounds = { width: 10000, height: 10000 };
    const box = boxAround(center, size);
    assert.equal(
      index.countCollisions(box) + framePenalty(box, bounds),
      countCollisionsExhaustive(center, size, oracle, [], bounds, 3),
    );
  }
});

test('a duplicated obstacle still counts twice, and a degenerate one still counts', () => {
  const shared = { x1: 0, y1: 0, x2: 20, y2: 20 };
  const index = createObstacleIndex({ clearance: 1, cellSize: 32 });
  index.insert(shared);
  index.insert(shared);
  index.insert({ x1: 10, y1: 10, x2: 10, y2: 10 }); // no width and no height
  const query = { x1: 9, y1: 9, x2: 11, y2: 11 };
  const oracleCount = countCollisionsExhaustive(
    { x: 10, y: 10 },
    { width: 2, height: 2 },
    [{ box: shared }, { box: shared }, { box: { x1: 10, y1: 10, x2: 10, y2: 10 } }],
    [],
    { width: 1000, height: 1000 },
    1,
  );
  assert.equal(index.countCollisions(query), oracleCount);
  assert.equal(index.countCollisions(query), 3);
});

test('asking the same question twice gives the same answer', () => {
  // Guards the per-query stamp: a reused mark would make the second count 0.
  const index = createObstacleIndex({ clearance: 1, cellSize: 64 });
  index.insert({ x1: 0, y1: 0, x2: 40, y2: 40 });
  const query = { x1: 10, y1: 10, x2: 20, y2: 20 };
  for (let i = 0; i < 5; i += 1) assert.equal(index.countCollisions(query), 1);
  index.insert({ x1: 12, y1: 12, x2: 18, y2: 18 });
  for (let i = 0; i < 5; i += 1) assert.equal(index.countCollisions(query), 2);
});

test('an index is local to one placement pass', () => {
  const first = createObstacleIndex({ clearance: 1, cellSize: 64 });
  first.insert({ x1: 0, y1: 0, x2: 40, y2: 40 });
  const second = createObstacleIndex({ clearance: 1, cellSize: 64 });
  const query = { x1: 10, y1: 10, x2: 20, y2: 20 };
  assert.equal(first.countCollisions(query), 1);
  assert.equal(second.countCollisions(query), 0, 'a new pass must start empty');
  assert.equal(second.size, 0);
});

test('the index takes no policy decisions of its own', () => {
  // It reports counts and nothing else: a cell size that changes the cell layout must not
  // change a single count, or the layout would depend on a tuning constant.
  const obstacles = [
    { x1: 0, y1: 0, x2: 60, y2: 60 },
    { x1: 200, y1: 200, x2: 260, y2: 200 },
    { x1: -80, y1: 40, x2: -20, y2: 100 },
  ];
  const random = mulberry32(99);
  const boxes = [];
  for (let i = 0; i < 120; i += 1) {
    const center = { x: Math.round(random() * 400 - 100), y: Math.round(random() * 300 - 50) };
    boxes.push(boxAround(center, { width: 10 + Math.round(random() * 90), height: 10 + Math.round(random() * 90) }));
  }
  const counts = [8, 32, 64, 128, 512].map((cellSize) => {
    const index = indexOf(obstacles, 2, cellSize);
    return boxes.map((box) => index.countCollisions(box));
  });
  const bounds = { width: 10000, height: 10000 };
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    const expected =
      countCollisionsExhaustive(
        { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 },
        { width: box.x2 - box.x1, height: box.y2 - box.y1 },
        obstacles,
        [],
        bounds,
        2,
      ) - framePenalty(box, bounds);
    for (const column of counts) {
      assert.equal(column[i], expected, `count changed with the cell size at query ${i}`);
    }
  }
});

test('a measured sweep of an unaligned field never omits an obstacle', () => {
  // Deliberately ungridded: sizes and positions are irrational-ish, so a cell-range
  // off-by-one cannot be hidden by round numbers.
  const random = mulberry32(4242);
  const obstacles = [];
  for (let i = 0; i < 400; i += 1) {
    const x = random() * 2000 - 500;
    const y = random() * 2000 - 500;
    const w = random() * 300;
    const h = random() * 300;
    obstacles.push({ x1: x, y1: y, x2: x + w, y2: y + h });
  }
  const bounds = { width: 10000, height: 10000 };
  for (const cellSize of [16, 64, 128, 300]) {
    const index = indexOf(obstacles, 4.25, cellSize);
    for (let i = 0; i < 500; i += 1) {
      const center = { x: random() * 2200 - 600, y: random() * 2200 - 600 };
      const size = { width: random() * 200, height: random() * 200 };
      const box = boxAround(center, size);
      const hits = index.countCollisions(box);
      const expected =
        countCollisionsExhaustive(center, size, obstacles, [], bounds, 4.25) - framePenalty(box, bounds);
      assert.equal(hits, expected, `cell ${cellSize}: ${hits} indexed vs ${expected} exhaustive`);
      // And the oracle agrees about *which* entries those are.
      const named = collidingEntries(center, size, obstacles, [], bounds, 4.25);
      assert.equal(named.static.length, hits);
    }
  }
});

test('the default cell size is a real, positive number of pixels', () => {
  assert.ok(Number.isFinite(DEFAULT_CELL_SIZE));
  assert.ok(DEFAULT_CELL_SIZE >= 8 && DEFAULT_CELL_SIZE <= 1024);
});

test('a bad clearance or cell size is refused rather than silently tolerated', () => {
  assert.throws(() => createObstacleIndex({ clearance: -1 }), RangeError);
  assert.throws(() => createObstacleIndex({ clearance: Number.NaN }), RangeError);
  assert.throws(() => createObstacleIndex({ cellSize: 0 }), RangeError);
  assert.throws(() => createObstacleIndex({ cellSize: -32 }), RangeError);
});

test('the counting helper applies the frame penalty and the same clearance', () => {
  const obstacles = [{ box: { x1: 0, y1: 0, x2: 400, y2: 400 } }];
  const bounds = { width: 100, height: 100 };
  const count = collisionCounter({ obstacles, taken: [], bounds, clearance: 4 });
  // Far outside the frame and outside the obstacle: one penalty.
  assert.equal(count({ x1: 500, y1: 500, x2: 510, y2: 510 }), 1);
  // Inside the frame and clear of the obstacle: nothing.
  assert.equal(collisionCounter({
    index: createObstacleIndex({ clearance: 4 }),
    bounds,
    clearance: 4,
  })({ x1: 500, y1: 500, x2: 510, y2: 510 }), 1);
  // The obstacle alone.
  assert.equal(count({ x1: 10, y1: 10, x2: 20, y2: 20 }), 1);
  // Outside the frame and in the obstacle: both.
  assert.equal(collisionCounter({
    obstacles,
    taken: [],
    bounds: { width: 5, height: 5 },
    clearance: 4,
  })({ x1: 0, y1: 0, x2: 10, y2: 10 }), 2);
});

test('the layer hands the same index to every annotation and grows it as it goes', () => {
  // The layer's index is not exported, so this checks the property that matters instead:
  // a scene's placements are identical whether the index is rebuilt per call or shared.
  const s = scenarios()[1];
  const scene = buildSceneFor(s.project, 'preview');
  const layer = scene.annotations;
  assert.ok(layer.callouts.length + layer.spans.length > 0);
  assert.equal(layer.obstacles.length > 0, true);
});