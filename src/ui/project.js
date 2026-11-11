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

/** Identifies a file as a project for this tool. */
export const PROJECT_FORMAT = 'line-route-drawing-project';

/** Current schema version written by `serializeProject`. */
export const PROJECT_SCHEMA_VERSION = 1;

/** Every schema version this build can read. */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1]);

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
export function toProjectPayload(project) {
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
  };
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

  return ok(
    {
      routes,
      originMarker: payload.originMarker,
      spanLength,
      layout: payload.layout,
    },
    { warnings },
  );
}

/**
 * Bring an older document up to the current schema version.
 *
 * There is one version today, so this returns the document unchanged. It exists
 * so a future version has an obvious place to be added, and so every read path
 * already goes through a single migration point rather than growing branches
 * later.
 *
 * @param {object} document A parsed document of a supported version.
 * @returns {{project: object, warnings: string[]}} Migrated payload.
 */
export function migrateDocument(document) {
  const warnings = [];
  let payload = document.project;

  // Each step upgrades by one version. None are defined yet.
  // if (document.schemaVersion === 1 && PROJECT_SCHEMA_VERSION >= 2) { ... }

  return { project: payload, warnings };
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
