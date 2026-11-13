/**
 * Unknown fields in a project file are refused, not ignored.
 *
 * The defect these tests close (finding F5) was quiet: `project.somethingNew = 123`
 * parsed `ok: true` with no warning, so a misspelt field, a renamed field, or a value
 * written by a branch that was never merged would simply disappear the next time the
 * project was saved. The user's only copy of that data would be gone, and nothing would
 * have been reported.
 *
 * Three rules are protected here:
 *
 *   - Every fixed-shape object has an enumerated list of accepted fields, and anything
 *     else is a refusal carrying the exact JSON path.
 *   - Maps keyed by asset id are NOT fixed shape: their keys are data, so any key is
 *     accepted at `spanLengths`, `loadPlacements`, `spanPlacements` and
 *     `nodeDesignations`. Only the shape of each value is checked.
 *   - The check is version-aware: a document is judged against the field contract of ITS
 *     OWN version, then migrated, then judged against the current one. An old file is
 *     never refused for lacking fields that did not exist yet, and a current file cannot
 *     arrive with fields that no longer do.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROJECT_FORMAT,
  PROJECT_SCHEMA_VERSION,
  parseProjectDocument,
  parseProjectJson,
  serializeProject,
  serializeProjectJson,
} from '../src/ui/project.js';

const FIXED_DATE = new Date('2026-03-04T05:06:07.000Z');

/** A small current-version project with one route, one load and one placement. */
function currentProject() {
  return {
    routes: [
      { id: 'route-1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: false },
    ],
    originMarker: 'plain',
    spanLength: 40,
    layout: 'a4_landscape',
    loads: [{ id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' }],
    spanLengths: new Map([['origin~dst:route-1', { spanId: 'origin~dst:route-1', lengthM: 30 }]]),
    loadPlacements: { 'dst:route-1': { dx: 6, dy: -10, candidateIndex: 1 } },
    spanPlacements: { 'origin~dst:route-1': { dx: 0, dy: 4 } },
    nodeDesignations: new Map([['dst:route-1', 'A1']]),
  };
}

/** The current project as a plain document, ready to be tampered with. */
function currentDoc() {
  return JSON.parse(serializeProjectJson(currentProject(), { now: FIXED_DATE }));
}

test('1. a current project with only known fields is accepted', () => {
  const parsed = parseProjectDocument(currentDoc());
  assert.equal(parsed.ok, true, parsed.message);
});

test('2. an unknown field on the project is refused, naming its exact path', () => {
  // The original F5 reproduction, verbatim.
  const document = currentDoc();
  document.project.somethingNew = 123;
  const parsed = parseProjectDocument(document);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNKNOWN_PROJECT_FIELD');
  assert.match(parsed.message, /document\.project\.somethingNew/);
  // The message must also say what is allowed there, so the fix is obvious.
  assert.match(parsed.message, /spanLength/);
});

test('3. an unknown field on the envelope is refused', () => {
  const document = currentDoc();
  document.savedAt = FIXED_DATE.toISOString();
  const parsed = parseProjectDocument(document);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNKNOWN_PROJECT_FIELD');
  assert.match(parsed.message, /document\.savedAt/);
});

test('4. an unknown field inside metadata is refused', () => {
  const document = currentDoc();
  document.metadata.buildNumber = 7;
  const parsed = parseProjectDocument(document);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /document\.metadata\.buildNumber/);
});

test('5. an unknown field on a route is refused, naming the row', () => {
  const document = currentDoc();
  document.project.routes[0].spanns = 2;
  const parsed = parseProjectDocument(document);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /document\.project\.routes\[0\]\.spanns/);
  // A misspelling is reported as the unknown name it is, not as a missing value
  // somewhere else - otherwise the user cannot see what they actually got wrong.
  assert.doesNotMatch(parsed.message, /does not have a span count/);
});

test('6. an unknown field on a load is refused, naming the row', () => {
  const document = currentDoc();
  document.project.loads[0].amps = 3;
  const parsed = parseProjectDocument(document);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /document\.project\.loads\[0\]\.amps/);
});

test('7. an unknown field inside a stored placement is refused, naming the key', () => {
  const document = currentDoc();
  document.project.loadPlacements['dst:route-1'].scale = 2;
  const parsed = parseProjectDocument(document);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /loadPlacements\["dst:route-1"\]\.scale/);

  const spanDoc = currentDoc();
  spanDoc.project.spanPlacements['origin~dst:route-1'].zoom = 2;
  const spanParsed = parseProjectDocument(spanDoc);
  assert.equal(spanParsed.ok, false);
  assert.match(spanParsed.message, /spanPlacements\["origin~dst:route-1"\]\.zoom/);
});

test('8. the dynamic maps accept any asset id as a key', () => {
  // The project's own ids, a coordinate spelling, and an id this drawing does not have.
  // Keys are data: refusing an unfamiliar one would break reconciliation, which exists
  // precisely so an orphaned record can be kept and reassigned.
  const document = currentDoc();
  document.project.nodeDesignations['0,-2'] = 'B2';
  document.project.nodeDesignations['dst:gone'] = 'Z9';
  document.project.loadPlacements['dst:gone'] = { dx: 1, dy: 2 };
  document.project.spanLengths['origin~dst:gone'] = 12.5;
  const parsed = parseProjectDocument(document);
  assert.equal(parsed.ok, true, parsed.message);

  const designations = parsed.project.nodeDesignations;
  assert.equal(designations.get('0,-2'), 'B2');
  assert.equal(designations.get('dst:gone'), 'Z9');
  assert.equal(parsed.project.spanLengths.get('origin~dst:gone').lengthM, 12.5);
});

