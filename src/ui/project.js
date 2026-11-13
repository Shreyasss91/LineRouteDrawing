/**
 * Project persistence: the versioned save format.
 *
 * The project is the list of route instructions plus the drawing settings the
 * user chose. Everything drawn — the graph, node coordinates, edges, the scene —
 * is derived from those inputs and is rebuilt by the normal engine on load. It
 * is never stored, because a stored copy could disagree with the inputs and
 * there would be no way to tell which one was right.
 *
 * This module owns the file format and its validation. It performs no I/O: the
 * caller supplies the text and decides where it goes. That keeps the format
 * testable without a browser and keeps serialization out of the UI controller.
 */

import { DIRECTIONS, PAGE_LAYOUTS } from '../config.js';
import { buildNetwork, normalizeMarkerKind } from '../geometry/network.js';
import * as assetModule from '../geometry/assets.js';
import { isLoadEligible, normalizeUnit } from '../data/schedules.js';

/** Identifies a file as a project for this tool. */
export const PROJECT_FORMAT = 'line-route-drawing-project';

/**
 * Current schema version written by `serializeProject`.
 *
 * Version 2 adds the measured data: the asset identity registry, the node load
 * records, the span length measurements and the annotation placements. Version 1
 * documents still open - see `migrateDocument`.
 */
export const PROJECT_SCHEMA_VERSION = 3;

/** Every schema version this build can read. */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2, 3]);

/** The only marker kinds a route destination may carry. */
const VALID_DIRECTIONS = new Set(Object.keys(DIRECTIONS));
const VALID_ORIGIN_MARKERS = new Set(['plain', 'tc', 'fpb']);
const VALID_LAYOUTS = new Set(Object.keys(PAGE_LAYOUTS));

/**
 * Turn the live project into the file's `project` object.
 *
 * Only user-authored inputs are included, and the order of keys is fixed so two
 * identical projects always serialize to identical text. That makes the output
 * diffable and independent of the order the properties happened to be added in.
 *
 * @param {object} project Live project.
 * @param {Array<object>} project.routes Route instructions.
 * @param {'plain'|'tc'|'fpb'} project.originMarker Origin marker type.
 * @param {number} project.spanLength Span spacing in px.
 * @param {string} project.layout Page layout id.
 * @returns {object} Plain object ready for `JSON.stringify`.
 */
/**
 * Whether two authored projects describe the same drawing.
 *
 * Used to decide whether opening a project would actually replace anything. The
 * two are compared field by field in a fixed order, including route identity and
 * row order, because swapping two rows can change which endpoint later routes
 * start from. Numbers are normalised so a restored `40` and a typed `"40"` are
 * not treated as different, and booleans likewise.
 *
 * Derived data is not part of the comparison: it does not exist in a project
 * payload and is rebuilt on load anyway. Nothing here reads the DOM or the
 * viewport, so the answer depends only on what would be saved.
 *
 * @param {object} a Authored project.
 * @param {object} b Authored project.
 * @returns {boolean} True when opening one in place of the other changes nothing.
 */
export function sameAuthoredProject(a, b) {
  return authoredSignature(a) === authoredSignature(b);
}

/**
 * A stable string describing everything a user authored.
 *
 * @param {object} project Authored project.
 * @returns {string} Signature.
 */
