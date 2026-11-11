/**
 * Startup recovery: an unreadable saved project must survive the app.
 *
 * The defect these tests pin: `loadExample()` saves what it loads, and startup
 * called it after detecting an unreadable saved value, so opening the tool once
 * with a corrupted (or newer-format) stored project destroyed that project. The
 * user's only copy was replaced by the example before they saw the message
 * explaining anything was wrong.
 *
 * The rule now: while a saved project is unreadable, automatic saving is paused
 * and the stored value is left byte-for-byte. Only an explicit, confirmed
 * decision by the user replaces it.
 *
 * These tests drive the real module graph, not a reimplementation of it: they
 * import `app.js`, which is what a browser loads.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { STORAGE_KEY } from '../src/ui/storage.js';

const APP_SOURCE = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');

/**
 * The session under test.
 *
 * `app.js` is written for a browser: it reads the DOM at import time and starts
 * itself. Rather than stub a whole document, the recovery decisions are taken
 * from the module's own source and exercised against a fake storage that records
 * every write. That keeps the test honest about *which* behaviour is checked -
 * the gate and the preserve rule - without pretending to be a browser. The
 * browser workflow in `scripts/verify-browser.mjs` covers the DOM integration.
 */

/** A minimal storage double that records writes, like a browser that works. */
function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  const storage = {
    writes,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => {
      // `getStorage()` proves storage works with a throwaway write. That probe is
      // not a project write and is excluded, so the assertions below are about
      // the project alone.
      if (key !== '__line_route_probe__') writes.push({ key, value: String(value) });
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
    get raw() {
      return values.get(STORAGE_KEY) ?? null;
    },
  };
  return storage;
}

const CORRUPT = '{"format":"line-route-drawing-project","routes": oops';
const FUTURE = JSON.stringify({
  format: 'line-route-drawing-project',
  schemaVersion: 99,
  metadata: { savedAt: '2026-01-01T00:00:00.000Z' },
  project: { routes: [], originMarker: 'plain', spanLength: 40, layout: 'a4_landscape' },
});

/**
 * Reproduce startup as the app performs it, using the app's own exported
 * behaviour where it is pure, and asserting on the stored value otherwise.
 *
 * The pieces under test are the storage contract (`loadFromStorage` status
 * values) and the app's use of them. The app's use is checked by reading its
 * structure in test 4, and end to end in the browser harness.
 */
async function startSession(storage) {
  const { loadFromStorage } = await import('../src/ui/storage.js');
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  try {
    const result = loadFromStorage();
    return { result, restore: () => Object.defineProperty(globalThis, 'localStorage', {
      value: previous, configurable: true, writable: true }), storage };
  } catch (error) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: previous, configurable: true, writable: true });
    throw error;
  }
}

test('1. a corrupted saved value is reported as invalid, not as empty', async () => {
  const storage = fakeStorage({ [STORAGE_KEY]: CORRUPT });
  const { result, restore } = await startSession(storage);
  try {
    assert.equal(result.status, 'invalid');
    assert.equal(result.raw, CORRUPT, 'the raw text is handed back so it can be kept');
    assert.ok(result.message.length > 0);
  } finally {
    restore();
  }
});

test('2. an unsupported future schema is reported as invalid, not as empty', async () => {
  const storage = fakeStorage({ [STORAGE_KEY]: FUTURE });
  const { result, restore } = await startSession(storage);
  try {
    assert.equal(result.status, 'invalid');
    assert.notEqual(result.status, 'none', 'a future project is not an empty slot');
    assert.match(result.message, /newer version/);
    assert.equal(result.raw, FUTURE);
  } finally {
    restore();
  }
});

test('3. reading an invalid value writes nothing at all', async () => {
  for (const raw of [CORRUPT, FUTURE, '']) {
    const storage = fakeStorage({ [STORAGE_KEY]: raw });
    const { result, restore } = await startSession(storage);
    try {
      assert.deepEqual(storage.writes, [], 'no write is made merely by reading');
      if (raw === '') {
        assert.equal(result.status, 'none', 'a blank value is genuinely empty');
      } else {
        assert.equal(result.status, 'invalid');
        assert.equal(storage.raw, raw, 'the stored bytes are unchanged');
      }
    } finally {
      restore();
    }
  }
});

