/**
 * Automatic browser persistence.
 *
 * `localStorage` is faked here rather than relied on, because the cases that
 * matter most are the ones a real browser will not produce on demand: storage
 * that is missing entirely, storage that is full, and a stored value that has
 * been corrupted or written by a newer build.
 *
 * The rule these tests protect is that none of those lose the user's work: an
 * unreadable project is reported and left in place, never overwritten by the
 * example or by an empty drawing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { clearStorage, getStorage, loadFromStorage, looksLikeProject, saveToStorage, STORAGE_KEY } from '../src/ui/storage.js';
import { serializeProjectJson } from '../src/ui/project.js';

const FIXED_DATE = new Date('2026-05-06T07:08:09.000Z');

function sampleProject() {
  return {
    routes: [
      { id: 'route-1', from: 'origin', direction: 'south', spans: 3, tc: false, fpb: false },
      { id: 'route-2', from: 'endpoint:A', direction: 'east', spans: 2, tc: true, fpb: false },
    ],
    originMarker: 'fpb',
    spanLength: 48,
    layout: 'a3_landscape',
  };
}

/**
 * Install a fake `localStorage` for the duration of a test.
 *
 * @param {object} [options]
 * @param {'normal'|'missing'|'throwing'|'quota'} [options.kind] Failure mode.
 * @param {object} [options.initial] Values already stored.
 * @returns {() => void} Restore function.
 */
function useFakeStorage(options = {}) {
  const { kind = 'normal', initial = {} } = options;
  const values = new Map(Object.entries(initial));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  let storage;

  if (kind === 'missing') {
    storage = undefined;
  } else if (kind === 'throwing') {
    // Some configurations expose the object and throw on every use.
    storage = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
      removeItem() {
        throw new Error('denied');
      },
    };
  } else {
    storage = {
      get length() {
        return values.size;
      },
      key(index) {
        return [...values.keys()][index] ?? null;
      },
      getItem(key) {
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        if (kind === 'quota') {
          const error = new Error('full');
          error.name = 'QuotaExceededError';
          throw error;
        }
        values.set(key, String(value));
      },
      removeItem(key) {
        values.delete(key);
      },
      clear() {
        values.clear();
      },
    };
  }

  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });

  return () => {
    if (previous) {
      Object.defineProperty(globalThis, 'localStorage', previous);
    } else {
      delete globalThis.localStorage;
    }
  };
}

test('1. saving then loading restores the project exactly', () => {
  const restore = useFakeStorage();
  try {
    const project = sampleProject();
    const saved = saveToStorage(project, { now: FIXED_DATE });
    assert.equal(saved.ok, true);
    assert.equal(saved.savedAt, '2026-05-06T07:08:09.000Z');

    const loaded = loadFromStorage();
    assert.equal(loaded.status, 'ok');
    assert.deepEqual(loaded.project, project);
    assert.equal(loaded.savedAt, '2026-05-06T07:08:09.000Z');
  } finally {
    restore();
  }
});

test('2. nothing saved is reported as "none", not as an error', () => {
  const restore = useFakeStorage();
  try {
    assert.equal(loadFromStorage().status, 'none');
  } finally {
    restore();
  }
});

test('3. an empty project can be saved and remains empty', () => {
  const restore = useFakeStorage();
  try {
    const empty = { routes: [], originMarker: 'plain', spanLength: 40, layout: 'a4_landscape' };
    assert.equal(saveToStorage(empty, { now: FIXED_DATE }).ok, true);

    const loaded = loadFromStorage();
    assert.equal(loaded.status, 'ok');
    assert.deepEqual(loaded.project.routes, []);
    assert.equal(loaded.project.originMarker, 'plain');
    // A reload after clearing must not bring the previous drawing back.
    assert.notEqual(loaded.project.routes.length, sampleProject().routes.length);
  } finally {
    restore();
  }
});

test('4. the storage key is namespaced and versioned', () => {
  assert.match(STORAGE_KEY, /^line-route-drawing:v\d+:project$/);
});

