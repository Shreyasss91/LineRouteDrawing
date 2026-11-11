/**
 * Direction and coordinate helpers.
 *
 * The coordinate convention is fixed and global:
 *   Origin = (0, 0)
 *   North = +Y, South = -Y, East = +X, West = -X
 * One span equals one integer grid unit.
 */

import { DIRECTIONS, DIRECTION_ALIASES } from '../config.js';

/**
 * Normalize a user-supplied direction to its canonical key.
 *
 * @param {unknown} value Raw direction input.
 * @returns {string|null} `north`, `south`, `east`, `west`, or null when invalid.
 */
export function normalizeDirection(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (key in DIRECTIONS) return key;
  return DIRECTION_ALIASES[key] ?? null;
}

/**
 * Return the unit vector for a direction.
 *
 * @param {string} direction Canonical direction key.
 * @returns {{dx: number, dy: number}}
 */
export function directionVector(direction) {
  const normalized = normalizeDirection(direction);
  if (!normalized) {
    throw new RangeError(`Unknown direction: ${String(direction)}`);
  }
  const { dx, dy } = DIRECTIONS[normalized];
  return { dx, dy };
}

/**
 * Apply one span of a direction to a coordinate.
 *
 * @param {{x: number, y: number}} position Source coordinate.
 * @param {string} direction Canonical direction key.
 * @param {number} [spans=1] Number of spans to advance.
 * @returns {{x: number, y: number}} New coordinate (a new object).
 */
export function advance(position, direction, spans = 1) {
  const { dx, dy } = directionVector(direction);
  return { x: position.x + dx * spans, y: position.y + dy * spans };
}

/**
 * Stable string key for a coordinate, used as a canonical map key.
 *
 * @param {{x: number, y: number}} position Coordinate.
 * @returns {string} e.g. `"3,-2"`.
 */
export function coordKey(position) {
  return `${position.x},${position.y}`;
}

/**
 * Compare two coordinates for equality.
 *
 * @param {{x: number, y: number}} a First coordinate.
 * @param {{x: number, y: number}} b Second coordinate.
 * @returns {boolean}
 */
export function sameCoord(a, b) {
  return a.x === b.x && a.y === b.y;
}
