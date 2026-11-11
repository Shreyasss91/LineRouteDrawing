/**
 * CSV and TSV transfer of the two schedules.
 *
 * The transfer has to be lossless in both directions and it has to be safe when it
 * is not: a spreadsheet round trip is the ordinary way these numbers get into the
 * tool, so a row that survives a copy must come back identical, and a row that is
 * wrong must stop the import rather than half-apply it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NODE_LOAD_COLUMNS,
  SPAN_LENGTH_COLUMNS,
  applyNodeLoadPlan,
  applySpanPlan,
  describePlan,
  detectDelimiter,
  nodeLoadsToCsv,
  nodeLoadsToTsv,
  parseDelimited,
  parseNodeLoadImport,
  parseSpanLengthImport,
  quoteField,
  spanLengthsToCsv,
  spanLengthsToTsv,
  toDelimited,
} from '../src/data/schedule_io.js';
import {
  addLoad,
  createLoadSchedule,
  createSpanLengths,
  nextLoadId,
  setSpanLength,
} from '../src/data/schedules.js';

// Designations are the name a schedule reads by, so the fixtures carry them. The
// label is the drawn label and is deliberately different from the designation here,
// so a test that accidentally prints the wrong one fails instead of passing.
const NODES = [
  { id: 'origin', label: 'Origin', designation: 'Origin', nodeType: 'origin' },
  { id: 'dst:r1', label: 'A', designation: 'A', nodeType: 'pole' },
  { id: 'mid:r1:0', label: 'B', designation: 'A1', nodeType: 'pole' },
  { id: 'dst:r2', label: 'FPB', designation: 'FPB', nodeType: 'fpb' },
];

const SPANS = [
  { id: 'origin~dst:r1', a: 'origin', b: 'dst:r1', fromNodeId: 'origin', toNodeId: 'dst:r1', designation: 'Origin–A' },
  { id: 'dst:r1~mid:r1:0', a: 'dst:r1', b: 'mid:r1:0', fromNodeId: 'dst:r1', toNodeId: 'mid:r1:0', designation: 'A–A1' },
];

const lookupNode = (id) => NODES.find((n) => n.id === id) ?? null;
const lookupSpan = (id) => SPANS.find((s) => s.id === id) ?? null;
const eligible = (type) => type !== 'tc';

function threeLoads() {
  let loads = createLoadSchedule();
  loads = addLoad(loads, { nodeId: 'dst:r2', value: 25, unit: 'kVA' }).loads;
  loads = addLoad(loads, { nodeId: 'dst:r2', value: 5, unit: 'kW' }).loads;
  loads = addLoad(loads, { nodeId: 'dst:r2', value: 12, unit: 'HP' }).loads;
  return loads;
}

/* ------------------------------------------------------------------ */
/* Text handling                                                       */
/* ------------------------------------------------------------------ */

test('1. a quoted field may contain the delimiter', () => {
  assert.deepEqual(parseDelimited('a,"b,c",d'), [['a', 'b,c', 'd']]);
});

test('2. a doubled quote reads as one quote', () => {
  assert.deepEqual(parseDelimited('a,"say ""hi""",c'), [['a', 'say "hi"', 'c']]);
});

test('3. an apostrophe in an unquoted field does not swallow the file', () => {
  // A label like "Ram's plot" is common, and must not be treated as an opening quote.
  assert.deepEqual(parseDelimited("a,Ram's plot,c"), [['a', "Ram's plot", 'c']]);
});