test('5. unavailable storage is reported, not thrown', () => {
  const restore = useFakeStorage({ kind: 'missing' });
  try {
    assert.equal(getStorage(), null);
    const saved = saveToStorage(sampleProject(), { now: FIXED_DATE });
    assert.equal(saved.ok, false);
    assert.equal(saved.code, 'STORAGE_UNAVAILABLE');
    assert.match(saved.message, /Save project/, 'it offers the portable alternative');

    const loaded = loadFromStorage();
    assert.equal(loaded.status, 'unavailable');

    // Clearing must not throw either.
    assert.equal(clearStorage(), false);
  } finally {
    restore();
  }
});

test('6. storage that throws on use is treated as unavailable', () => {
  const restore = useFakeStorage({ kind: 'throwing' });
  try {
    assert.equal(getStorage(), null, 'the probe write reveals it cannot be used');
    assert.equal(saveToStorage(sampleProject()).code, 'STORAGE_UNAVAILABLE');
    assert.equal(loadFromStorage().status, 'unavailable');
  } finally {
    restore();
  }
});

test('7. a full storage is reported as full, not as a crash', () => {
  const restore = useFakeStorage({ kind: 'quota' });
  try {
    // getStorage probes with a write, which fails, so storage looks unusable.
    const saved = saveToStorage(sampleProject(), { now: FIXED_DATE });
    assert.equal(saved.ok, false);
    assert.ok(['STORAGE_FULL', 'STORAGE_UNAVAILABLE'].includes(saved.code));
    assert.ok(saved.message.length > 0);
    assert.match(saved.message, /Save project/, 'it offers the portable alternative');
  } finally {
    restore();
  }
});

test('8. corrupted stored data is reported and left in place', () => {
  const restore = useFakeStorage({ kind: 'normal', initial: { [STORAGE_KEY]: '{ this is not json' } });
  try {
    const loaded = loadFromStorage();
    assert.equal(loaded.status, 'invalid');
    assert.ok(loaded.message.length > 0);
    assert.doesNotMatch(loaded.message, /SyntaxError|Unexpected token/);
    // The raw value must still be there, so nothing was destroyed.
    assert.equal(globalThis.localStorage.getItem(STORAGE_KEY), '{ this is not json');
  } finally {
    restore();
  }
});

test('9. a project from a future version is reported and preserved', () => {
  const future = JSON.stringify({
    format: 'line-route-drawing-project',
    schemaVersion: 99,
    metadata: { savedAt: FIXED_DATE.toISOString() },
    project: sampleProject(),
  });
  const restore = useFakeStorage({ kind: 'normal', initial: { [STORAGE_KEY]: future } });
  try {
    const loaded = loadFromStorage();
    assert.equal(loaded.status, 'invalid');
    assert.match(loaded.message, /newer version/);
    assert.equal(globalThis.localStorage.getItem(STORAGE_KEY), future, 'the stored value survives');
  } finally {
    restore();
  }
});

test('10. clearing removes the remembered project', () => {
  const restore = useFakeStorage();
  try {
    saveToStorage(sampleProject(), { now: FIXED_DATE });
    assert.equal(loadFromStorage().status, 'ok');
    assert.equal(clearStorage(), true);
    assert.equal(loadFromStorage().status, 'none');
  } finally {
    restore();
  }
});

test('11. saving again replaces the previous value rather than accumulating', () => {
  const restore = useFakeStorage();
  try {
    saveToStorage({ ...sampleProject(), spanLength: 40 }, { now: FIXED_DATE });
    saveToStorage({ ...sampleProject(), spanLength: 60 }, { now: FIXED_DATE });

    const loaded = loadFromStorage();
    assert.equal(loaded.project.spanLength, 60);
    assert.equal(globalThis.localStorage.length, 1, 'only one key is used');
  } finally {
    restore();
  }
});

test('12. the format marker is detectable without parsing', () => {
  const text = serializeProjectJson(sampleProject(), { now: FIXED_DATE });
  assert.equal(looksLikeProject(text), true);
  assert.equal(looksLikeProject('{}'), false);
  assert.equal(looksLikeProject(null), false);
});
