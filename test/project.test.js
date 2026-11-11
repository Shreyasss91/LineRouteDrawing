/**
 * Project persistence: the versioned file format and its validation.
 *
 * The rules these tests protect:
 *
 *   - A project stores what the user authored and nothing that can be derived.
 *   - A file is fully validated before anything is applied, so a bad file can
 *     never leave the drawing half-replaced.
 *   - A project from a newer version is refused rather than guessed at, and the
 *     user's current project is not touched.
 *   - Saving and loading is a faithful round trip, down to route identity.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROJECT_FORMAT,
  PROJECT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  migrateDocument,
  parseProjectDocument,
  parseProjectJson,
  projectFileName,
  serializeProject,
  serializeProjectJson,
  toProjectPayload,
} from '../src/ui/project.js';
import { buildNetwork } from '../src/geometry/network.js';

/** A project with both marker kinds and non-default settings. */
function sampleProject() {
  return {
    routes: [
      { id: 'route-1', from: 'origin', direction: 'south', spans: 4, tc: false, fpb: false },
      { id: 'route-2', from: 'endpoint:A', direction: 'east', spans: 2, tc: true, fpb: false },
      { id: 'route-3', from: 'tc:1', direction: 'south', spans: 2, tc: false, fpb: true },
    ],
    originMarker: 'fpb',
    spanLength: 48,
    layout: 'a3_landscape',
  };
}

const FIXED_DATE = new Date('2026-03-04T05:06:07.000Z');

test('1. serialization produces the versioned document', () => {
  const document = serializeProject(sampleProject(), { now: FIXED_DATE });
  assert.equal(document.format, PROJECT_FORMAT);
  assert.equal(document.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(document.metadata.savedAt, '2026-03-04T05:06:07.000Z');
  assert.equal(document.project.routes.length, 3);
  assert.equal(document.project.originMarker, 'fpb');
  assert.equal(document.project.spanLength, 48);
  assert.equal(document.project.layout, 'a3_landscape');
});

test('2. the payload carries only what the user authored', () => {
  const payload = toProjectPayload(sampleProject());
  // Schema version 2 adds the measured data alongside the routes and settings.
  assert.deepEqual(Object.keys(payload).sort(), [
    'layout',
    'loadPlacements',
    'loads',
    'originMarker',
    'routes',
    'spanLength',
    'spanLengths',
    'spanPlacements',
  ]);
  assert.deepEqual(Object.keys(payload.routes[0]).sort(), [
    'direction',
    'fpb',
    'from',
    'id',
    'spans',
    'tc',
  ]);

  // Derived data must never appear: it would be a second source of truth.
  const text = serializeProjectJson(sampleProject(), { now: FIXED_DATE });
  for (const forbidden of ['edges', 'nodes', 'graph', 'scene', 'bbox', 'viewBox', 'position']) {
    assert.ok(!text.includes(`"${forbidden}"`), `the file must not contain ${forbidden}`);
  }
});

test('3. serialization is deterministic', () => {
  const a = serializeProjectJson(sampleProject(), { now: FIXED_DATE });
  const b = serializeProjectJson(sampleProject(), { now: FIXED_DATE });
  assert.equal(a, b, 'the same project always produces the same text');

  // Key order is fixed, not incidental.
  const firstKeys = Object.keys(JSON.parse(a).project);
  assert.deepEqual(firstKeys, [
    'routes',
    'originMarker',
    'spanLength',
    'layout',
    'loads',
    'spanLengths',
    'loadPlacements',
    'spanPlacements',
  ]);
});

test('4. deserialization round-trips every field', () => {
  const original = sampleProject();
  const text = serializeProjectJson(original, { now: FIXED_DATE });
  const parsed = parseProjectJson(text);

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.project.routes, original.routes);
  assert.equal(parsed.project.originMarker, original.originMarker);
  assert.equal(parsed.project.spanLength, original.spanLength);
  assert.equal(parsed.project.layout, original.layout);
});