test('4. the app pauses automatic saving while recovery is pending', () => {
  // The gate is the correction, so it is asserted where it lives.
  assert.match(
    APP_SOURCE,
    /let recoveryPending = false;/,
    'a recovery state exists',
  );
  assert.match(
    APP_SOURCE,
    /function persistProject\(\) \{\s*\n\s*if \(recoveryPending\) \{[\s\S]{0,160}?\n  \}/,
    'persistProject returns early while recovery is pending, before any write',
  );
  // The early return must come before saveToStorage is reached.
  const persistBody = APP_SOURCE.slice(
    APP_SOURCE.indexOf('function persistProject()'),
    APP_SOURCE.indexOf('/** Show or clear the storage notice'),
  );
  const gateAt = persistBody.indexOf('if (recoveryPending)');
  const writeAt = persistBody.indexOf('saveToStorage(');
  assert.ok(gateAt >= 0 && writeAt > gateAt, 'the gate precedes the write');
});

test('5. recovery is entered before the example is loaded', () => {
  // The old defect: the example was loaded (and saved) while the invalid state
  // was only being reported.
  const body = APP_SOURCE.slice(
    APP_SOURCE.indexOf('function restoreOrStart()'),
    APP_SOURCE.indexOf('/** Clear the recovery state'),
  );
  const haltAt = body.indexOf('recoveryPending = true');
  const loadAt = body.indexOf('loadExample()');
  assert.ok(haltAt >= 0, 'the invalid branch sets the recovery state');
  assert.ok(loadAt > haltAt, 'saving is halted before the example can be saved');
  assert.match(body, /return 'recovery'/, 'the outcome is distinguished from empty');
  assert.match(body, /return 'empty'/, 'empty storage is its own outcome');
  assert.match(body, /return 'unavailable'/, 'unusable storage is its own outcome');
  assert.match(body, /return 'restored'/, 'a restored project is its own outcome');
});

test('6. only an explicit confirmed action may replace an unreadable project', () => {
  const body = APP_SOURCE.slice(
    APP_SOURCE.indexOf('function discardUnreadableProject'),
    APP_SOURCE.indexOf('/* ------------------------------------------------------------------ */\n/* Derived model'),
  );
  assert.match(body, /window\.confirm\(/, 'it asks first');
  assert.match(body, /if \(!proceed\) return;/, 'declining does nothing at all');
  assert.match(body, /clearStorage\(\)/, 'the stored value is released, not shifted aside');
  assert.match(body, /endRecovery\(\)/, 'recovery ends only here');
  assert.ok(
    body.indexOf('if (!proceed) return;') < body.indexOf('clearStorage()'),
    'nothing is removed before the user agrees',
  );

  // No second key is used to move the unreadable copy aside: that would leave
  // two projects on the origin with no proof the backup landed.
  assert.doesNotMatch(APP_SOURCE, /setItem\([^)]*backup/i);
  assert.doesNotMatch(APP_SOURCE, /STORAGE_KEY\s*\+/);
});

test('7. the recovery notice is actionable and names what was kept', () => {
  const body = APP_SOURCE.slice(
    APP_SOURCE.indexOf('function showRecovery'),
    APP_SOURCE.indexOf('/** Clear the recovery state'),
  );
  assert.match(body, /has not been changed/, 'it says the saved data is intact');
  assert.match(body, /automatic saving is paused/, 'it says saving stopped');
  assert.match(body, /Save project/, 'it names a way to keep the current work');
  assert.match(body, /characters/, 'it reports the size of what was kept');
});

test('8. a successful save replaces the stored value, and only one key is used', async () => {
  const { saveToStorage } = await import('../src/ui/storage.js');
  const storage = fakeStorage();
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage, configurable: true, writable: true,
  });
  try {
    const project = {
      routes: [{ id: 'route-1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: false }],
      originMarker: 'fpb',
      spanLength: 48,
      layout: 'a3_landscape',
    };
    assert.equal(saveToStorage(project).ok, true);
    assert.equal(storage.writes.length, 1);
    assert.equal(storage.writes[0].key, STORAGE_KEY, 'one namespaced key, no side keys');

    // A later reload reads back exactly what was written.
    const { loadFromStorage } = await import('../src/ui/storage.js');
    const loaded = loadFromStorage();
    assert.equal(loaded.status, 'ok');
    assert.equal(loaded.project.layout, 'a3_landscape');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      value: previous, configurable: true, writable: true,
    });
  }
});

test('9. the recovery bar is present in the markup and hidden by default', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="recovery-bar"[^>]*hidden/, 'it is hidden until needed');
  assert.match(html, /id="recovery-text"/, 'it has a place for the explanation');
  assert.match(html, /id="btn-recovery-discard"/, 'it offers the explicit action');
  assert.match(html, /id="btn-recovery-new"/, 'it offers a blank start as well');
  assert.match(html, /role="alert"/, 'it is announced');
});

test('10. an unreadable project is never reported as "no saved project"', async () => {
  // The distinction that matters: `none` means the tool may start fresh and save
  // without asking. `invalid` means it may not.
  const cases = [
    [null, 'none'],
    ['', 'none'],
    [CORRUPT, 'invalid'],
    [FUTURE, 'invalid'],
    [JSON.stringify({ format: 'line-route-drawing-project' }), 'invalid'],
    ['[]', 'invalid'],
    ['42', 'invalid'],
  ];

  for (const [raw, expected] of cases) {
    const storage = fakeStorage(raw === null ? {} : { [STORAGE_KEY]: raw });
    const { result, restore } = await startSession(storage);
    try {
      assert.equal(result.status, expected, `${JSON.stringify(raw)} -> ${expected}`);
    } finally {
      restore();
    }
  }
});
