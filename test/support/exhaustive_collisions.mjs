/**
 * The pre-optimization collision count, kept as a test-only oracle.
 *
 * TEST SUPPORT ONLY. Nothing under `src/` imports this file.
 *
 * F13 replaced the exhaustive scan in `src/geometry/annotations.js` with a broad-phase
 * spatial index. A broad phase is exactly the kind of change that fails quietly: it
 * never throws, it never crashes, it just misses one obstacle out of a thousand and
 * moves a label. So the scan it replaced is preserved here, verbatim in behaviour, and
 * every equivalence test compares the indexed answer against this one.
 *
 * The geometry primitives are **imported from production**, not copied: `boxAround` and
 * `annotateCollides` are the authoritative definitions of "what a box is" and "what a
 * clash is". Only the loop - which entries get asked - is duplicated, because that loop
 * is the thing under test. If the oracle's geometry drifted from production, the replay
 * test in `test/placement_characterization.test.js` would catch it: it re-derives the
 * collision count of every annotation that production actually placed.
 */

import { boxAround } from '../../src/geometry/annotations.js';
import { annotateCollides } from '../../src/geometry/collide.js';

/**
 * Count clashes for one candidate the way the exhaustive scan did.
 *
 * @param {object} center Candidate centre.
 * @param {object} size Candidate size `{width, height}`.
 * @param {Array<{box: object}|object>} obstacles Static obstacles.
 * @param {Array<object>} taken Boxes already claimed by placed annotations.
 * @param {{width: number, height: number}} bounds Frame the candidate must stay inside.
 * @param {number} clearance Required clear space.
 * @returns {number} Collision count, with one added when the box leaves the frame.
 */
export function countCollisionsExhaustive(center, size, obstacles, taken, bounds, clearance) {
  const box = boxAround(center, size);
  let count = 0;
  for (const obstacle of obstacles) {
    if (annotateCollides(box, obstacle.box ?? obstacle, clearance)) count += 1;
  }
  for (const other of taken) {
    if (annotateCollides(box, other, clearance)) count += 1;
  }
  if (box.x1 < 0 || box.y1 < 0 || box.x2 > bounds.width || box.y2 > bounds.height) {
    count += 1;
  }
  return count;
}

/**
 * Which entries the exhaustive scan considers a clash, named by index.
 *
 * A count alone says "one obstacle was missed"; this says *which*, which is what a
 * failing equivalence test needs in order to name the offending candidate.
 *
 * @param {object} center Candidate centre.
 * @param {object} size Candidate size `{width, height}`.
 * @param {Array<{box: object}|object>} obstacles Static obstacles.
 * @param {Array<object>} taken Boxes already claimed by placed annotations.
 * @param {{width: number, height: number}} bounds Frame the candidate must stay inside.
 * @param {number} clearance Required clear space.
 * @returns {{static: number[], taken: number[], outOfBounds: boolean}} Clashing entries.
 */
export function collidingEntries(center, size, obstacles, taken, bounds, clearance) {
  const box = boxAround(center, size);
  const staticHits = [];
  const takenHits = [];
  obstacles.forEach((obstacle, index) => {
    if (annotateCollides(box, obstacle.box ?? obstacle, clearance)) staticHits.push(index);
  });
  taken.forEach((other, index) => {
    if (annotateCollides(box, other, clearance)) takenHits.push(index);
  });
  const outOfBounds =
    box.x1 < 0 || box.y1 < 0 || box.x2 > bounds.width || box.y2 > bounds.height;
  return { static: staticHits, taken: takenHits, outOfBounds };
}