function authoredSignature(project) {
  if (!project || typeof project !== 'object') return '';
  const routes = Array.isArray(project.routes) ? project.routes : [];
  const loads = (project.loads ?? [])
    .map((load) => ({
      id: String(load.id),
      nodeId: String(load.nodeId),
      value: Number(load.value),
      unit: String(load.unit),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // The measurements belong to the project as much as the routes do, so opening a
  // file that changes them has to count as a change and ask before replacing.
  const spanLengths = normalizeMeasurementEntries(project.spanLengths);

  return JSON.stringify({
    originMarker: project.originMarker,
    spanLength: Number(project.spanLength),
    layout: project.layout,
    routes: routes.map((route) => ({
      id: route.id,
      from: route.from,
      direction: route.direction,
      spans: Number(route.spans),
      tc: Boolean(route.tc),
      fpb: Boolean(route.fpb),
    })),
    loads,
    spanLengths,
    loadPlacements: normalizePlacements(project.loadPlacements),
    spanPlacements: normalizePlacements(project.spanPlacements),
    // A name is authored data, so opening a file that renames poles is a change worth
    // asking about rather than something to apply quietly.
    nodeDesignations: normalizeDesignations(project.nodeDesignations),
    // A different export choice changes what the sheet shows, so it counts as a change
    // to the project rather than as a viewer preference.
    exportLoads: project.exportLoads !== false,
    exportLengths: project.exportLengths !== false,
  });
}

export function toProjectPayload(project) {
  const loads = (project.loads ?? []).map((load) => ({
    id: String(load.id),
    nodeId: String(load.nodeId),
    value: Number(load.value),
    unit: String(load.unit),
  }));

  // The measurements are a Map in memory and an object in the file, keyed by the
  // span's asset id, which is what makes "one physical edge, one length" true of
  // the stored form as well.
  const spanLengths = {};
  const entries =
    project.spanLengths instanceof Map
      ? [...project.spanLengths.entries()]
      : Object.entries(project.spanLengths ?? {});
  for (const [spanId, value] of entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const lengthM = typeof value === 'object' && value !== null ? value.lengthM : value;
    if (Number.isFinite(Number(lengthM))) spanLengths[String(spanId)] = Number(lengthM);
  }

  return {
    routes: (project.routes ?? []).map((route) => ({
      id: String(route.id),
      from: String(route.from ?? ''),
      direction: String(route.direction ?? ''),
      spans: Number(route.spans),
      tc: Boolean(route.tc),
      fpb: Boolean(route.fpb),
    })),
    originMarker: normalizeMarkerKind(project.originMarker),
    spanLength: Number(project.spanLength),
    layout: String(project.layout ?? ''),
    loads,
    spanLengths,
    // Placements are keyed by asset id too, so a dragged callout follows its
    // pole rather than staying at a screen position.
    loadPlacements: normalizePlacements(project.loadPlacements),
    spanPlacements: normalizePlacements(project.spanPlacements),
    // Designations are authored names, so they are saved verbatim. Saving them is
    // what stops a reload from re-deriving its way to different ones.
    nodeDesignations: normalizeDesignations(project.nodeDesignations),
    // Export visibility is a property of the project, not of this browser session, so
    // a colleague who opens the file exports the same sheet the author intended.
    exportLoads: project.exportLoads !== false,
    exportLengths: project.exportLengths !== false,
  };
}

/**
 * The node designation table, with only usable names kept.
 *
 * Keyed by node asset id, so a designation follows the pole it names rather than the
 * position it happens to sit at. An empty or malformed entry is dropped rather than
 * written as null, which would read as "this pole has no name" and invite a fresh one
 * to be invented on load.
 *
 * @param {object|Map<string, string>} designations Designations.
 * @returns {object} Plain object of `{id: name}`, sorted for a stable file.
 */
function normalizeDesignations(designations) {
  const out = {};
  const entries =
    designations instanceof Map ? [...designations.entries()] : Object.entries(designations ?? {});
  for (const [id, name] of entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (typeof name !== 'string') continue;
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    out[String(id)] = trimmed;
  }
  return out;
}

/**
 * A placement map, with only usable offsets kept.
 *
 * An offset is a drag distance in scene pixels, not a position, so it stays
 * correct if the drawing is re-laid-out. Anything that is not a finite pair is
 * dropped rather than written as `null`, which would make the file say a callout
 * had been moved when it had not.
 *
 * The candidate index travels with the offset. It records which of the layout's
 * candidate positions the label was on when the user grabbed it, so reopening the
 * project puts the nudge back on the same anchor rather than on the first one.
 *
 * @param {object|Map<string, {dx: number, dy: number, candidateIndex?: number}>} placements
 *   Placements.
 * @returns {object} Plain object of `{id: {dx, dy, candidateIndex}}`.
 */
function normalizePlacements(placements) {
  const out = {};
  const entries =
    placements instanceof Map ? [...placements.entries()] : Object.entries(placements ?? {});
  for (const [id, offset] of entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!offset || typeof offset !== 'object') continue;
    const dx = Number(offset.dx);
    const dy = Number(offset.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    const record = { dx: roundTo(dx, 2), dy: roundTo(dy, 2) };
    const ci = Number(offset.candidateIndex);
    if (Number.isInteger(ci) && ci >= 0) record.candidateIndex = ci;
    out[String(id)] = record;
  }
  return out;
}

/** Measurements as a sorted `[spanId, length]` list, whichever form they arrive in. */
function normalizeMeasurementEntries(spanLengths) {
  const entries =
    spanLengths instanceof Map
      ? [...spanLengths.entries()]
      : Object.entries(spanLengths ?? {});
  return entries
    .map(([spanId, value]) => {
      const lengthM = typeof value === 'object' && value !== null ? value.lengthM : value;
      return [String(spanId), Number(lengthM)];
    })
    .filter(([, lengthM]) => Number.isFinite(lengthM))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Serialize the live project into the versioned document.
 *
 * @param {object} project Live project.
 * @param {object} [options]
 * @param {Date} [options.now] Timestamp source, for deterministic tests.
 * @returns {object} The document to write to a file.
 */
export function serializeProject(project, options = {}) {
  const now = options.now ?? new Date();
  return {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    metadata: {
      savedAt: now.toISOString(),
    },
    project: toProjectPayload(project),
  };
}

/** Serialize to the exact text written into a downloaded file. */
export function serializeProjectJson(project, options = {}) {
  return JSON.stringify(serializeProject(project, options), null, 2);
}

/** A successful parse, or a refusal that says what to do about it. */
function ok(project, extra = {}) {
  return { ok: true, project, warnings: extra.warnings ?? [] };
}

function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * Read a project document back into a live project.
 *
 * Validation happens in full before anything is returned, so a caller can never
 * be handed a half-applied project. The candidate is also rebuilt through the
 * real geometry engine: a file that parses but whose routes do not resolve is
 * refused, because accepting it would replace a working drawing with an empty
 * one.
 *
 * @param {string} text File contents.
 * @returns {{ok: true, project: object, warnings: string[]}
 *   | {ok: false, code: string, message: string}} Result.
 */
export function parseProjectJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return fail('EMPTY_FILE', 'That file is empty. Choose a project file saved by this tool.');
  }

  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return fail(
      'INVALID_JSON',
      'That file is not valid JSON, so it could not be read. Choose a project file saved by this tool.',
    );
  }

  return parseProjectDocument(document);
}

/**
 * Validate an already-parsed project document.
 *
 * @param {unknown} document Parsed JSON.
 * @returns {{ok: true, project: object, warnings: string[]}
 *   | {ok: false, code: string, message: string}} Result.
 */
export function parseProjectDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return fail(
      'NOT_A_PROJECT',
      'That file does not contain a project. Choose a project file saved by this tool.',
    );
  }

  if (document.format !== PROJECT_FORMAT) {
    return fail(
      'WRONG_FORMAT',
      'That file was not saved by this tool, so it cannot be opened here. Choose a project file saved by this tool.',
    );
  }

  const version = document.schemaVersion;
  if (!Number.isInteger(version) || version < 1) {
    return fail(
      'BAD_VERSION',
      'That project file does not say which version it is, so it cannot be opened. ' +
        'Choose a project saved by this tool.',
    );
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    if (version > PROJECT_SCHEMA_VERSION) {
      return fail(
        'FUTURE_VERSION',
        `That project was saved by a newer version of this tool (version ${version}, ` +
          `and this one reads up to ${PROJECT_SCHEMA_VERSION}). Update the tool to open it. ` +
          'Your current drawing has not been changed.',
      );
    }
    return fail(
      'UNSUPPORTED_VERSION',
      `That project uses version ${version}, which this tool no longer reads. ` +
        'Your current drawing has not been changed.',
    );
  }

  const migrated = migrateDocument(document);
  const payload = migrated.project;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('MISSING_PROJECT', 'That project file has no drawing in it, so there is nothing to open.');
  }

  if (!Array.isArray(payload.routes)) {
    return fail(
      'MISSING_ROUTES',
      'That project file has no list of routes in it, so there is nothing to open.',
    );
  }

  // Settings, each checked against the same limits the form enforces.
  if (!VALID_ORIGIN_MARKERS.has(payload.originMarker)) {
    return fail(
      'BAD_ORIGIN_MARKER',
      'That project does not say how the starting point is drawn. ' +
        'Choose a project saved by this tool.',
    );
  }

  const spanLength = payload.spanLength;
  if (typeof spanLength !== 'number' || !Number.isFinite(spanLength) || spanLength <= 0) {
    return fail(
      'BAD_SPAN_LENGTH',
      'That project has an unusable span spacing, so the drawing cannot be rebuilt. ' +
        'Choose a project saved by this tool.',
    );
  }

  if (!VALID_LAYOUTS.has(payload.layout)) {
    return fail(
      'BAD_LAYOUT',
      'That project names a page layout this tool does not have. ' +
        'Choose a project saved by this tool.',
    );
  }

  const warnings = [...migrated.warnings];

  // Routes, one at a time, collecting every problem rather than stopping at the
  // first so the message can name all of them.
  const routes = [];
  const seenIds = new Set();
  const problems = [];

  payload.routes.forEach((route, index) => {
    const row = index + 1;
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      problems.push(`Route ${row} is not a route.`);
      return;
    }

    const id = route.id;
    if (typeof id !== 'string' || id === '') {
      problems.push(`Route ${row} has no identifier.`);
      return;
    }
    if (seenIds.has(id)) {
      problems.push(`Route ${row} reuses the identifier of an earlier route.`);
      return;
    }
    seenIds.add(id);

    if (typeof route.from !== 'string' || route.from === '') {
      problems.push(`Route ${row} has no starting point.`);
      return;
    }
    if (!VALID_DIRECTIONS.has(route.direction)) {
      problems.push(`Route ${row} has a direction this tool does not have.`);
      return;
    }
    if (!Number.isInteger(route.spans) || route.spans < 1) {
      problems.push(`Route ${row} has a span count that is not a whole number of at least 1.`);
      return;
    }
    if (typeof route.tc !== 'boolean' || typeof route.fpb !== 'boolean') {
      problems.push(`Route ${row} does not say which kind of point it ends at.`);
      return;
    }
    if (route.tc && route.fpb) {
      problems.push(`Route ${row} ends at both a TC point and an FPB point.`);
      return;
    }

    routes.push({
      id,
      from: route.from,
      direction: route.direction,
      spans: route.spans,
      tc: route.tc,
      fpb: route.fpb,
    });
  });

  if (problems.length > 0) {
    return fail('INVALID_ROUTES', `That project cannot be opened: ${problems.join(' ')}`);
  }

  // Rebuild through the real engine. A file whose routes do not resolve is
  // refused, because opening it would replace a working drawing with a broken
  // one and the user would have no idea which rows were at fault.
  const network = buildNetwork(routes, { originMarker: payload.originMarker });
  if (!network.ok) {
    const detail = network.errors.map((e) => e.message).join(' ');
    return fail(
      'INVALID_DEPENDENCIES',
      `That project cannot be opened because its routes do not connect up: ${detail}`,
    );
  }

  // The measured data. Each section is validated before anything is applied, and
  // a malformed section refuses the whole file: a project that half-loaded its
  // survey would be worse than one that did not load at all.
  const measured = validateMeasuredData(payload, network, problems);
  if (!measured.ok) {
    return fail(measured.code, measured.message);
  }

  return ok(
    {
      routes,
      originMarker: payload.originMarker,
      spanLength,
      layout: payload.layout,
      loads: measured.loads,
      spanLengths: measured.spanLengths,
      loadPlacements: measured.loadPlacements,
      spanPlacements: measured.spanPlacements,
      // The name table rides with the measured sections because it is read and
      // validated in the same pass. It MUST be carried into the project the caller
      // receives: without it `applyProject` saw `undefined`, started from an empty
      // map, and the allocator named every pole afresh on each reload - which is
      // exactly the defect this line fixes.
      nodeDesignations: measured.nodeDesignations,
      // A file from before the switches opens with both on, which is what it would
      // have exported then.
      exportLoads: payload.exportLoads !== false,
      exportLengths: payload.exportLengths !== false,
    },
    { warnings: [...warnings, ...measured.warnings] },
  );
}