test('9. a historical document is judged against its own version, not the current one', () => {
  // A version 1 file: the save time lived on the envelope, and none of the measured data
  // existed. Judging it against version 3's contract would refuse every real v1 file.
  const v1 = {
    format: PROJECT_FORMAT,
    schemaVersion: 1,
    savedAt: FIXED_DATE.toISOString(),
    project: {
      routes: [
        { id: 'route-1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: false },
      ],
      originMarker: 'plain',
      spanLength: 40,
      layout: 'a4_landscape',
    },
  };
  const parsed = parseProjectDocument(v1);
  assert.equal(parsed.ok, true, parsed.message);

  // A version 2 file with the measured data but no point names.
  const v2 = {
    format: PROJECT_FORMAT,
    schemaVersion: 2,
    savedAt: FIXED_DATE.toISOString(),
    project: {
      ...v1.project,
      loads: [],
      spanLengths: {},
      loadPlacements: {},
      spanPlacements: {},
    },
  };
  assert.equal(parseProjectDocument(v2).ok, true);
});

test('10. a version 1 file may still not carry a field from a later version', () => {
  // Being version-aware cuts both ways: an old document is not judged against today's
  // contract, but it also may not smuggle in a field that version never had.
  const v1 = {
    format: PROJECT_FORMAT,
    schemaVersion: 1,
    savedAt: FIXED_DATE.toISOString(),
    project: {
      routes: [
        { id: 'route-1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: false },
      ],
      originMarker: 'plain',
      spanLength: 40,
      layout: 'a4_landscape',
      nodeDesignations: {},
    },
  };
  const parsed = parseProjectDocument(v1);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNKNOWN_PROJECT_FIELD');
  assert.match(parsed.message, /document\.project\.nodeDesignations/);
});

test('11. a future version is still refused, and for the version reason', () => {
  const document = currentDoc();
  document.schemaVersion = PROJECT_SCHEMA_VERSION + 1;
  document.project.somethingNew = 1;
  const parsed = parseProjectDocument(document);
  assert.equal(parsed.ok, false);
  // The version gate runs first: an unreadable version must not be reported as a field
  // problem, or the user would be told to fix the wrong thing.
  assert.equal(parsed.code, 'FUTURE_VERSION');
});

test('12. a refusal is all-or-nothing and leaves the parsed text untouched', () => {
  const document = currentDoc();
  document.project.somethingNew = 123;
  const text = JSON.stringify(document, null, 2);
  const before = JSON.stringify(docProbe(document));
  const parsed = parseProjectJson(text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.project, undefined, 'nothing is handed back on a refusal');
  // The document the caller supplied is not mutated either.
  assert.equal(JSON.stringify(docProbe(document)), before);
});

test('13. the serializer writes only known fields, so a round trip never trips the rule', () => {
  for (const version of [1, 2, 3]) {
    const document = JSON.parse(serializeProjectJson(currentProject(), { now: FIXED_DATE }));
    document.schemaVersion = version;
    if (version < 3) {
      // Strip what did not exist yet, in the shape that version wrote.
      document.savedAt = document.metadata.savedAt;
      delete document.metadata;
      delete document.project.nodeDesignations;
      // The two export switches arrived with version 3 as well.
      delete document.project.exportLoads;
      delete document.project.exportLengths;
      if (version === 1) {
        delete document.project.loads;
        delete document.project.spanLengths;
        delete document.project.loadPlacements;
        delete document.project.spanPlacements;
      }
    }
    const parsed = parseProjectDocument(document);
    assert.equal(parsed.ok, true, `version ${version}: ${parsed.message}`);
  }
});

test('14. an unreadable stored project is reported and preserved, not overwritten', async () => {
  // The storage layer turns a refusal into `invalid` plus the original text, which is what
  // pauses autosaving. A stricter reader must not weaken that.
  const { STORAGE_KEY } = await import('../src/ui/storage.js');
  const store = new Map();
  const fakeStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  globalThis.localStorage = fakeStorage;

  const document = currentDoc();
  document.project.somethingNew = 123;
  const raw = JSON.stringify(document, null, 2);
  fakeStorage.setItem(STORAGE_KEY, raw);

  const { loadFromStorage } = await import('../src/ui/storage.js');
  const result = loadFromStorage();
  assert.equal(result.status, 'invalid');
  assert.match(result.message, /document\.project\.somethingNew/);
  assert.equal(result.raw, raw, 'the stored text is handed back so it can be kept');
  assert.equal(fakeStorage.getItem(STORAGE_KEY), raw, 'and it is still in storage');
  delete globalThis.localStorage;
});

/** A deep copy, so a mutation check can compare before and after. */
function docProbe(value) {
  return JSON.parse(JSON.stringify(value));
}