test('4. CRLF and a missing final newline both read correctly', () => {
  assert.deepEqual(parseDelimited('a,b\r\nc,d'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('5. trailing blank rows are dropped', () => {
  assert.deepEqual(parseDelimited('a,b\n\n\n'), [['a', 'b']]);
});

test('6. quoting is applied only when needed', () => {
  assert.equal(quoteField('plain'), 'plain');
  assert.equal(quoteField('has,comma'), '"has,comma"');
  assert.equal(quoteField('has"quote'), '"has""quote"');
});

test('7. tab and comma are chosen from the first line', () => {
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
});

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

test('8. the node schedule lists every node that takes a load', () => {
  const csv = nodeLoadsToCsv(NODES, threeLoads(), eligible);
  const rows = parseDelimited(csv);
  assert.deepEqual(rows[0], [...NODE_LOAD_COLUMNS]);
  // One placeholder row per unloaded node, and one row per load on the loaded one.
  const ids = rows.slice(1).map((r) => r[0]);
  assert.ok(ids.includes('origin'), 'the Origin appears');
  assert.ok(ids.includes('dst:r1'));
  assert.equal(ids.filter((id) => id === 'dst:r2').length, 3, 'three rows for three loads');
});

test('9. a node with no load exports a blank placeholder row', () => {
  const rows = parseDelimited(nodeLoadsToCsv(NODES, createLoadSchedule(), eligible));
  const origin = rows.find((r) => r[0] === 'origin');
  assert.deepEqual(origin, ['origin', 'Origin', 'origin', '', '', '']);
});

test('10. the span schedule lists one row per unique span', () => {
  const lengths = setSpanLength(createSpanLengths(), 'origin~dst:r1', 28).spanLengths;
  const rows = parseDelimited(spanLengthsToCsv(SPANS, lengths, lookupNode));
  assert.deepEqual(rows[0], [...SPAN_LENGTH_COLUMNS]);
  assert.equal(rows.length, 3, 'header plus two spans');
  // The readable name comes first, then the identity, then the two ends in the order
  // the span was drawn, then the length.
  assert.deepEqual(rows[1], [
    'origin~dst:r1',
    'Origin–A',
    'origin',
    'dst:r1',
    'Origin',
    'A',
    '28',
  ]);
  assert.equal(rows[2][6], '', 'an unmeasured span is blank, not zero');
});

test('11. TSV export is a spreadsheet-ready block', () => {
  const tsv = nodeLoadsToTsv(NODES, threeLoads(), eligible);
  assert.ok(tsv.includes('\t'), 'fields are tab separated');
  const rows = parseDelimited(tsv, '\t');
  assert.deepEqual(rows[0], [...NODE_LOAD_COLUMNS], 'a header still comes first');
  assert.equal(rows.filter((r) => r[0] === 'dst:r2').length, 3);
});

test('12. TSV import and CSV export describe the same data', () => {
  const loads = threeLoads();
  const fromTsv = parseNodeLoadImport(nodeLoadsToTsv(NODES, loads, eligible), {
    loads,
    lookupNode,
    isEligible: eligible,
    mode: 'replace',
  });
  assert.equal(fromTsv.ok, true);
  assert.equal(fromTsv.plan.records.length, 3, 'the three loads survived the tab form too');
});

/* ------------------------------------------------------------------ */
/* Import: node loads                                                  */
/* ------------------------------------------------------------------ */

test('13. a round trip changes nothing', () => {
  const loads = threeLoads();
  const parsed = parseNodeLoadImport(nodeLoadsToCsv(NODES, loads, eligible), {
    loads,
    lookupNode,
    isEligible: eligible,
    mode: 'replace',
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.added.length, 0);
  assert.equal(parsed.plan.updated.length, 0);
  assert.equal(parsed.plan.removed.length, 0);
  assert.equal(parsed.plan.unchanged.length, 3);

  const { loads: applied } = applyNodeLoadPlan(loads, parsed.plan, nextLoadId);
  assert.deepEqual(
    applied.map((l) => [l.id, l.nodeId, l.value, l.unit]),
    loads.map((l) => [l.id, l.nodeId, l.value, l.unit]),
  );
});

test('14. a spreadsheet paste works without a download first', () => {
  const text = 'nodeId\tpointLabel\tnodeType\tloadId\tvalue\tunit\ndst:r1\tA\tpole\t\t30\tkW\n';
  const parsed = parseNodeLoadImport(text, {
    loads: createLoadSchedule(),
    lookupNode,
    isEligible: eligible,
    mode: 'replace',
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.added.length, 1);
  assert.equal(parsed.plan.added[0].value, 30);
  assert.equal(parsed.plan.added[0].unit, 'kW');
});

test('15. a header is required, and the refusal says which column is missing', () => {
  const parsed = parseNodeLoadImport('nodeId,value\ndst:r1,30', {
    loads: [],
    lookupNode,
    isEligible: eligible,
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /unit/);
});

test('16. an empty import is refused', () => {
  const parsed = parseNodeLoadImport('', { loads: [], lookupNode, isEligible: eligible });
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /empty/i);
});

test('17. every bad line is reported, and nothing is applied', () => {
  const text = [
    'nodeId,pointLabel,nodeType,loadId,value,unit',
    'dst:r1,A,pole,,30,kVA',
    'dst:r1,A,pole,, ,kVA',
    'dst:r1,A,pole,,40,amps',
  ].join('\n');
  const parsed = parseNodeLoadImport(text, { loads: [], lookupNode, isEligible: eligible });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.details.length, 2, 'both faults are listed');
  assert.match(parsed.message, /Nothing has been changed/);
});

test('18. a repeated load identifier is refused', () => {
  const text = ['nodeId,pointLabel,nodeType,loadId,value,unit', 'dst:r1,A,pole,l1,5,kVA', 'dst:r1,A,pole,l1,7,kVA'].join('\n');
  const parsed = parseNodeLoadImport(text, { loads: [], lookupNode, isEligible: eligible });
  assert.equal(parsed.ok, false);
  assert.match(parsed.details[0], /reuses/);
});

test('19. a row for a point the drawing does not have is kept as unresolved', () => {
  // Not silently dropped: the record is the user's data even when its point is gone.
  const text = ['nodeId,pointLabel,nodeType,loadId,value,unit', 'gone:route-9,X,pole,l1,5,kVA'].join('\n');
  const parsed = parseNodeLoadImport(text, { loads: [], lookupNode, isEligible: eligible });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.unresolved.length, 1);
  assert.equal(parsed.plan.unresolved[0].nodeId, 'gone:route-9');
  assert.equal(parsed.plan.added.length, 0, 'it was not applied to anything');
});

test('20. a load on a TC point is refused', () => {
  const text = ['nodeId,pointLabel,nodeType,loadId,value,unit', 'tc:1,T,tc,l1,5,kVA'].join('\n');
  const parsed = parseNodeLoadImport(text, {
    loads: [],
    lookupNode: (id) => (id === 'tc:1' ? { id, nodeType: 'tc' } : null),
    isEligible: eligible,
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.details[0], /does not take loads/);
});

test('21. replace removes what the file omits; update keeps it', () => {
  const loads = threeLoads();
  const text = ['nodeId,pointLabel,nodeType,loadId,value,unit', `dst:r2,FPB,fpb,${loads[0].id},30,kVA`].join('\n');

  const replace = parseNodeLoadImport(text, { loads, lookupNode, isEligible: eligible, mode: 'replace' });
  assert.equal(replace.ok, true);
  assert.equal(replace.plan.updated.length, 1, 'the kept id was updated');
  assert.equal(replace.plan.removed.length, 2, 'the two omitted loads are dropped');
  assert.equal(applyNodeLoadPlan(loads, replace.plan, nextLoadId).loads.length, 1);

  const update = parseNodeLoadImport(text, { loads, lookupNode, isEligible: eligible, mode: 'update' });
  assert.equal(update.plan.removed.length, 0, 'update is a change list');
  const applied = applyNodeLoadPlan(loads, update.plan, nextLoadId).loads;
  assert.equal(applied.length, 3, 'the omitted loads are untouched');
  assert.equal(applied.find((l) => l.id === loads[0].id).value, 30);
});

test('22. a new row with no id is given one on apply', () => {
  const text = ['nodeId,pointLabel,nodeType,loadId,value,unit', 'dst:r1,A,pole,,30,kVA'].join('\n');
  const parsed = parseNodeLoadImport(text, { loads: [], lookupNode, isEligible: eligible, mode: 'update' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.added.length, 1);
  assert.equal(parsed.plan.added[0].id, null, 'no id until it is applied');

  const { loads } = applyNodeLoadPlan([], parsed.plan, nextLoadId);
  assert.match(loads[0].id, /^load-\d+$/);
});

test('23. the plan summary counts what will happen', () => {
  const loads = threeLoads();
  const text = ['nodeId,pointLabel,nodeType,loadId,value,unit', 'dst:r1,A,pole,,30,kVA'].join('\n');
  const parsed = parseNodeLoadImport(text, { loads, lookupNode, isEligible: eligible, mode: 'replace' });
  const summary = describePlan(parsed.plan);
  assert.match(summary, /1 load added/);
  assert.match(summary, /3 loads removed/);
});

/* ------------------------------------------------------------------ */
/* Import: span lengths                                                */
/* ------------------------------------------------------------------ */

test('24. a span length round trip changes nothing', () => {
  const lengths = setSpanLength(createSpanLengths(), 'origin~dst:r1', 28).spanLengths;
  const parsed = parseSpanLengthImport(spanLengthsToCsv(SPANS, lengths, lookupNode), {
    spanLengths: lengths,
    lookupSpan,
    mode: 'replace',
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.unchanged.length, 1);
  assert.equal(parsed.plan.added.length, 0);
  assert.equal(parsed.plan.removed.length, 0);
});

test('25. a blank length clears a measurement', () => {
  const lengths = setSpanLength(createSpanLengths(), 'origin~dst:r1', 28).spanLengths;
  const text = ['spanId,lengthM', 'origin~dst:r1,'].join('\n');
  const parsed = parseSpanLengthImport(text, { spanLengths: lengths, lookupSpan, mode: 'replace' });
  assert.equal(parsed.ok, true);
  const applied = applySpanPlan(lengths, parsed.plan);
  assert.equal(applied.size, 0, 'the span is unmeasured again');
});

test('26. a repeated span id is refused', () => {
  const text = ['spanId,lengthM', 'origin~dst:r1,28', 'origin~dst:r1,30'].join('\n');
  const parsed = parseSpanLengthImport(text, { spanLengths: createSpanLengths(), lookupSpan });
  assert.equal(parsed.ok, false);
  assert.match(parsed.details[0], /two lengths/);
});

test('27. a length that is not positive is refused', () => {
  for (const bad of ['0', '-2', 'long']) {
    const text = ['spanId,lengthM', `origin~dst:r1,${bad}`].join('\n');
    const parsed = parseSpanLengthImport(text, { spanLengths: createSpanLengths(), lookupSpan });
    assert.equal(parsed.ok, false, `${bad} is refused`);
  }
});

test('28. an unknown span is kept as unresolved', () => {
  const text = ['spanId,lengthM', 'gone~span,50'].join('\n');
  const parsed = parseSpanLengthImport(text, { spanLengths: createSpanLengths(), lookupSpan });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.unresolved.length, 1);
  assert.equal(parsed.plan.records.length, 0);
});

test('29. a span length TSV block imports', () => {
  const text = 'spanId\tfromNodeId\ttoNodeId\tfromLabel\ttoLabel\tlengthM\ndst:r1~mid:r1:0\tA\tB\tA\tB\t33.5\n';
  const parsed = parseSpanLengthImport(text, { spanLengths: createSpanLengths(), lookupSpan, mode: 'replace' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.added[0].lengthM, 33.5);
});

test('30. the delimiter choice does not affect the result', () => {
  const csv = ['spanId,lengthM', 'origin~dst:r1,28'].join('\n');
  const tsv = ['spanId\tlengthM', 'origin~dst:r1\t28'].join('\n');
  const a = parseSpanLengthImport(csv, { spanLengths: createSpanLengths(), lookupSpan });
  const b = parseSpanLengthImport(tsv, { spanLengths: createSpanLengths(), lookupSpan });
  assert.deepEqual(a.plan.records[0].lengthM, b.plan.records[0].lengthM);
});

test('31. a toDelimited round trip preserves awkward text', () => {
  const rows = [
    ['a', 'b,c', 'd"e', 'f\ng'],
    ['1', '', '2', '3'],
  ];
  assert.deepEqual(parseDelimited(toDelimited(rows, ',')), rows);
});
