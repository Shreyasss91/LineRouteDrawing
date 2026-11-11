/**
 * Automatic browser persistence.
 *
 * The project is remembered between visits in `localStorage`. This module owns
 * the storage key and every failure mode of talking to it; the format itself
 * lives in `project.js` and the UI decides when to save.
 *
 * Browser storage can be missing (private windows, site data blocked) and can
 * fill up (quota). Neither is an error the user caused, and neither should stop
 * them drawing, so every failure is reported as a value rather than thrown.
 */

import {
  PROJECT_FORMAT,
  PROJECT_SCHEMA_VERSION,
  parseProjectJson,
  serializeProjectJson,
} from './project.js';

/**
 * Namespaced, versioned key.
 *
 * The tool's name keeps it distinct from anything else on the origin, and the
 * schema version inside the key means a future format change can write beside
 * the old value instead of destroying it.
 */
export const STORAGE_KEY = `line-route-drawing:v${PROJECT_SCHEMA_VERSION}:project`;

/** Reported when the browser offers no usable storage at all. */
const UNAVAILABLE_MESSAGE =
  'This browser will not let the tool remember your drawing between visits. ' +
  'Use Save project to keep a copy.';

/** Reported when storage is full. */
const QUOTA_MESSAGE =
  'The browser has no room left to remember your drawing. ' +
  'Clear space for this site, or use Save project to keep a copy.';

/**
 * The storage object, or null when the browser will not provide one.
 *
 * Access to `localStorage` itself throws in some privacy configurations, so even
 * the lookup is guarded.
 *
 * @returns {Storage|null} Usable storage or null.
 */
export function getStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    // A write probe is the only reliable way to know storage is usable: some
    // browsers expose the object and throw on use.
    const probe = '__line_route_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/**
 * Save the project to browser storage.
 *
 * @param {object} project Live project.
 * @param {object} [options]
 * @param {Date} [options.now] Timestamp source, for deterministic tests.
 * @returns {{ok: boolean, code: string|null, message: string|null, savedAt: string|null}}
 *   Outcome. Never throws.
 */
export function saveToStorage(project, options = {}) {
  const storage = getStorage();
  if (!storage) {
    return { ok: false, code: 'STORAGE_UNAVAILABLE', message: UNAVAILABLE_MESSAGE, savedAt: null };
  }

  const document = serializeProjectJson(project, options);
  try {
    storage.setItem(STORAGE_KEY, document);
    return {
      ok: true,
      code: null,
      message: null,
      savedAt: JSON.parse(document).metadata.savedAt,
    };
  } catch (error) {
    // A quota failure is the common case here and deserves its own wording;
    // anything else is reported as storage being unavailable rather than
    // guessing at a cause.
    const isQuota =
      error &&
      (error.name === 'QuotaExceededError' ||
        error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        error.code === 22 ||
        error.code === 1014);
    return isQuota
      ? { ok: false, code: 'STORAGE_FULL', message: QUOTA_MESSAGE, savedAt: null }
      : { ok: false, code: 'STORAGE_UNAVAILABLE', message: UNAVAILABLE_MESSAGE, savedAt: null };
  }
}

/**
 * Read the remembered project.
 *
 * Returns a distinct outcome for "nothing saved" and for "something saved that
 * this build cannot read". The caller must not treat the second as the first:
 * overwriting an unreadable project would destroy whatever the user had, so it
 * has to be reported and preserved.
 *
 * @returns {{status: 'none'}
 *   | {status: 'ok', project: object, savedAt: string|null, warnings: string[]}
 *   | {status: 'invalid', message: string, raw: string}
 *   | {status: 'unavailable', message: string}} Outcome.
 */
export function loadFromStorage() {
  const storage = getStorage();
  if (!storage) {
    return { status: 'unavailable', message: UNAVAILABLE_MESSAGE };
  }

  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { status: 'unavailable', message: UNAVAILABLE_MESSAGE };
  }

  if (raw === null || raw === undefined || raw === '') {
    return { status: 'none' };
  }

  const parsed = parseProjectJson(raw);
  if (!parsed.ok) {
    return { status: 'invalid', message: parsed.message, raw };
  }

  let savedAt = null;
  try {
    savedAt = JSON.parse(raw).metadata?.savedAt ?? null;
  } catch {
    savedAt = null;
  }

  return { status: 'ok', project: parsed.project, savedAt, warnings: parsed.warnings };
}

/**
 * Remove the remembered project.
 *
 * Used when the stored copy is unreadable and the user chooses to start fresh,
 * and by tests. A normal Clear does not call this: clearing is a project state
 * like any other and is saved, so a reload shows an empty drawing rather than
 * resurrecting what was cleared.
 *
 * @returns {boolean} True when the key was removed.
 */
export function clearStorage() {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a stored value looks like one of our documents, without parsing it.
 *
 * @param {string} raw Stored text.
 * @returns {boolean} True when the format marker is present.
 */
export function looksLikeProject(raw) {
  return typeof raw === 'string' && raw.includes(`"${PROJECT_FORMAT}"`);
}
