/**
 * Example configuration loader.
 *
 * The example routes are written the way a person reads the reference drawing
 * ("A", "B", "TC"), because that is how they are authored and reviewed. The
 * application, however, identifies endpoints by internal id. This module
 * converts an authored example into instructions that reference internal ids,
 * by replaying the same sequential rules the geometry engine uses.
 *
 * Resolving here rather than inside the geometry engine keeps the engine free
 * of any notion of display names as identity, and keeps the example readable.
 */

import { buildNetwork } from '../geometry/network.js';
import { normalizeDirection } from '../geometry/direction.js';

/**
 * Resolve one authored source reference to its internal endpoint id.
 *
 * Accepts an internal id directly (origin, endpoint:A, tc:1). Otherwise treats
 * the reference as a display name and looks it up among the endpoints created
 * by the routes preceding this row.
 *
 * @param {Array<object>} resolvedSoFar Routes already resolved to internal ids.
 * @param {string} ref Authored reference.
 * @returns {string|null} Internal id, or null when it cannot be resolved.
 */
function resolveReference(resolvedSoFar, ref) {
  if (ref === null || ref === undefined) return null;
  const text = String(ref).trim();
  if (text.toLowerCase() === 'origin') return 'origin';
  if (/^endpoint:[A-Z]+$/i.test(text) || /^tc:\d+$/i.test(text)) return text;

  const network = buildNetwork(resolvedSoFar);
  const wanted = text.toLowerCase();
  const match = network.endpoints.find((endpoint) => {
    if (endpoint.kind === 'origin') return wanted === 'origin';
    if (endpoint.kind === 'tc') {
      return (endpoint.displayName ?? endpoint.name).toLowerCase() === wanted;
    }
    return (endpoint.displayName ?? endpoint.name).toLowerCase() === wanted;
  });
  return match ? match.id : null;
}

/**
 * Convert authored example routes into instructions that use internal ids.
 *
 * A row whose reference cannot be resolved is kept with its original text so
 * that the application reports it as a real validation error instead of
 * silently dropping it.
 *
 * @param {Array<object>} authored Example routes with display-name references.
 * @param {Function} makeId Factory producing a unique instruction id.
 * @returns {Array<object>} Instruction list.
 */
export function resolveExampleRoutes(authored, makeId) {
  const resolved = [];
  return authored.map((route) => {
    const from = resolveReference(resolved, route.from) ?? String(route.from ?? '');
    const instruction = {
      id: makeId(),
      from,
      direction: normalizeDirection(route.direction) ?? route.direction,
      spans: route.spans,
      tc: Boolean(route.tc),
    };
    resolved.push(instruction);
    return instruction;
  });
}
