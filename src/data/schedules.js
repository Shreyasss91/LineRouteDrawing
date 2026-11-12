/**
 * Load and span-length schedules: the measured data attached to the drawing.
 *
 * Two separate datasets, because they answer two different questions:
 *
 *   loads        "what is connected at this pole?"       owned by a node asset
 *   spanLengths  "how long is the cable on this span?"   owned by a span asset
 *
 * Both are keyed by the immutable asset ids from `assets.js`. Neither is ever
 * keyed by a label, a route row or a coordinate, so an edit to the route list
 * cannot move a load onto a different pole.
 *
 * The one rule that runs through this whole module: nothing here ever converts,
 * sums or merges. Four load units coexist on one pole as four records. `HP` is
 * not turned into `kW`, because a horsepower rating and a kVA rating are not the
 * same quantity and the tool has no conversion policy to justify the arithmetic.
 * The user gets their numbers back exactly as they typed them.
 */

/** Units a load may be recorded in. */
export const LOAD_UNITS = Object.freeze(['kVA', 'kW', 'kVAr', 'HP']);

/** Unit a new load record starts with. */
export const DEFAULT_LOAD_UNIT = 'kVA';

/** The unit a span length is always shown in. */
export const SPAN_UNIT = 'm';

/**
 * Why loads are only allowed on some node types.
 *
 * A TC point is a test point, not a load-bearing asset, and a load on one would
 * be drawn over the triangle. Keeping it out of scope means the schedule and the
 * drawing cannot disagree about where a load belongs.
 */
export const LOAD_ELIGIBLE_TYPES = Object.freeze(['pole', 'fpb', 'origin']);

/**
 * Whether loads may be recorded on a node of this type.
 *
 * @param {string} nodeType One of `pole`, `fpb`, `tc`, `origin`.
 * @returns {boolean}
 */
export function isLoadEligible(nodeType) {
  if (nodeType === 'tc') return false;
  return LOAD_ELIGIBLE_TYPES.includes(nodeType);
}

/** Counter behind generated ids. Restored ids raise it, in `reserveLoadId`. */
let loadCounter = 0;
/** Ids produced by `nextLoadId`, so a reassignment cannot collide with one. */
const usedLoadIds = new Set();

/**
 * A fresh, immutable load id.
 *
 * Not derived from the node it belongs to: that would make the id change when a
 * load is reassigned, and ids are the one thing that must not drift.
 *
 * @returns {string} e.g. `load-7`.
 */
export function nextLoadId() {
  loadCounter += 1;
  let id = `load-${loadCounter}`;
  while (usedLoadIds.has(id)) {
    loadCounter += 1;
    id = `load-${loadCounter}`;
  }
  usedLoadIds.add(id);
  return id;
}

/**
 * Raise the counter past an id that came from a saved project.
 *
 * A project saved with `load-12` and reopened in a fresh page would otherwise
 * hand the next new load `load-1`, while `load-12` is in the table. Both are
 * unique, so nothing breaks immediately, but the numbers stop meaning anything
 * and a later import by id could collide. One id space avoids that.
 *
 * @param {string} id Restored id.
 * @returns {string} The same id.
 */
export function reserveLoadId(id) {
  usedLoadIds.add(id);
  const match = /^load-(\d+)$/.exec(String(id ?? ''));
  if (match) {
    const n = Number(match[1]);
    if (n > loadCounter) loadCounter = n;
  }
  return id;
}

/**
 * Parse a load value.
 *
 * Positive and finite only. Zero is refused rather than treated as empty: a
 * recorded zero says "nothing here", which is what leaving the record out means,
 * so accepting it would let the schedule contain a meaningless row.
 *
 * @param {unknown} raw Raw input.
 * @returns {{ok: true, value: number} | {ok: false, message: string}}
 */
export function parseLoadValue(raw) {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (text === '' || text === null || text === undefined) {
    return { ok: false, message: 'Enter a load value.' };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { ok: false, message: 'A load value must be a number.' };
  }
  if (value <= 0) {
    return { ok: false, message: 'A load value must be greater than zero.' };
  }
  return { ok: true, value };
}

/**
 * Parse a span length in metres.
 *
 * Same rules as a load: positive and finite. Decimals are expected - a measured
 * span is rarely a whole number - so no rounding is applied.
 *
 * @param {unknown} raw Raw input.
 * @returns {{ok: true, value: number} | {ok: false, message: string}}
 */
