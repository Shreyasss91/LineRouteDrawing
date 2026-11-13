/**
 * Annotation placement: the exact-output contract that the spatial index must not break.
 *
 * F13 replaced the exhaustive collision scan with a per-scene spatial index. A broad
 * phase is a silent failure mode - it never throws, it simply misses one obstacle and
 * moves one label - so "looks right" is not acceptance. The contract is stronger than
 * that: for all four performance-baseline drawings, every automatically placed annotation
 * keeps its identity, its chosen candidate, its exact centre, its collision count, its
 * manual flag, and the leader and arrowhead derived from the centre.
 *
 * The fixtures in `test/fixtures/placement/` were captured from the **unoptimized**
 * implementation, before any index existed. They are therefore a contract, not a snapshot
 * of the current code. Two kinds of check are applied:
 *
 *   - the full capture, byte for byte, for every drawing (preview profile), plus a digest
 *     per drawing for the export profiles, which use a different page frame;
 *   - a replay: the counts recorded in the capture are re-derived with the exhaustive scan
 *     in `test/support/exhaustive_collisions.mjs`. That keeps the oracle honest - if the
 *     oracle drifted from production geometry, the replay would fail rather than quietly
 *     agreeing with a wrong implementation.
 *
 * Nothing here asserts a timing. Wall-clock durations belong to the benchmark scripts,
 * which print numbers instead of failing builds.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { scenarios } from '../scripts/benchmark-datasets.mjs';
import { boxAround, measureBlock } from '../src/geometry/annotations.js';
import {
  CAPTURE_COLUMNS,
  buildSceneFor,
  canonicalPlacements,
  captureProject,
  parseRecord,
  placementLines,
  recordLines,
} from './support/placement_capture.mjs';
import { countCollisionsExhaustive } from './support/exhaustive_collisions.mjs';

const PROFILE_PAGE = ['pdf', 'svg', 'print'];

/** Read one committed capture. */
function golden(name) {
  return readFileSync(new URL(`./fixtures/placement/${name}.txt`, import.meta.url), 'utf8');
}

/** Read the export-profile digests. */
function exportDigests() {
  return JSON.parse(
    readFileSync(new URL('./fixtures/placement/export-digests.json', import.meta.url), 'utf8'),
  );
}

/** The record that differs first, or `null` when the two captures match. */
function firstDifference(expected, actual) {
  const a = recordLines(expected);
  const b = recordLines(actual);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return { index: i, expected: a[i] ?? '<missing>', actual: b[i] ?? '<missing>' };
  }
  return null;
}

/** The frame-relative centre the layout pass solved in. */
function frameCenter(record, padding) {
  return { x: Number(record.centerX) - padding, y: Number(record.centerY) - padding };
}

/**
 * Replay one drawing through the exhaustive oracle.
 *
 * Walks the capture in placement order, rebuilds the `taken` list exactly as the layer
 * built it, and re-derives each recorded collision count.
 */
function replayCollisions(project, capture) {
  const scene = buildSceneFor(project, 'preview');
  const layer = scene.annotations;
  const padding = scene.padding;
  const bounds = {
    width: scene.width - padding * 2,
    height: scene.height - padding * 2,
  };
  const records = recordLines(capture)
    .filter((line) => !line.startsWith('notice|') && !line.startsWith('completeness|'))
    .map(parseRecord);
  const taken = [];
  const results = [];
  for (const record of records) {
    const size = measureBlock(JSON.parse(record.lines), scene.config, Number(record.fontSize));
    const center = frameCenter(record, padding);
    const count = countCollisionsExhaustive(
      center,
      size,
      layer.obstacles,
      taken,
      bounds,
      scene.config.annotClearance,
    );
    results.push({ record, count, recorded: Number(record.collisions) });
    taken.push(boxAround(center, size));
  }
  return results;
}

test('every automatic placement in every benchmark drawing is unchanged', async (t) => {
  for (const s of scenarios()) {
    await t.test(`${s.name}: placement capture matches the pre-optimization fixture`, () => {
      const actual = captureProject(s.project);
      const expected = golden(s.name);
      const diff = firstDifference(expected, actual);
      assert.equal(
        diff,
        null,
        diff
          ? `${s.name} record ${diff.index} changed\n  expected: ${diff.expected}\n  actual:   ${diff.actual}`
          : '',
      );
    });
  }
});

