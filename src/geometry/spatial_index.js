/**
 * A per-scene broad phase for annotation collision counting.
 *
 * Finding F13: the layout pass used to ask every candidate position "does this clash with
 * any obstacle?" by walking the whole obstacle list and the whole list of labels already
 * placed. With *n* annotations that is `n x candidates x (obstacles + taken)`, which is why
 * placement grew roughly 3.5x per doubling of the drawing
 * ([performance baseline §7](../documentation/11-performance-baseline.md#7-what-dominates-and-how-it-grows)).
 *
 * The fix is not a different collision rule. It is a cheaper way to ask the *same*
 * question. This module is that cheaper way and nothing else:
 *
 *   - **broad phase** here: a uniform grid of square cells, each holding the entries whose
 *     box - grown by the required clearance - touches it. A query visits only the cells its
 *     own grown box touches, so it looks at a handful of entries instead of all of them;
 *   - **narrow phase** in `./collide.js`: `annotateCollides`, unchanged and still the only
 *     thing that decides whether a hit is real.
 *
 * The grid may return entries that do not actually clash (a cell is coarser than a box);
 * it must never omit one that does. That direction of error is safe, because the exact
 * test follows immediately. The task is to prove it, not to assume it - see
 * `test/spatial_index.test.js` and `test/placement_characterization.test.js`.
 *
 * **Counting, not ordering.** The layout compares collision *counts*, so the result is a
 * number and the order entries are found in cannot change any decision. That is what makes
 * a grid safe here where it would not be safe for a "first clash wins" rule: no sort, no
 * iteration order, no tie-break depends on this module. Entries are visited in insertion
 * order within a cell and each entry is counted at most once per query (via a stamp), so a
 * box registered in four cells still counts once. A duplicated obstacle is still two
 * entries and therefore still counts twice.
 *
 * **One index per placement pass.** `buildAnnotationLayer()` creates it, seeds it with the
 * scene's static obstacles, and adds each annotation's claimed box the moment that
 * annotation is accepted. Nothing is module-level, so two drawings cannot contaminate each
 * other and a reload starts clean.
 *
 * **Why a uniform grid and not a tree.** The obstacles are markers, labels and short line
 * segments spread over an absurdly tall, narrow drawing (the 501-span dataset is 72 x 20112
 * px). A tree buys nothing there: one column of cells already cuts the candidate set by the
 * row count, insertion is O(1), and there is no rebalancing to make placement depend on
 * insertion history.
 */

import { annotateCollides } from './collide.js';

/**
 * Default cell size, in px.
 *
 * Measured, not guessed: on the four baseline drawings a 128 px cell is the flattest
 * choice across all of them, and larger cells lose the benefit while smaller ones spend
 * more time on bookkeeping than they save. The measurement is in
 * `documentation/12-annotation-placement.md`.
 */
export const DEFAULT_CELL_SIZE = 128;

/** The cells a box touches, as inclusive ranges. */
function cellRange(box, cellSize) {
  return {
    minX: Math.floor(box.x1 / cellSize),
    maxX: Math.floor(box.x2 / cellSize),
    minY: Math.floor(box.y1 / cellSize),
    maxY: Math.floor(box.y2 / cellSize),
  };
}

/** Grow a box by the clearance, the same way `annotateCollides` compares them. */
function grown(box, clearance) {
  return {
    x1: box.x1 - clearance,
    y1: box.y1 - clearance,
    x2: box.x2 + clearance,
    y2: box.y2 + clearance,
  };
}

/**
 * Build an empty index.
 *
 * @param {object} [options]
 * @param {number} [options.clearance] Required clear space, in px. Must match the value the
 *   exact test uses, or the grid would be built for one rule and asked about another.
 * @param {number} [options.cellSize] Cell size, in px.
 * @returns {{insert: Function, countCollisions: Function, has: Function, size: number, cellCount: number}}
 */