/**
 * Validate the load, length and placement sections of a project payload.
 *
 * A record that refers to an asset the drawing no longer has is kept and reported
 * rather than refused: the user removed that branch deliberately and their load
 * is still their data, so it stays unresolved until they reassign or discard it.
 * A record that is simply malformed - a negative kVA, an unknown unit, a repeated
 * id - is a different matter and refuses the file, because there is no sensible
 * way to load it.
 *
 * @param {object} payload Project payload.
 * @param {object} network Rebuilt network, used to check asset ids exist.
 * @param {string[]} problems Ignored; kept so the signature reads consistently.
 * @returns {{ok: true, ...} | {ok: false, code: string, message: string}}
 */
function validateMeasuredData(payload, network, problems) {
  const warnings = [];
  const issues = [];

  // ---- loads ----
  const liveNodes = new Set();
  if (payload.loads !== undefined && !Array.isArray(payload.loads)) {
    return { ok: false, code: 'BAD_LOADS', message: 'That project has a load list that is not a list.' };
  }
  const loads = [];
  const seenLoadIds = new Set();
  for (const [index, load] of (payload.loads ?? []).entries()) {
    const row = index + 1;
    if (!load || typeof load !== 'object' || Array.isArray(load)) {
      issues.push(`Load ${row} is not a load.`);
      continue;
    }
    if (typeof load.id !== 'string' || load.id === '') {
      issues.push(`Load ${row} has no identifier.`);
      continue;
    }
    if (seenLoadIds.has(load.id)) {
      issues.push(`Load ${row} reuses the identifier ${load.id}.`);
      continue;
    }
    seenLoadIds.add(load.id);
    if (typeof load.nodeId !== 'string' || load.nodeId === '') {
      issues.push(`Load ${row} does not say which point it belongs to.`);
      continue;
    }
    const value = Number(load.value);
    if (!Number.isFinite(value) || value <= 0) {
      issues.push(`Load ${row} has a value that is not a number greater than zero.`);
      continue;
    }
    const unit = normalizeUnit(load.unit);
    if (!unit) {
      issues.push(`Load ${row} has a unit this tool does not recognise.`);
      continue;
    }
    loads.push({ id: load.id, nodeId: load.nodeId, value, unit });
  }

  // ---- span lengths ----
  const spanLengths = new Map();
  const rawSpans = payload.spanLengths;
  if (rawSpans !== undefined && (typeof rawSpans !== 'object' || rawSpans === null || Array.isArray(rawSpans))) {
    return {
      ok: false,
      code: 'BAD_SPAN_LENGTHS',
      message: 'That project has a span length table that is not a table.',
    };
  }
  for (const [spanId, rawValue] of Object.entries(rawSpans ?? {})) {
    const lengthM = Number(rawValue);
    if (!Number.isFinite(lengthM) || lengthM <= 0) {
      issues.push(`The length saved for span ${spanId} is not a number greater than zero.`);
      continue;
    }
    spanLengths.set(String(spanId), { spanId: String(spanId), lengthM });
  }

  if (issues.length > 0) {
    return {
      ok: false,
      code: 'INVALID_MEASUREMENTS',
      message: `That project cannot be opened: ${issues.join(' ')}`,
    };
  }

  // ---- placements ----
  const loadPlacements = validatePlacements(payload.loadPlacements, 'load');
  const spanPlacements = validatePlacements(payload.spanPlacements, 'span');
  if (!loadPlacements.ok) return loadPlacements;
  if (!spanPlacements.ok) return spanPlacements;

  // ---- point designations ----
  // Kept exactly as saved: a name is what the user agreed with, so a file that
  // carries one is honoured rather than re-derived. A designation on a pole the
  // drawing no longer has is kept too, so it can be reported alongside the load that
  // went with it instead of disappearing quietly.
  const rawDesignations = payload.nodeDesignations;
  if (
    rawDesignations !== undefined &&
    (typeof rawDesignations !== 'object' || rawDesignations === null || Array.isArray(rawDesignations))
  ) {
    return {
      ok: false,
      code: 'BAD_DESIGNATIONS',
      message: 'That project has a point name table that is not a table.',
    };
  }
  const nodeDesignations = new Map();
  for (const [nodeId, rawName] of Object.entries(rawDesignations ?? {})) {
    if (typeof rawName !== 'string') continue;
    const name = rawName.trim();
    if (name === '') continue;
    nodeDesignations.set(String(nodeId), name);
  }

  // Two DIFFERENT points must not share a name, because that is exactly what makes a
  // schedule ambiguous. But one physical pole legitimately carries one name under two
  // ids: a named endpoint that is also some route's destination is stored both as
  // `endpoint:A` and as `dst:route-N`, and the allocator deliberately writes the same
  // designation to both so neither looks nameless. Refusing that outright would make
  // every project with an A/B/C endpoint unopenable, which is what happened when this
  // check was first written.
  //
  // So ownership is compared by the coordinate the id resolves to, not by the id
  // alone. Ids that resolve nowhere (an unresolved asset kept from an older drawing)
  // are treated as their own point, because there is no evidence they share one.
  const ownerOfName = new Map();
  for (const [nodeId, name] of nodeDesignations) {
    const coord = coordinateForNodeId(network, nodeId);
    const owner = coord ?? nodeId;
    const existing = ownerOfName.get(name);
    if (existing !== undefined && existing !== owner) {
      return {
        ok: false,
        code: 'DUPLICATE_DESIGNATION',
        message:
          `That project names two different points ${name}. Each point needs its own ` +
          'name. Open it and rename one of them.',
      };
    }
    ownerOfName.set(name, owner);
  }

  // ---- referential checks, reported but not fatal ----
  const { buildAssetRegistry } = assetModule;
  const registry = buildAssetRegistry(network);
  for (const asset of registry.allNodeAssets()) liveNodes.add(asset.id);
  const liveSpans = new Set(registry.allSpanAssets().map((span) => span.id));

  // ---- canonicalise accepted aliases, once, here ----
  //
  // A load's `nodeId` may legally be an accepted alias of a point rather than its asset
  // id - a coordinate spelling like `0,-2`, for instance. The registry resolves those, but
  // every downstream consumer compared the raw string, so such a load was drawn as an
  // orphan with no callout even though the file was valid. Normalising at this boundary
  // fixes all of them at once, rather than teaching each of the schedule panel, the
  // annotation layer and the reassignment picker to resolve aliases independently.
  //
  // Only identifiers that RESOLVE are rewritten. A genuinely unresolved reference is left
  // exactly as it was, so the existing reconciliation behaviour still reports it and the
  // user can reassign it - a broken reference must not be mistaken for an alias, and must
  // never be silently deleted, nulled or pointed somewhere convenient.
  //
  // `validatedLoads` contains new objects, so the caller's parsed JSON is not mutated.
  const validatedLoads = loads.map((load) => {
    const canonical = registry.canonicalNodeId(load.nodeId);
    return canonical === null ? load : { ...load, nodeId: canonical };
  });

  // ---- a load on a point that cannot carry one is fatal ----
  // Distinct from the orphan check below: an orphan points at a node that no longer
  // exists and is kept so the user can reassign it, but a TC point is alive and
  // still cannot take a load, so the file is wrong rather than merely out of date.
  // Resolved through the registry, never by reading the id, so an alias or a
  // coordinate spelling cannot slip past it.
  const ineligible = [];
  for (const load of validatedLoads) {
    const asset = registry.nodeAsset(registry.canonicalNodeId(load.nodeId) ?? load.nodeId);
    if (asset && isLoadEligible(asset.nodeType) === false) ineligible.push({ load, asset });
  }
  if (ineligible.length > 0) {
    const described = ineligible
      .map(({ load, asset }) => `${load.id} on ${asset.label ?? load.nodeId} (a ${asset.nodeType} point)`)
      .join(', ');
    return {
      ok: false,
      code: 'INELIGIBLE_LOAD_TARGET',
      message:
        `That project cannot be opened: ${described} ` +
        `${ineligible.length === 1 ? 'is a load on a point that does' : 'are loads on points that do'} ` +
        'not take loads. A TC point is a test point, so remove the load or move it to a ' +
        'pole, an FPB or the Origin.',
    };
  }

  const orphanLoads = validatedLoads.filter((load) => !liveNodes.has(load.nodeId));
  if (orphanLoads.length > 0) {
    warnings.push(
      `${orphanLoads.length} ${
        orphanLoads.length === 1 ? 'load belongs' : 'loads belong'
      } to points this drawing no longer has. They are kept and can be reassigned.`,
    );
  }
  const orphanSpans = [...spanLengths.values()].filter((span) => !liveSpans.has(span.spanId));
  if (orphanSpans.length > 0) {
    warnings.push(
      `${orphanSpans.length} ${
        orphanSpans.length === 1 ? 'length belongs' : 'lengths belong'
      } to spans this drawing no longer has. They are kept and can be reassigned.`,
    );
  }

  return {
    ok: true,
    loads: validatedLoads,
    spanLengths,
    loadPlacements: loadPlacements.placements,
    spanPlacements: spanPlacements.placements,
    nodeDesignations,
    warnings,
  };
}