export function parseSpanLength(raw) {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (text === '' || text === null || text === undefined) {
    return { ok: false, message: 'Enter a length in metres.' };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { ok: false, message: 'A span length must be a number.' };
  }
  if (value <= 0) {
    return { ok: false, message: 'A span length must be greater than zero.' };
  }
  return { ok: true, value };
}

/**
 * Normalize a unit to its canonical spelling.
 *
 * @param {unknown} raw Raw unit.
 * @returns {string|null} One of `LOAD_UNITS`, or null when not a unit.
 */
export function normalizeUnit(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const found = LOAD_UNITS.find((unit) => unit.toLowerCase() === text.toLowerCase());
  return found ?? null;
}

/** Format a load value for display: at most two decimals, no trailing zeros. */
export function formatLoadValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 1000) / 1000);
}

/** Format a span length for display, always with the metre unit. */
export function formatSpanLength(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return `— ${SPAN_UNIT}`;
  return `${formatLoadValue(Number(value))} ${SPAN_UNIT}`;
}

/* ------------------------------------------------------------------ */
/* Load schedule                                                       */
/* ------------------------------------------------------------------ */

/**
 * The empty load dataset.
 *
 * A list of records rather than a map: several records share one node, and the
 * order the user entered them is the order they are drawn in.
 *
 * @returns {Array<object>} Empty list.
 */
export function createLoadSchedule() {
  return [];
}

/**
 * Every load recorded on one node, in entry order.
 *
 * @param {Array<object>} loads Load records.
 * @param {string} nodeId Node asset id.
 * @returns {Array<object>} Records belonging to that node.
 */
export function loadsForNode(loads, nodeId) {
  return (loads ?? []).filter((load) => load.nodeId === nodeId);
}

/**
 * Insert a load record without checking what kind of point it targets.
 *
 * **Trusted callers only.** This is the primitive behind `addLoad()`, separated out so
 * the eligibility rule has exactly one place to be enforced instead of several
 * near-copies. It exists for two situations: `addLoad()` itself, after it has resolved
 * and approved the target, and restoring a record that is already known to be valid.
 *
 * It is deliberately named so that calling it is a visible decision. Nothing that a
 * user's action can reach should call it directly - use `addLoad()`, which fails closed.
 *
 * @param {Array<object>} loads Current records.
 * @param {object} input
 * @param {string} input.nodeId Node asset id, already validated.
 * @param {unknown} input.value Numeric value.
 * @param {unknown} [input.unit] Unit, defaults to kVA.
 * @param {string} [input.id] Explicit id, for a restored record.
 * @returns {{ok: true, loads: Array<object>, record: object}
 *   | {ok: false, message: string}}
 */
export function insertLoadRecord(loads, input = {}) {
  const nodeId = input.nodeId;
  if (!isAssetIdLike(nodeId)) {
    return { ok: false, message: 'A load must belong to a point.' };
  }
  const parsed = parseLoadValue(input.value);
  if (!parsed.ok) return { ok: false, message: parsed.message };

  const unit = input.unit === undefined ? DEFAULT_LOAD_UNIT : normalizeUnit(input.unit);
  if (!unit) {
    return { ok: false, message: `A load unit must be one of ${LOAD_UNITS.join(', ')}.` };
  }

  const record = {
    id: input.id ? reserveLoadId(String(input.id)) : nextLoadId(),
    nodeId,
    value: parsed.value,
    unit,
  };
  return { ok: true, loads: [...loads, record], record };
}

/**
 * Add a load record to a point, refusing any point that cannot carry one.
 *
 * Returns a new list; the input is never mutated, so a caller can stage an edit and
 * discard it without having to undo anything.
 *
 * **This operation fails closed.** A TC point is not a load-bearing asset, so the
 * target's type has to be known before a load can be recorded, and the caller supplies
 * that knowledge as `lookupNode`. The check is mandatory rather than optional: if the
 * resolver is missing, or it cannot resolve the id, no load is created. An optional
 * check is not a guarantee - a caller that forgot the resolver would silently be allowed
 * to put a load on a TC point, which is the defect this function exists to prevent.
 *
 * The resolver is injected rather than imported so this module keeps no dependency on
 * the geometry layer (see the dependency rules in `documentation/03-architecture.md`).
 *
 * Errors are distinguished, because the three failures need different responses:
 *
 *   `MISSING_NODE_RESOLVER`  a programming error - the caller must pass a resolver
 *   `UNRESOLVED_LOAD_TARGET` the id names no point in this drawing
 *   `INELIGIBLE_LOAD_TARGET` the point exists but cannot carry a load
 *
 * @param {Array<object>} loads Current records.
 * @param {object} input
 * @param {string} input.nodeId Node asset id.
 * @param {unknown} input.value Numeric value.
 * @param {unknown} [input.unit] Unit, defaults to kVA.
 * @param {string} [input.id] Explicit id, for a restored record.
 * @param {(nodeId: string) => ({nodeType?: string} | null)} input.lookupNode
 *   Resolve an asset id to its node. Required: a load cannot be created without it.
 * @returns {{ok: true, loads: Array<object>, record: object}
 *   | {ok: false, code: string, message: string}}
 */
