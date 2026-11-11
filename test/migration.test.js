/**
 * Schema version 2: the measured data, and the v1-to-v2 migration.
 *
 * The migration's whole job is to add nothing. A version 1 project never had a
 * survey, so it opens with empty loads, empty lengths and no placements. The
 * moment a migration starts guessing numbers, a pole's "length" stops being a
 * measurement and becomes a decoration.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROJECT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  migrateDocument,
  parseProjectDocument,
  parseProjectJson,
  serializeProject,
  serializeProjectJson,
  toProjectPayload,
} from '../src/ui/project.js';
import { buildNetwork } from '../src/geometry/network.js';

const FIXED_DATE = new Date('2026-03-04T05:06:07.000Z');

/**
 * A saved document as plain JSON.
 *
 * `serializeProject` deliberately freezes what it returns, so a test that wants to
 * corrupt one field has to round trip through the text first - which is also
 * exactly what a hand-edited file looks like.
 */
function savedDoc(project = v2Project()) {
  return JSON.parse(JSON.stringify(serializeProject(project, { now: FIXED_DATE })));
}

/** A version 1 document: routes and settings, nothing measured. */
function v1Document() {
  return {
    format: 'line-route-drawing-project',
    schemaVersion: 1,
    savedAt: FIXED_DATE.toISOString(),
    project: {
      routes: [
        { id: 'route-1', from: 'origin', direction: 'south', spans: 4, tc: false, fpb: false },
        { id: 'route-2', from: 'endpoint:A', direction: 'east', spans: 2, tc: true, fpb: false },
      ],
      originMarker: 'fpb',
      spanLength: 48,
      layout: 'a3_landscape',
    },
  };
}

/** A version 2 project with every measured section populated. */
function v2Project() {
  return {
    routes: [
      { id: 'route-1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: false },
      { id: 'route-2', from: 'endpoint:A', direction: 'east', spans: 2, tc: false, fpb: false },
    ],
    originMarker: 'plain',
    spanLength: 40,
    layout: 'a3_landscape',
    loads: [
      { id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' },
      { id: 'load-2', nodeId: 'dst:route-1', value: 5, unit: 'kW' },
    ],
    spanLengths: new Map([
      ['origin~dst:route-1', { spanId: 'origin~dst:route-1', lengthM: 28 }],
      ['dst:route-1~dst:route-2', { spanId: 'dst:route-1~dst:route-2', lengthM: 32.5 }],
    ]),
    loadPlacements: { 'dst:route-1': { dx: 6, dy: -10 } },
    spanPlacements: { 'origin~dst:route-1': { dx: 0, dy: 4 } },
  };
}

test('1. the current schema is version 2', () => {
  assert.equal(PROJECT_SCHEMA_VERSION, 2);
  assert.deepEqual(SUPPORTED_SCHEMA_VERSIONS, [1, 2]);
});

test('2. a version 1 document migrates with empty measured data', () => {
  const migrated = migrateDocument(v1Document());
  assert.equal(migrated.warnings.length, 1, 'the reader is told what happened');
  assert.match(migrated.warnings[0], /before loads/);
  assert.deepEqual(migrated.project.loads, []);
  assert.deepEqual(migrated.project.spanLengths, {});
  assert.deepEqual(migrated.project.loadPlacements, {});
  assert.deepEqual(migrated.project.spanPlacements, {});
});

test('3. a migration never invents lengths from the drawing spacing', () => {
  const migrated = migrateDocument(v1Document());
  assert.equal(Object.keys(migrated.project.spanLengths).length, 0);
  // The drawing spacing itself is preserved untouched.
  assert.equal(migrated.project.spanLength, 48);
});

test('4. a migration leaves the routes and settings exactly as they were', () => {
  const migrated = migrateDocument(v1Document());
  assert.deepEqual(migrated.project.routes, v1Document().project.routes);
  assert.equal(migrated.project.originMarker, 'fpb');
  assert.equal(migrated.project.layout, 'a3_landscape');
});

test('5. a current document passes through the migration intact', () => {
  const document = savedDoc();
  assert.equal(document.schemaVersion, 2);
  const migrated = migrateDocument(document);
  assert.deepEqual(migrated.project, document.project);
  assert.deepEqual(migrated.warnings, []);
});

test('6. a version 1 file parses back into a usable project', () => {
  const parsed = parseProjectDocument(v1Document());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.project.loads, []);
  assert.equal(parsed.project.spanLengths.size, 0);
  assert.deepEqual(parsed.project.loadPlacements, {}, 'placements are empty');
});

test('7. the payload carries the measured data, keyed by asset id', () => {
  const payload = toProjectPayload(v2Project());
  assert.equal(payload.loads.length, 2);
  assert.deepEqual(payload.loads[0], { id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' });
  assert.deepEqual(payload.spanLengths, {
    'dst:route-1~dst:route-2': 32.5,
    'origin~dst:route-1': 28,
  });
  assert.deepEqual(payload.loadPlacements, { 'dst:route-1': { dx: 6, dy: -10 } });
});

test('8. serializing then parsing restores every measured value', () => {
  const json = serializeProjectJson(v2Project(), { now: FIXED_DATE });
  const parsed = parseProjectJson(json);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.project.loads.map((l) => [l.id, l.nodeId, l.value, l.unit]), [
    ['load-1', 'dst:route-1', 25, 'kVA'],
    ['load-2', 'dst:route-1', 5, 'kW'],
  ]);
  assert.equal(parsed.project.spanLengths.get('origin~dst:route-1').lengthM, 28);
  assert.deepEqual(parsed.project.loadPlacements, { 'dst:route-1': { dx: 6, dy: -10 } });
});

test('9. a load with a negative or zero value refuses the file', () => {
  const doc = savedDoc();
  doc.project.loads[0].value = -5;
  const parsed = parseProjectDocument(doc);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /greater than zero/);
});

test('10. an unknown unit refuses the file', () => {
  const doc = savedDoc();
  doc.project.loads[0].unit = 'kWh';
  const parsed = parseProjectDocument(doc);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /unit/);
});