/** Read a placement map, dropping anything unusable rather than refusing the file. */
function validatePlacements(raw, kind) {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    return {
      ok: false,
      code: 'BAD_PLACEMENTS',
      message: `That project has a ${kind} placement table that is not a table.`,
    };
  }
  const placements = {};
  for (const [id, offset] of Object.entries(raw ?? {})) {
    if (!offset || typeof offset !== 'object') continue;
    const dx = Number(offset.dx);
    const dy = Number(offset.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    const record = { dx, dy };
    // A stored candidate index is optional and, when present, keeps the nudge on
    // the anchor the user grabbed. An old file has none, which is fine: the first
    // candidate is the historical default and the offset is applied from there.
    const ci = Number(offset.candidateIndex);
    if (Number.isInteger(ci) && ci >= 0) record.candidateIndex = ci;
    placements[String(id)] = record;
  }
  return { ok: true, placements };
}

/**
 * Bring an older document up to the current schema version.
 *
 * Each step upgrades by exactly one version, so a file from any supported
 * version arrives at the current one by the same sequence of steps. The routes
 * and settings are never touched: a migration only ever adds what a later version
 * knows about and an earlier one did not have.
 *
 * The rule that matters: a migration never invents measured data. A version 1
 * project had no loads and no span lengths, so it comes back with both empty. It
 * must not guess a length from the drawing's spacing, because the spacing is a
 * layout choice and the length is a survey - one is not evidence of the other.
 *
 * @param {object} document A parsed document of a supported version.
 * @returns {{project: object, warnings: string[]}} Migrated payload.
 */
