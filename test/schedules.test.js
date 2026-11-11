/**
 * Load and span-length data models.
 *
 * Two rules these tests pin down, because both are easy to break by accident:
 *
 *   - A load is never converted or summed. 25 kVA, 5 kW and 12 HP on one pole are
 *     three records that come back exactly as typed.
 *   - A physical length is not the drawing's spacing. Changing a measured length
 *     moves nothing, and the default-length shortcut never overwrites a number
 *     somebody measured by hand.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LOAD_UNIT,
  LOAD_UNITS,
  SPAN_UNIT,
  addLoad,
  applyDefaultLength,
  clearSpanLength,
  createLoadSchedule,
  createSpanLengths,
  formatSpanLength,
  isLoadEligible,
  loadCalloutLines,
  loadsForNode,
  measureCompleteness,
  nextLoadId,
  normalizeUnit,
  parseLoadValue,
  parseSpanLength,
  reassignLoad,
  removeLoad,
  removeLoadsForNode,
  reserveLoadId,
  setSpanLength,
  spanLengthOf,
  splitUnresolved,
  updateLoad,
} from '../src/data/schedules.js';

/* ------------------------------------------------------------------ */
/* Load records                                                        */
/* ------------------------------------------------------------------ */

test('1. a load is recorded against a node asset id', () => {
  const result = addLoad(createLoadSchedule(), { nodeId: 'dst:r1', value: 25 });
  assert.equal(result.ok, true);
  assert.equal(result.loads.length, 1);
  assert.deepEqual(result.loads[0], {
    id: result.loads[0].id,
    nodeId: 'dst:r1',
    value: 25,
    unit: 'kVA',
  });
});

test('2. the default unit is kVA', () => {
  assert.equal(DEFAULT_LOAD_UNIT, 'kVA');
  const { loads } = addLoad(createLoadSchedule(), { nodeId: 'dst:r1', value: 3 });
  assert.equal(loads[0].unit, 'kVA');
});

test('3. every supported unit is accepted', () => {
  assert.deepEqual([...LOAD_UNITS], ['kVA', 'kW', 'kVAr', 'HP']);
  for (const unit of LOAD_UNITS) {
    const result = addLoad(createLoadSchedule(), { nodeId: 'dst:r1', value: 10, unit });
    assert.equal(result.ok, true, `${unit} is accepted`);
    assert.equal(result.loads[0].unit, unit);
  }
});

test('4. units are matched without case sensitivity', () => {
  assert.equal(normalizeUnit('kva'), 'kVA');
  assert.equal(normalizeUnit('KVA'), 'kVA');
  assert.equal(normalizeUnit(' hp '), 'HP');
  assert.equal(normalizeUnit('kvar'), 'kVAr');
  assert.equal(normalizeUnit('amps'), null, 'an unknown unit is refused');
});

test('5. an unknown unit is refused rather than guessed at', () => {
  const result = addLoad(createLoadSchedule(), { nodeId: 'dst:r1', value: 4, unit: 'kWh' });
  assert.equal(result.ok, false);
  assert.match(result.message, /kVA, kW, kVAr, HP/);
});

test('6. several loads with different units stay separate records', () => {
  // The worked example from the requirement: an FPB holding 25 kVA, 5 kW and 12 HP.
  let loads = createLoadSchedule();
  loads = addLoad(loads, { nodeId: 'dst:fpb', value: 25, unit: 'kVA' }).loads;
  loads = addLoad(loads, { nodeId: 'dst:fpb', value: 5, unit: 'kW' }).loads;
  loads = addLoad(loads, { nodeId: 'dst:fpb', value: 12, unit: 'HP' }).loads;

  assert.equal(loads.length, 3, 'three records, not one total');
  assert.equal(new Set(loads.map((l) => l.id)).size, 3, 'each has its own id');

  // Nothing was converted: the values are exactly what went in.
  assert.deepEqual(
    loads.map((l) => [l.value, l.unit]),
    [
      [25, 'kVA'],
      [5, 'kW'],
      [12, 'HP'],
    ],
  );
});

test('7. a load value must be a positive number', () => {
  for (const bad of [0, -1, 'zero', '', null, NaN, Infinity]) {
    const result = addLoad(createLoadSchedule(), { nodeId: 'dst:r1', value: bad });
    assert.equal(result.ok, false, `${String(bad)} is refused`);
  }
  assert.equal(parseLoadValue('12.5').value, 12.5, 'decimals are accepted');
});