export function createObstacleIndex(options = {}) {
  const clearance = Number(options.clearance ?? 0);
  const cellSize = Number(options.cellSize ?? DEFAULT_CELL_SIZE);
  if (!Number.isFinite(clearance) || clearance < 0) {
    throw new RangeError(`createObstacleIndex: clearance must be a finite number >= 0, got ${clearance}`);
  }
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    throw new RangeError(`createObstacleIndex: cellSize must be a finite number > 0, got ${cellSize}`);
  }

  /** Every registered box, in insertion order. Its index is its identity. */
  const boxes = [];
  /** Per-entry query stamp, so one query counts an entry once however many cells it is in. */
  const stamps = [];
  /** Cell key -> entry indices, in insertion order. */
  const cells = new Map();
  let queryStamp = 0;

  const key = (cx, cy) => `${cx},${cy}`;

  /**
   * Register one obstacle.
   *
   * @param {{x1: number, y1: number, x2: number, y2: number}} box Box to register.
   * @returns {number} The entry's index, which is what a diagnostic can name.
   */
  function insert(box) {
    if (!box) throw new TypeError('createObstacleIndex.insert: a box is required');
    const index = boxes.length;
    boxes.push(box);
    stamps.push(0);
    const range = cellRange(grown(box, clearance), cellSize);
    for (let cx = range.minX; cx <= range.maxX; cx += 1) {
      for (let cy = range.minY; cy <= range.maxY; cy += 1) {
        const k = key(cx, cy);
        const bucket = cells.get(k);
        if (bucket) bucket.push(index);
        else cells.set(k, [index]);
      }
    }
    return index;
  }

  /**
   * Count the entries this box clashes with, exactly as the exhaustive scan did.
   *
   * @param {{x1: number, y1: number, x2: number, y2: number}} box Candidate box.
   * @returns {number} Number of clashing entries. Never fewer than the exhaustive scan.
   */
  function countCollisions(box) {
    queryStamp += 1;
    const stamp = queryStamp;
    let count = 0;
    const range = cellRange(grown(box, clearance), cellSize);
    for (let cx = range.minX; cx <= range.maxX; cx += 1) {
      for (let cy = range.minY; cy <= range.maxY; cy += 1) {
        const bucket = cells.get(key(cx, cy));
        if (!bucket) continue;
        for (const index of bucket) {
          if (stamps[index] === stamp) continue;
          stamps[index] = stamp;
          // The grid only proposed this entry; the exact rule decides.
          if (annotateCollides(box, boxes[index], clearance)) count += 1;
        }
      }
    }
    return count;
  }

  /**
   * Is this exact box registered? Used by tests and by the layer's own guard against
   * registering an annotation twice.
   *
   * @param {object} box Box to look for, by identity.
   * @returns {boolean} True when that object is registered.
   */
  function has(box) {
    return boxes.includes(box);
  }

  return {
    insert,
    countCollisions,
    has,
    get size() {
      return boxes.length;
    },
    get cellCount() {
      return cells.size;
    },
  };
}

/**
 * The count the layout pass compares, for one placement pass.
 *
 * This is the whole question - "how bad is this candidate?" - in one place: a count of
 * clashing entries from the index, plus one when the box leaves the frame. The frame is not
 * an obstacle, so it is not in the index; it is the sheet edge, and a candidate that would
 * be clipped has to lose to one that fits.
 *
 * The layer passes the shared index so the grid is built once per scene. A direct call to
 * `placeCallout()` / `placeSpanLabel()` - which the unit tests do - can pass raw lists
 * instead and gets the same rule with a grid built from them. There is deliberately no
 * second, exhaustive path in production: one implementation, one behaviour.
 *
 * @param {object} input
 * @param {object} [input.index] Shared index for this pass.
 * @param {Array<object>} [input.obstacles] Static obstacles, used when no index is given.
 * @param {Array<object>} [input.taken] Boxes already claimed, used when no index is given.
 * @param {{width: number, height: number}} input.bounds Frame the candidate must stay inside.
 * @param {number} input.clearance Required clear space.
 * @returns {(box: object) => number} Count function.
 */
export function collisionCounter(input) {
  const { index, obstacles = [], taken = [], bounds, clearance } = input;
  const countOf = index
    ? (box) => index.countCollisions(box)
    : (() => {
        const local = createObstacleIndex({ clearance });
        for (const obstacle of obstacles) local.insert(obstacle.box ?? obstacle);
        for (const other of taken) local.insert(other);
        return (box) => local.countCollisions(box);
      })();
  return (box) => {
    let count = countOf(box);
    if (box.x1 < 0 || box.y1 < 0 || box.x2 > bounds.width || box.y2 > bounds.height) {
      count += 1;
    }
    return count;
  };
}