export function migrateDocument(document) {
  const warnings = [];
  let payload = document.project;

  if (document.schemaVersion === 1 && PROJECT_SCHEMA_VERSION >= 2) {
    payload = upgradeV1ToV2(payload, warnings);
  }
  if (document.schemaVersion <= 2 && PROJECT_SCHEMA_VERSION >= 3) {
    payload = upgradeV2ToV3(payload, warnings);
  }

  return { project: payload, warnings };
}

/**
 * Version 2 to 3: introduce the network point designations.
 *
 * Version 2 named its points only by internal id (`mid:route-2:0`) and by the drawn
 * label (a letter, or nothing at all for an intermediate pole). Version 3 stores a
 * designation per node, so a schedule can say `A1` and mean one specific pole.
 *
 * A version 2 project opens with an EMPTY designation table rather than one filled
 * in from the drawing. That is deliberate: the designations are authored data, and
 * the rule for them is that they are assigned once and never silently reassigned.
 * Generating them during a migration would hand every pole a name the user never saw
 * and cannot tell apart from one they chose - and if their route list had changed
 * since, the generated names would be attached to different poles than a fresh
 * allocation would produce. So the numbers are allocated on first open by the normal
 * path, from the saved routes, and from then on they are stored and kept. The drawing
 * itself is untouched either way.
 *
 * The counters are deliberately not stored either. They are derived from the
 * designations that do exist, so an old project cannot bring a stale counter that
 * would skip numbers.
 *
 * @param {object} payload Version 2 project payload.
 * @param {string[]} warnings Collected notices.
 * @returns {object} Version 3 payload.
 */