export function addLoad(loads, input = {}) {
  const nodeId = input.nodeId;
  if (!isAssetIdLike(nodeId)) {
    return { ok: false, code: 'UNRESOLVED_LOAD_TARGET', message: 'A load must belong to a point.' };
  }

  // Fail closed: without a way to resolve the point there is no way to know whether it
  // may carry a load, so nothing is created. This is a caller error, not user input.
  if (typeof input.lookupNode !== 'function') {
    return {
      ok: false,
      code: 'MISSING_NODE_RESOLVER',
      message:
        'A load cannot be recorded without a way to look up its point. ' +
        'Pass `lookupNode` so the point type can be checked.',
    };
  }

  const target = input.lookupNode(nodeId);
  // Fail closed again: an id that resolves to nothing cannot be shown to be eligible.
  if (!target) {
    return {
      ok: false,
      code: 'UNRESOLVED_LOAD_TARGET',
      message: 'That point is not in this drawing, so a load cannot be recorded on it.',
    };
  }
  if (isLoadEligible(target.nodeType) === false) {
    return {
      ok: false,
      code: 'INELIGIBLE_LOAD_TARGET',
      message: `A load cannot be recorded on a ${target.nodeType} point. Choose a pole, an FPB or the Origin.`,
    };
  }

  return insertLoadRecord(loads, input);
}

/**
 * Replace one record's value and unit, addressed by its own id.
 *
 * The node it belongs to cannot be changed here: `nodeId` is deliberately not copied from
 * the patch, so an edit can never move a load between assets by accident and this
 * operation needs no eligibility check. Moving a load is `reassignLoad()`, which does.
 *
 * @param {Array<object>} loads Current records.
 * @param {string} id Load id.
 * @param {{value?: unknown, unit?: unknown}} patch Fields to change.
 * @returns {{ok: true, loads: Array<object>, record: object} | {ok: false, message: string}}
 */
export function updateLoad(loads, id, patch = {}) {
  const index = (loads ?? []).findIndex((load) => load.id === id);
  if (index < 0) return { ok: false, message: 'That load is no longer in the schedule.' };

  const next = { ...loads[index] };
  if (patch.value !== undefined) {
    const parsed = parseLoadValue(patch.value);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    next.value = parsed.value;
  }
  if (patch.unit !== undefined) {
    const unit = normalizeUnit(patch.unit);
    if (!unit) {
      return { ok: false, message: `A load unit must be one of ${LOAD_UNITS.join(', ')}.` };
    }
    next.unit = unit;
  }

  const updated = [...loads];
  updated[index] = next;
  return { ok: true, loads: updated, record: next };
}

/**
 * Reassign a load to a different node.
 *
 * Explicitly separate from `updateLoad` so that moving a load is always a
 * decision the user made, never a side effect of editing a value.
 *
 * **This operation fails closed**, on the same terms as `addLoad()`: moving a load is one
 * of the ways a load reaches a point, so leaving this unguarded made the eligibility rule
 * enforceable at creation and bypassable one step later. The error codes match `addLoad()`
 * so a caller can handle both with one branch, plus `UNKNOWN_LOAD` for a stale id.
 *
 * The resolver is injected rather than imported, so this module keeps no dependency on the
 * geometry layer (see the dependency rules in `documentation/03-architecture.md`).
 *
 * @param {Array<object>} loads Current records.
 * @param {string} id Load id.
 * @param {string} nodeId Destination node asset id.
 * @param {{lookupNode?: (nodeId: string) => ({nodeType?: string} | null)}} options
 *   Resolve an asset id to its node. Required: a target cannot be checked without it.
 * @returns {{ok: true, loads: Array<object>, record: object}
 *   | {ok: false, code: string, message: string}}
 */