test('5. route identifiers are preserved exactly', () => {
  const parsed = parseProjectJson(serializeProjectJson(sampleProject(), { now: FIXED_DATE }));
  assert.deepEqual(
    parsed.project.routes.map((r) => r.id),
    ['route-1', 'route-2', 'route-3'],
  );
});

test('6. TC and FPB destination flags survive the round trip', () => {
  const parsed = parseProjectJson(serializeProjectJson(sampleProject(), { now: FIXED_DATE }));
  assert.deepEqual(
    parsed.project.routes.map((r) => ({ tc: r.tc, fpb: r.fpb })),
    [
      { tc: false, fpb: false },
      { tc: true, fpb: false },
      { tc: false, fpb: true },
    ],
  );
});

test('7. the Origin marker survives the round trip for all three kinds', () => {
  for (const originMarker of ['plain', 'tc', 'fpb']) {
    const project = { ...sampleProject(), originMarker };
    const parsed = parseProjectJson(serializeProjectJson(project, { now: FIXED_DATE }));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.project.originMarker, originMarker);
  }
});

test('8. span spacing survives the round trip', () => {
  for (const spanLength of [39, 40, 52, 120]) {
    const project = { ...sampleProject(), spanLength };
    const parsed = parseProjectJson(serializeProjectJson(project, { now: FIXED_DATE }));
    assert.equal(parsed.project.spanLength, spanLength);
  }
});

test('9. page layout survives the round trip', () => {
  for (const layout of ['a4_landscape', 'a4_portrait', 'a3_landscape', 'letter_landscape']) {
    const project = { ...sampleProject(), layout };
    const parsed = parseProjectJson(serializeProjectJson(project, { now: FIXED_DATE }));
    assert.equal(parsed.ok, true, `${layout} is accepted`);
    assert.equal(parsed.project.layout, layout);
  }
});

test('10. invalid JSON is refused with an actionable message', () => {
  for (const text of ['{ not json', 'null', '', '   ', '[1,2,3', '{"a":']) {
    const parsed = parseProjectJson(text);
    assert.equal(parsed.ok, false, `${JSON.stringify(text)} is refused`);
    assert.ok(parsed.message.length > 0);
    assert.doesNotMatch(parsed.message, /undefined|SyntaxError|Unexpected token/);
  }
});

test('11. a missing or wrong format identifier is refused', () => {
  const noFormat = { schemaVersion: 1, project: sampleProject() };
  const wrongFormat = { format: 'something-else', schemaVersion: 1, project: sampleProject() };
  const notAnObject = [1, 2, 3];

  for (const document of [noFormat, wrongFormat, notAnObject]) {
    const parsed = parseProjectDocument(document);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.message.includes('project file'), 'it says which file to choose');
  }
});

test('12. missing required fields are refused, naming the problem', () => {
  const base = {
    format: PROJECT_FORMAT,
    schemaVersion: 1,
    project: { routes: [], originMarker: 'plain', spanLength: 40, layout: 'a4_landscape' },
  };

  // Each patch removes or corrupts exactly one required part.
  const cases = [
    [{ routes: undefined }, 'MISSING_ROUTES'],
    [{ routes: 'nope' }, 'MISSING_ROUTES'],
    [{ originMarker: undefined }, 'BAD_ORIGIN_MARKER'],
    [{ originMarker: 'triangle' }, 'BAD_ORIGIN_MARKER'],
    [{ spanLength: undefined }, 'BAD_SPAN_LENGTH'],
    [{ spanLength: 'wide' }, 'BAD_SPAN_LENGTH'],
    [{ spanLength: 0 }, 'BAD_SPAN_LENGTH'],
    [{ layout: undefined }, 'BAD_LAYOUT'],
    [{ layout: 'a9_panorama' }, 'BAD_LAYOUT'],
  ];

  for (const [patch, expectedCode] of cases) {
    const document = { ...base, project: { ...base.project, ...patch } };
    const parsed = parseProjectDocument(document);
    assert.equal(parsed.ok, false, `${JSON.stringify(patch)} is refused`);
    assert.equal(parsed.code, expectedCode, `${JSON.stringify(patch)} reports ${expectedCode}`);
    assert.ok(parsed.message.length > 0);
  }

  // A document with no project object at all.
  assert.equal(parseProjectDocument({ ...base, project: undefined }).ok, false);

  // A route missing a field.
  const missingField = {
    format: PROJECT_FORMAT,
    schemaVersion: 1,
    project: {
      routes: [{ id: 'route-1', from: 'origin', direction: 'south' }],
      originMarker: 'plain',
      spanLength: 40,
      layout: 'a4_landscape',
    },
  };
  const parsed = parseProjectDocument(missingField);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /Route 1/, 'it names the row at fault');
});