function upgradeV2ToV3(payload, warnings) {
  if (!payload || typeof payload !== 'object') return payload;
  warnings.push(
    'This project was saved before points were named, so its poles are named for ' +
      'the first time now. The names are stored from here on and will not change.',
  );
  return {
    ...payload,
    nodeDesignations: {},
  };
}

/**
 * Version 1 to 2: introduce the measured data.
 *
 * Version 1 held routes and drawing settings only. Version 2 adds the load
 * records, the span measurements and the annotation placements, all of which
 * start empty: nothing was measured under version 1, so there is nothing to carry
 * across, and an empty schedule is the honest representation of that.
 *
 * @param {object} payload Version 1 project payload.
 * @param {string[]} warnings Collected notices.
 * @returns {object} Version 2 payload.
 */
function upgradeV1ToV2(payload, warnings) {
  if (!payload || typeof payload !== 'object') return payload;
  warnings.push(
    'This project was saved before loads and span lengths could be recorded, ' +
      'so it opens with both empty. Its drawing is unchanged.',
  );
  return {
    ...payload,
    loads: [],
    spanLengths: {},
    loadPlacements: {},
    spanPlacements: {},
  };
}

/* ------------------------------------------------------------------ */
/* File name                                                           */
/* ------------------------------------------------------------------ */