export function reassignLoad(loads, id, nodeId, options = {}) {
  const index = (loads ?? []).findIndex((load) => load.id === id);
  if (index < 0) {
    return { ok: false, code: 'UNKNOWN_LOAD', message: 'That load is no longer in the schedule.' };
  }
  if (!isAssetIdLike(nodeId)) {
    return {
      ok: false,
      code: 'UNRESOLVED_LOAD_TARGET',
      message: 'Choose the point this load belongs to.',
    };
  }

  // Fail closed, exactly as `addLoad()` does. A caller that forgot the resolver has not
  // established that the target may carry a load, so nothing is moved.
  if (typeof options?.lookupNode !== 'function') {
    return {
      ok: false,
      code: 'MISSING_NODE_RESOLVER',
      message:
        'A load cannot be moved without a way to look up its point. ' +
        'Pass `lookupNode` so the point type can be checked.',
    };
  }

  const target = options.lookupNode(nodeId);
  if (!target) {
    return {
      ok: false,
      code: 'UNRESOLVED_LOAD_TARGET',
      message: 'That point is not in this drawing, so a load cannot be moved to it.',
    };
  }
  if (isLoadEligible(target.nodeType) === false) {
    return {
      ok: false,
      code: 'INELIGIBLE_LOAD_TARGET',
      message: `A load cannot be moved to a ${target.nodeType} point. Choose a pole, an FPB or the Origin.`,
    };
  }

  return insertReassignedLoad(loads, id, nodeId);
}

/**
 * Rename a load's target without checking eligibility.
 *
 * The unguarded primitive beneath `reassignLoad()`, named so that calling it is a visible
 * decision. It exists for restoring records whose targets were already validated, and it
 * must not be reached from a user action. Prefer `reassignLoad()`.
 *
 * @param {Array<object>} loads Current records.
 * @param {string} id Load id.
 * @param {string} nodeId Destination node asset id.
 * @returns {{ok: true, loads: Array<object>, record: object}
 *   | {ok: false, code: string, message: string}}
 */
export function insertReassignedLoad(loads, id, nodeId) {
  const index = (loads ?? []).findIndex((load) => load.id === id);
  if (index < 0) {
    return { ok: false, code: 'UNKNOWN_LOAD', message: 'That load is no longer in the schedule.' };
  }
  if (!isAssetIdLike(nodeId)) {
    return {
      ok: false,
      code: 'UNRESOLVED_LOAD_TARGET',
      message: 'Choose the point this load belongs to.',
    };
  }
  const updated = [...loads];
  // Only the target changes: the id, value and unit are carried over untouched.
  updated[index] = { ...updated[index], nodeId };
  return { ok: true, loads: updated, record: updated[index] };
}

/**
 * Remove one load record.
 *
 * @param {Array<object>} loads Current records.
 * @param {string} id Load id.
 * @returns {Array<object>} Records without it.
 */
export function removeLoad(loads, id) {
  return (loads ?? []).filter((load) => load.id !== id);
}

/** Remove every record belonging to a node, used when the user discards a node. */
export function removeLoadsForNode(loads, nodeId) {
  return (loads ?? []).filter((load) => load.nodeId !== nodeId);
}

/**
 * Group a node's loads into the lines its callout will show.
 *
 * One line per record, in entry order, formatted with its own unit. No total is
 * produced, because adding kVA to HP would be arithmetic on unlike quantities.
 *
 * @param {Array<object>} loads Load records.
 * @param {string} nodeId Node asset id.
 * @returns {Array<string>} e.g. `["25 kVA", "5 kW", "12 HP"]`.
 */
export function loadCalloutLines(loads, nodeId) {
  return loadsForNode(loads, nodeId).map(
    (load) => `${formatLoadValue(load.value)} ${load.unit}`,
  );
}