test('13. invalid endpoint dependencies are refused before anything is applied', () => {
  const document = {
    format: PROJECT_FORMAT,
    schemaVersion: 1,
    project: {
      // Route 2 starts from an endpoint no earlier route created.
      routes: [
        { id: 'route-1', from: 'origin', direction: 'south', spans: 1, tc: false, fpb: false },
        { id: 'route-2', from: 'endpoint:Z', direction: 'east', spans: 1, tc: false, fpb: false },
      ],
      originMarker: 'plain',
      spanLength: 40,
      layout: 'a4_landscape',
    },
  };
  const parsed = parseProjectDocument(document);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'INVALID_DEPENDENCIES');
  assert.match(parsed.message, /Route 2/, 'it names the row that cannot connect');
});

test('14. invalid directions, span counts and markers are refused', () => {
  const base = (route) => ({
    format: PROJECT_FORMAT,
    schemaVersion: 1,
    project: {
      routes: [{ id: 'route-1', from: 'origin', ...route }],
      originMarker: 'plain',
      spanLength: 40,
      layout: 'a4_landscape',
    },
  });

  const bad = [
    { direction: 'upwards', spans: 1, tc: false, fpb: false },
    { direction: 'south', spans: 0, tc: false, fpb: false },
    { direction: 'south', spans: 1.5, tc: false, fpb: false },
    { direction: 'south', spans: -2, tc: false, fpb: false },
    { direction: 'south', spans: 1, tc: true, fpb: true },
    { direction: 'south', spans: 1, tc: 'yes', fpb: false },
  ];

  for (const route of bad) {
    const parsed = parseProjectDocument(base(route));
    assert.equal(parsed.ok, false, `${JSON.stringify(route)} is refused`);
    assert.match(parsed.message, /Route 1/);
  }
});

test('15. an unsupported future schema version is refused without touching the project', () => {
  const document = {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION + 1,
    project: sampleProject(),
  };
  const parsed = parseProjectDocument(document);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'FUTURE_VERSION');
  assert.ok(parsed.message.includes(String(PROJECT_SCHEMA_VERSION)), 'it names what this build reads');
  assert.ok(
    parsed.message.includes(String(PROJECT_SCHEMA_VERSION + 1)),
    'it names what the file needs',
  );
  assert.match(parsed.message, /not been changed/, 'it reassures that the drawing is untouched');

  // A version below the supported range is also refused rather than guessed at.
  const old = { ...document, schemaVersion: 0 };
  assert.equal(parseProjectDocument(old).ok, false);
});

test('16. the migration point exists and passes a current document through intact', () => {
  // Version 1 is still readable; version 2 is what this build writes.
  assert.deepEqual(SUPPORTED_SCHEMA_VERSIONS, [1, 2]);

  const document = serializeProject(sampleProject(), { now: FIXED_DATE });
  const migrated = migrateDocument(document);
  assert.deepEqual(migrated.project, document.project);
  assert.deepEqual(migrated.warnings, []);
});

test('17. identifier collisions and malformed rows are refused', () => {
  const document = {
    format: PROJECT_FORMAT,
    schemaVersion: 1,
    project: {
      routes: [
        { id: 'same', from: 'origin', direction: 'south', spans: 1, tc: false, fpb: false },
        { id: 'same', from: 'origin', direction: 'east', spans: 1, tc: false, fpb: false },
      ],
      originMarker: 'plain',
      spanLength: 40,
      layout: 'a4_landscape',
    },
  };
  const parsed = parseProjectDocument(document);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /reuses the identifier/);
});