test('8. the callout shows one line per record, never a total', () => {
  let loads = createLoadSchedule();
  loads = addLoad(loads, { nodeId: 'dst:fpb', value: 25, unit: 'kVA' }).loads;
  loads = addLoad(loads, { nodeId: 'dst:fpb', value: 5, unit: 'kW' }).loads;
  loads = addLoad(loads, { nodeId: 'dst:fpb', value: 12, unit: 'HP' }).loads;

  assert.deepEqual(loadCalloutLines(loads, 'dst:fpb'), ['25 kVA', '5 kW', '12 HP']);
  // No summed line appears, because kVA and HP cannot be added.
  assert.equal(loadCalloutLines(loads, 'dst:fpb').length, 3);
});

test('9. loads belong to their node and nowhere else', () => {
  let loads = createLoadSchedule();
  loads = addLoad(loads, { nodeId: 'dst:r1', value: 10 }).loads;
  loads = addLoad(loads, { nodeId: 'dst:r2', value: 20 }).loads;

  assert.equal(loadsForNode(loads, 'dst:r1').length, 1);
  assert.equal(loadsForNode(loads, 'dst:r1')[0].value, 10);
  assert.equal(loadsForNode(loads, 'dst:r2')[0].value, 20);
  assert.equal(loadsForNode(loads, 'dst:r3').length, 0);
});

test('10. editing a value does not move the load', () => {
  let loads = addLoad(createLoadSchedule(), { nodeId: 'dst:r1', value: 10 }).loads;
  const id = loads[0].id;
  const result = updateLoad(loads, id, { value: 15, unit: 'kW' });
  assert.equal(result.ok, true);
  assert.equal(result.loads[0].id, id, 'the id is unchanged');
  assert.equal(result.loads[0].nodeId, 'dst:r1', 'it stays on the same point');
  assert.equal(result.loads[0].value, 15);
  assert.equal(result.loads[0].unit, 'kW');
});

test('11. moving a load is a separate, explicit action', () => {
  let loads = addLoad(createLoadSchedule(), { nodeId: 'dst:r1', value: 10 }).loads;
  const id = loads[0].id;
  const result = reassignLoad(loads, id, 'dst:r2');
  assert.equal(result.ok, true);
  assert.equal(result.loads[0].nodeId, 'dst:r2');
  assert.equal(result.loads[0].id, id, 'reassigning keeps the record identity');
});

test("12. a record can be removed, and a node's records removed together", () => {
  let loads = createLoadSchedule();
  loads = addLoad(loads, { nodeId: 'dst:r1', value: 10 }).loads;
  loads = addLoad(loads, { nodeId: 'dst:r1', value: 20 }).loads;
  loads = addLoad(loads, { nodeId: 'dst:r2', value: 30 }).loads;

  const oneRemoved = removeLoad(loads, loads[0].id);
  assert.equal(oneRemoved.length, 2, 'only one record went');
  assert.equal(oneRemoved.filter((l) => l.nodeId === 'dst:r2').length, 1, 'the other node is intact');

  const nodeCleared = removeLoadsForNode(loads, 'dst:r1');
  assert.equal(nodeCleared.length, 1);
  assert.equal(nodeCleared[0].nodeId, 'dst:r2');
});

test('13. load ids are unique and are not derived from the node', () => {
  let loads = createLoadSchedule();
  loads = addLoad(loads, { nodeId: 'dst:r1', value: 1 }).loads;
  loads = addLoad(loads, { nodeId: 'dst:r1', value: 2 }).loads;
  const ids = loads.map((l) => l.id);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) {
    assert.ok(!id.includes('dst:r1'), `${id} does not embed the node`);
  }
});

test('14. restored ids raise the counter so a new id cannot collide', () => {
  reserveLoadId('load-500');
  const fresh = nextLoadId();
  assert.notEqual(fresh, 'load-500');
  const numeric = Number(/^load-(\d+)$/.exec(fresh)[1]);
  assert.ok(numeric > 500, `${fresh} is past the restored id`);
});

test('15. only poles, FPBs and a load-bearing Origin are eligible', () => {
  assert.equal(isLoadEligible('pole'), true);
  assert.equal(isLoadEligible('fpb'), true);
  assert.equal(isLoadEligible('origin'), true);
  assert.equal(isLoadEligible('tc'), false, 'a TC point is out of scope');
});

/* ------------------------------------------------------------------ */
/* Span lengths                                                        */
/* ------------------------------------------------------------------ */

test('16. one span gets one length', () => {
  const result = setSpanLength(createSpanLengths(), 'origin~dst:r1', 28);
  assert.equal(result.ok, true);
  assert.equal(spanLengthOf(result.spanLengths, 'origin~dst:r1'), 28);
});