function isAssetIdLike(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/* ------------------------------------------------------------------ */
/* Span length schedule                                                */
/* ------------------------------------------------------------------ */

/**
 * The empty span length dataset.
 *
 * A map from span asset id to `{spanId, lengthM}`, because a span has at most
 * one measured length. The absence of a key is the explicit "not measured yet"
 * state: there is no null placeholder to mistake for a reading of zero.
 *
 * @returns {Map<string, object>} Empty map.
 */
export function createSpanLengths() {
  return new Map();
}

/**
 * Record one span's measured length.
 *
 * @param {Map<string, object>} spanLengths Current map.
 * @param {string} spanId Span asset id.
 * @param {unknown} rawLength Length in metres.
 * @returns {{ok: true, spanLengths: Map<string, object>} | {ok: false, message: string}}
 */
export function setSpanLength(spanLengths, spanId, rawLength) {
  if (!isAssetIdLike(spanId)) {
    return { ok: false, message: 'A length must belong to a span.' };
  }
  const parsed = parseSpanLength(rawLength);
  if (!parsed.ok) return { ok: false, message: parsed.message };

  const next = new Map(spanLengths);
  next.set(spanId, { spanId, lengthM: parsed.value });
  return { ok: true, spanLengths: next };
}

/**
 * Clear a span's measurement, returning it to the unmeasured state.
 *
 * An explicit action rather than a zero, so "we have not measured this" stays
 * distinguishable from "we measured it and it was nothing", which cannot happen
 * in a real span.
 *
 * @param {Map<string, object>} spanLengths Current map.
 * @param {string} spanId Span asset id.
 * @returns {Map<string, object>} Map without it.
 */
export function clearSpanLength(spanLengths, spanId) {
  const next = new Map(spanLengths);
  next.delete(spanId);
  return next;
}

/**
 * The measured length of a span, or null when unmeasured.
 *
 * @param {Map<string, object>} spanLengths Current map.
 * @param {string} spanId Span asset id.
 * @returns {number|null}
 */
export function spanLengthOf(spanLengths, spanId) {
  const record = spanLengths?.get?.(spanId);
  return record && Number.isFinite(record.lengthM) ? record.lengthM : null;
}

/**
 * Apply one length to every span that has no measurement yet.
 *
 * The only bulk operation in this module, and deliberately narrow: a span that
 * already carries a measurement is never overwritten, so a bulk apply cannot
 * destroy a survey that was entered by hand.
 *
 * @param {Map<string, object>} spanLengths Current map.
 * @param {Iterable<string>} spanIds Every span that should exist.
 * @param {unknown} rawLength Length in metres to apply.
 * @returns {{ok: true, spanLengths: Map<string, object>, updated: number, skipped: number}
 *   | {ok: false, message: string}} Result, with how many were filled and kept.
 */
export function applyDefaultLength(spanLengths, spanIds, rawLength) {
  const parsed = parseSpanLength(rawLength);
  if (!parsed.ok) return { ok: false, message: parsed.message };

  const next = new Map(spanLengths);
  let updated = 0;
  let skipped = 0;
  for (const spanId of spanIds) {
    if (next.has(spanId)) {
      skipped += 1;
      continue;
    }
    next.set(spanId, { spanId, lengthM: parsed.value });
    updated += 1;
  }
  return { ok: true, spanLengths: next, updated, skipped };
}

/**
 * How much of the survey is done.
 *
 * Reported wherever an export is offered, because a drawing that looks finished
 * while half its spans are unmeasured is the failure this exists to prevent.
 *
 * @param {Map<string, object>} spanLengths Current map.
 * @param {Iterable<string>} spanIds Every span that should exist.
 * @returns {{total: number, assigned: number, unassigned: number, complete: boolean}}
 */
export function measureCompleteness(spanLengths, spanIds) {
  const ids = [...spanIds];
  const assigned = ids.filter((id) => spanLengthOf(spanLengths, id) !== null).length;
  return {
    total: ids.length,
    assigned,
    unassigned: ids.length - assigned,
    complete: assigned === ids.length,
  };
}

/**
 * Keep only the measurements that belong to spans the drawing still has, and
 * report the ones that no longer do.
 *
 * Used when the route list changes. Measurements for a removed span are handed
 * back rather than dropped, so they can be offered for reassignment instead of
 * quietly disappearing.
 *
 * @param {Map<string, object>} spanLengths Current map.
 * @param {Iterable<string>} liveSpanIds Span ids the drawing now has.
 * @returns {{kept: Map<string, object>, unresolved: Array<object>}}
 */
export function splitUnresolved(spanLengths, liveSpanIds) {
  const live = liveSpanIds instanceof Set ? liveSpanIds : new Set(liveSpanIds);
  const kept = new Map();
  const unresolved = [];
  for (const [key, record] of spanLengths ?? []) {
    if (live.has(key)) kept.set(key, record);
    else unresolved.push(record);
  }
  return { kept, unresolved };
}