/**
 * The name a saved project is downloaded as.
 *
 * A stable name means a second save does not litter the downloads folder with
 * near-duplicates, and it is recognizable months later.
 *
 * @returns {string} File name.
 */
export function projectFileName() {
  return 'line-route-project.json';
}

/**
 * The coordinate a node asset id stands for, when the network can say.
 *
 * Needed because one physical pole is stored under two ids - a named endpoint as
 * `endpoint:A`, and its far-end pole as `dst:route-N` - and those two ids must be
 * recognised as the same point when checking that no two DIFFERENT points share a
 * designation. Anything the network cannot place (an asset kept from a drawing that
 * has since lost it) returns null, and the caller then treats its id as the point
 * itself rather than guessing it matches something else.
 *
 * @param {object} network Built network.
 * @param {string} nodeId Node asset id.
 * @returns {string|null} `x,y`, or null when it cannot be resolved.
 */
function coordinateForNodeId(network, nodeId) {
  if (typeof nodeId !== 'string' || nodeId === '') return null;
  if (nodeId === 'origin') {
    const origin = network.originPosition ?? network.origin;
    if (!origin) return null;
    return `${origin.x},${origin.y}`;
  }
  const endpoint = (network.endpoints ?? []).find((e) => e.id === nodeId);
  if (endpoint?.position) return `${endpoint.position.x},${endpoint.position.y}`;

  // `mid:<routeId>:<k>` and `dst:<routeId>`. The route id may itself contain a
  // colon-free run of digits, so the trailing group is matched from the right.
  const match = /^(mid|dst):(.+?)(?::(\d+))?$/.exec(nodeId);
  if (!match) return null;
  const route = (network.routes ?? []).find((r) => r.routeId === match[2]);
  if (!route || !route.ok || !Array.isArray(route.path)) return null;
  // A route's path starts at its source, so the k-th intermediate pole is the point
  // at k+1 and a destination is the last point.
  const index = match[1] === 'dst' || match[3] === undefined ? route.path.length - 1 : Number(match[3]) + 1;
  const point = route.path[index];
  return point ? `${point.x},${point.y}` : null;
}