test('17. two spans can carry different measurements', () => {
  let lengths = createSpanLengths();
  lengths = setSpanLength(lengths, 'a~b', 28).spanLengths;
  lengths = setSpanLength(lengths, 'b~c', 32.5).spanLengths;
  assert.equal(spanLengthOf(lengths, 'a~b'), 28);
  assert.equal(spanLengthOf(lengths, 'b~c'), 32.5);
});

test('18. decimal lengths are kept exactly', () => {
  const result = setSpanLength(createSpanLengths(), 'a~b', '32.5');
  assert.equal(result.ok, true);
  assert.equal(spanLengthOf(result.spanLengths, 'a~b'), 32.5);
});

test('19. an unmeasured span is explicitly unmeasured, not zero', () => {
  const lengths = createSpanLengths();
  assert.equal(spanLengthOf(lengths, 'a~b'), null, 'the absence is a distinct state');
  assert.equal(formatSpanLength(null), `— ${SPAN_UNIT}`, 'and it draws as a placeholder');
});

test('20. a length must be positive', () => {
  for (const bad of [0, -3, 'long', '', null, NaN]) {
    const result = setSpanLength(createSpanLengths(), 'a~b', bad);
    assert.equal(result.ok, false, `${String(bad)} is refused`);
  }
  assert.equal(parseSpanLength('42').value, 42);
});

test('21. a measurement can be cleared back to unmeasured', () => {
  let lengths = setSpanLength(createSpanLengths(), 'a~b', 30).spanLengths;
  lengths = clearSpanLength(lengths, 'a~b');
  assert.equal(spanLengthOf(lengths, 'a~b'), null);
});

test('22. the default applies only to spans with no measurement', () => {
  let lengths = createSpanLengths();
  lengths = setSpanLength(lengths, 'a~b', 28).spanLengths;

  const result = applyDefaultLength(lengths, ['a~b', 'b~c', 'c~d'], 40);
  assert.equal(result.ok, true);
  assert.equal(result.updated, 2, 'two were empty and got the default');
  assert.equal(result.skipped, 1, 'the measured one was left alone');
  assert.equal(spanLengthOf(result.spanLengths, 'a~b'), 28, 'the survey value survives');
  assert.equal(spanLengthOf(result.spanLengths, 'b~c'), 40);
});

test('23. applying a default twice is harmless', () => {
  const first = applyDefaultLength(createSpanLengths(), ['a~b', 'b~c'], 40);
  const second = applyDefaultLength(first.spanLengths, ['a~b', 'b~c'], 55);
  assert.equal(second.updated, 0, 'nothing was unmeasured the second time');
  assert.equal(second.skipped, 2);
  assert.equal(spanLengthOf(second.spanLengths, 'a~b'), 40, 'the first default stands');
});

test('24. completeness is reported, not assumed', () => {
  let lengths = createSpanLengths();
  lengths = setSpanLength(lengths, 'a~b', 28).spanLengths;

  const partial = measureCompleteness(lengths, ['a~b', 'b~c', 'c~d']);
  assert.deepEqual(partial, { total: 3, assigned: 1, unassigned: 2, complete: false });

  const full = measureCompleteness(
    setSpanLength(setSpanLength(lengths, 'b~c', 30).spanLengths, 'c~d', 31).spanLengths,
    ['a~b', 'b~c', 'c~d'],
  );
  assert.deepEqual(full, { total: 3, assigned: 3, unassigned: 0, complete: true });
});

test('25. measurements for removed spans are handed back, not dropped', () => {
  let lengths = createSpanLengths();
  lengths = setSpanLength(lengths, 'a~b', 28).spanLengths;
  lengths = setSpanLength(lengths, 'gone~span', 99).spanLengths;

  const { kept, unresolved } = splitUnresolved(lengths, ['a~b']);
  assert.equal(kept.size, 1);
  assert.equal(spanLengthOf(kept, 'a~b'), 28);
  assert.equal(unresolved.length, 1, 'the orphan is reported');
  assert.equal(unresolved[0].spanId, 'gone~span');
  assert.equal(unresolved[0].lengthM, 99, 'and its value is intact');
});

test('26. a measurement change never touches the drawing spacing', () => {
  // The two are stored separately by construction: this dataset has no notion of
  // spacing at all, so there is nothing a length could alter.
  const lengths = setSpanLength(createSpanLengths(), 'a~b', 500).spanLengths;
  const record = lengths.get('a~b');
  assert.deepEqual(Object.keys(record).sort(), ['lengthM', 'spanId']);
});