test('the export profiles keep the same placements they had before the change', async (t) => {
  const digests = exportDigests();
  for (const s of scenarios()) {
    await t.test(`${s.name}: pdf, svg and print placements are unchanged`, () => {
      assert.ok(digests[s.name], `${s.name} has no recorded export digest`);
      for (const profile of PROFILE_PAGE) {
        const text = captureProject(s.project, profile);
        const digest = createHash('sha256').update(placementLines(text).join('\n')).digest('hex');
        assert.equal(
          digest,
          digests[s.name],
          `${s.name} ${profile} placements drifted from the pre-optimization digest`,
        );
      }
    });
  }
});

test('the exhaustive oracle reproduces every recorded collision count', async (t) => {
  for (const s of scenarios()) {
    await t.test(`${s.name}: replayed counts match the capture`, () => {
      const capture = golden(s.name);
      const results = replayCollisions(s.project, capture);
      assert.ok(results.length > 0, 'nothing replayed');
      for (const { record, count, recorded } of results) {
        assert.equal(
          count,
          recorded,
          `${record.id} @ candidate ${record.candidateIndex}: oracle says ${count}, capture says ${recorded}`,
        );
      }
    });
  }
});

test('the capture itself is complete enough to be evidence', async (t) => {
  for (const s of scenarios()) {
    await t.test(`${s.name}: records are unique, ordered and fully populated`, () => {
      const records = recordLines(golden(s.name));
      const seen = new Set();
      const annotations = records
        .filter((line) => !line.startsWith('notice|') && !line.startsWith('completeness|'))
        .map(parseRecord);
      for (const record of annotations) {
        assert.ok(record.id, 'a record has no identity');
        assert.equal(
          Object.values(record).length,
          CAPTURE_COLUMNS.length,
          `malformed record: ${record.id}`,
        );
        assert.ok(!seen.has(record.id), `duplicate identity ${record.id}`);
        seen.add(record.id);
        assert.ok(Number.isFinite(Number(record.centerX)), `${record.id} has no centre x`);
        assert.ok(Number.isFinite(Number(record.centerY)), `${record.id} has no centre y`);
        assert.ok(record.side, `${record.id} has no side`);
        assert.match(record.candidateIndex, /^\d+$/, `${record.id} has no candidate index`);
        assert.match(record.collisions, /^\d+$/, `${record.id} has no collision count`);
        assert.match(record.manual, /^(true|false)$/, `${record.id} has no manual flag`);
      }
      // A drawing whose labels all landed untouched would not exercise the parts of
      // the layout a spatial index can get wrong.
      assert.ok(
        annotations.some((r) => Number(r.collisions) > 0),
        `${s.name} captured no crowded placement`,
      );
      assert.ok(annotations.length >= 30, `${s.name} captured too few annotations`);
    });
  }
});

test('the annotated benchmark drawing is the one that exercises callouts', () => {
  const records = recordLines(golden('D-surveyed'))
    .filter((line) => !line.startsWith('notice|') && !line.startsWith('completeness|'))
    .map(parseRecord);
  assert.equal(records.filter((r) => r.kind === 'load').length, 50, 'load callout count changed');
  assert.equal(records.filter((r) => r.kind === 'span').length, 501, 'span label count changed');
  assert.equal(
    records.filter((r) => r.kind === 'span' && Number(r.collisions) > 0).length,
    501,
    'every span label in this drawing is crowded, which is what makes it the stress case',
  );
});

test('the annotated benchmark drawing really places its manual offsets', () => {
  const records = recordLines(golden('D-surveyed'))
    .filter((line) => !line.startsWith('notice|') && !line.startsWith('completeness|'))
    .map(parseRecord);
  const manualLoads = records.filter((r) => r.kind === 'load' && r.manual === 'true');
  const manualSpans = records.filter((r) => r.kind === 'span' && r.manual === 'true');
  assert.equal(manualLoads.length, 25, 'the manual load-offset count changed');
  assert.equal(manualSpans.length, 101, 'the manual span-offset count changed');
  // A manual offset is applied to the automatic choice, so it must still name a
  // candidate - losing that would break dragging after a reload.
  for (const record of [...manualLoads, ...manualSpans]) {
    assert.match(record.candidateIndex, /^\d+$/, `${record.id} lost its candidate index`);
  }
});

test('capturing the same drawing twice gives the same bytes', () => {
  for (const s of scenarios()) {
    const once = captureProject(s.project);
    const twice = captureProject(s.project);
    assert.equal(once, twice, `${s.name} is not deterministic`);
  }
});

test('the notice is captured for the preview and absent from the exports', () => {
  const s = scenarios()[2];
  const preview = canonicalPlacements(buildSceneFor(s.project, 'preview'), { includeNotice: true });
  const pdf = canonicalPlacements(buildSceneFor(s.project, 'pdf'), { includeNotice: true });
  assert.match(preview, /^notice\|notice:completeness\|/m);
  assert.match(pdf, /^notice\|none$/m);
});