test('18. a valid project rebuilds the same network as the live model', () => {
  const project = sampleProject();
  const direct = buildNetwork(project.routes, { originMarker: project.originMarker });
  assert.equal(direct.ok, true);

  const parsed = parseProjectJson(serializeProjectJson(project, { now: FIXED_DATE }));
  const rebuilt = buildNetwork(parsed.project.routes, {
    originMarker: parsed.project.originMarker,
  });

  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.graph.edges.size, direct.graph.edges.size, 'same topology');
  assert.equal(rebuilt.graph.nodes.size, direct.graph.nodes.size);
  assert.equal(rebuilt.tcCount, direct.tcCount);
  assert.equal(rebuilt.fpbCount, direct.fpbCount);
  assert.deepEqual(rebuilt.boundingBox, direct.boundingBox);
  // The same endpoint ids, so route references still resolve.
  assert.deepEqual(
    rebuilt.endpoints.map((e) => e.id),
    direct.endpoints.map((e) => e.id),
  );
});

test('19. an empty project is a valid project', () => {
  const empty = { routes: [], originMarker: 'plain', spanLength: 40, layout: 'a4_landscape' };
  const text = serializeProjectJson(empty, { now: FIXED_DATE });
  const parsed = parseProjectJson(text);
  assert.equal(parsed.ok, true, 'clearing is a state that can be saved and reopened');
  assert.deepEqual(parsed.project.routes, []);
  assert.equal(parsed.project.originMarker, 'plain');
});

test('20. the file name is predictable', () => {
  assert.equal(projectFileName(), 'line-route-project.json');
});

test('21. an Origin that is itself a marker is restored with its dependencies', () => {
  const project = {
    routes: [
      { id: 'route-1', from: 'origin', direction: 'south', spans: 3, tc: true, fpb: false },
      { id: 'route-2', from: 'tc:1', direction: 'east', spans: 2, tc: false, fpb: true },
    ],
    originMarker: 'fpb',
    spanLength: 40,
    layout: 'a4_landscape',
  };
  const parsed = parseProjectJson(serializeProjectJson(project, { now: FIXED_DATE }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.project.originMarker, 'fpb');

  const network = buildNetwork(parsed.project.routes, {
    originMarker: parsed.project.originMarker,
  });
  assert.equal(network.ok, true);
  assert.equal(network.originMarker, 'fpb');
  assert.equal(network.tcCount, 1);
  assert.equal(network.fpbCount, 1);
  // The route that started from the TC point still resolves to the same node.
  assert.equal(network.routes[1].destinationId, 'fpb:1');
});

test('22. multiple TC and FPB destinations keep their identities', () => {
  const project = {
    routes: [
      { id: 'route-1', from: 'origin', direction: 'south', spans: 1, tc: true, fpb: false },
      { id: 'route-2', from: 'origin', direction: 'east', spans: 2, tc: true, fpb: false },
      { id: 'route-3', from: 'origin', direction: 'north', spans: 1, tc: false, fpb: true },
      { id: 'route-4', from: 'origin', direction: 'west', spans: 2, tc: false, fpb: true },
    ],
    originMarker: 'plain',
    spanLength: 40,
    layout: 'a4_landscape',
  };
  const parsed = parseProjectJson(serializeProjectJson(project, { now: FIXED_DATE }));
  assert.equal(parsed.ok, true);

  const network = buildNetwork(parsed.project.routes);
  assert.equal(network.tcCount, 2);
  assert.equal(network.fpbCount, 2);
  const tcIds = network.endpoints.filter((e) => e.kind === 'tc').map((e) => e.id).sort();
  const fpbIds = network.endpoints.filter((e) => e.kind === 'fpb').map((e) => e.id).sort();
  assert.deepEqual(tcIds, ['tc:1', 'tc:2']);
  assert.deepEqual(fpbIds, ['fpb:1', 'fpb:2']);
});