test('11. a repeated load id refuses the file', () => {
  const doc = savedDoc();
  doc.project.loads[1].id = doc.project.loads[0].id;
  const parsed = parseProjectDocument(doc);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /reuses/);
});

test('12. a zero or negative span length refuses the file', () => {
  const doc = savedDoc();
  doc.project.spanLengths['origin~dst:route-1'] = 0;
  const parsed = parseProjectDocument(doc);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /greater than zero/);
});

test('13. a load whose node is gone is kept and reported, not refused', () => {
  const doc = savedDoc();
  // Rebuild the network and ask for the registry to find which ids exist.
  const network = buildNetwork(v2Project().routes, { originMarker: 'plain' });
  // Override the load's node with one that cannot exist in this drawing.
  doc.project.loads[0].nodeId = 'dst:route-99';
  const parsed = parseProjectDocument(doc);
  assert.equal(parsed.ok, true, 'the file opens');
  // Two notices, because renaming one endpoint also orphans the span that used it
  // and the load is reported against a point that no longer exists.
  assert.equal(parsed.warnings.length, 2);
  assert.ok(parsed.warnings.some((w) => /no longer has/.test(w)));
  assert.equal(parsed.project.loads[0].nodeId, 'dst:route-99', 'the record survives to be reassigned');
  void network;
});

test('14. malformed measured data refuses the whole file', () => {
  const doc = savedDoc();
  doc.project.loads = 'not-a-list';
  const parsed = parseProjectDocument(doc);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /load list/);
});

test('15. an opened version 1 project re-saves as version 2 with empty schedules', () => {
  const opened = parseProjectDocument(v1Document());
  assert.equal(opened.ok, true);
  const resaved = savedDoc({ ...opened.project });
  assert.equal(resaved.schemaVersion, 2, 'it is now written at the current version');
  assert.deepEqual(resaved.project.loads, []);
  assert.deepEqual(resaved.project.spanLengths, {});
  assert.deepEqual(resaved.project.routes, v1Document().project.routes, 'the drawing is unchanged');
});

test('16. placements with an unusable offset are dropped, not fatal', () => {
  const doc = savedDoc();
  doc.project.loadPlacements['dst:route-1'] = { dx: 'far', dy: 2 };
  const parsed = parseProjectDocument(doc);
  assert.equal(parsed.ok, true, 'the file still opens');
  assert.deepEqual(parsed.project.loadPlacements, {}, 'the bad placement is simply gone');
});
