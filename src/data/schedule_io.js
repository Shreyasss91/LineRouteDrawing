/**
 * CSV and TSV import/export for the two schedules.
 *
 * The point of this module is that a survey is entered once, in a spreadsheet,
 * and that the transfer in either direction is lossless. That means two things
 * are non-negotiable:
 *
 *   - The stable asset id is the key on the way back in. Labels are written so a
 *     person can read the file, and ignored on import, because a label is a
 *     display name that an edit can change.
 *   - A bulk import is validated in full before anything is applied, and the
 *     result is a staged plan rather than a mutation. The caller decides whether
 *     to apply it, so a malformed file cannot leave the project half-imported.
 *
 * Nothing here touches the DOM or the project state; it converts between text and
 * plain data.
 */

import { LOAD_UNITS, normalizeUnit, parseLoadValue, parseSpanLength } from './schedules.js';

/* ------------------------------------------------------------------ */
/* Delimited text                                                      */
/* ------------------------------------------------------------------ */

/**
 * Split delimited text into rows of fields.
 *
 * Handles the awkward parts of a real spreadsheet export: quoted fields with
 * embedded delimiters, doubled quotes inside a quoted field, and CRLF line
 * endings. A quote only opens a quoted field at the start of a field, which is
 * what keeps an apostrophe or an inch mark in a label from swallowing the rest of
 * the file.
 *
 * @param {string} text Delimited text.
 * @param {string} [delimiter] Field delimiter, a tab or a comma.
 * @returns {Array<Array<string>>} Rows of unquoted fields.
 */
export function parseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldStart = true;

  const source = String(text ?? '').replace(/\r\n?/g, '\n');

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      continue;
    }

    if (char === delimiter) {
      row.push(field);
      field = '';
      fieldStart = true;
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStart = true;
      continue;
    }

    fieldStart = false;
    field += char;
  }

  // A file that does not end in a newline still has one last row.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing blank rows, which spreadsheets add liberally.
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0].trim() === '') rows.pop();
    else break;
  }

  return rows;
}

/**
 * Quote one field for delimited output.
 *
 * @param {unknown} value Field value.
 * @param {string} delimiter Active delimiter.
 * @returns {string} Field text, quoted only when it has to be.
 */
export function quoteField(value, delimiter = ',') {
  const text = value === null || value === undefined ? '' : String(value);
  if (text === '') return '';
  const needsQuotes =
    text.includes(delimiter) || text.includes('"') || text.includes('\n') || text.includes('\r');
  if (!needsQuotes) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Join rows into delimited text.
 *
 * @param {Array<Array<unknown>>} rows Rows of values.
 * @param {string} [delimiter] Field delimiter.
 * @returns {string} Text, newline terminated.
 */
export function toDelimited(rows, delimiter = ',') {
  return rows.map((row) => row.map((cell) => quoteField(cell, delimiter)).join(delimiter)).join('\n') + '\n';
}

/** Convert an array of objects to rows with a fixed header order. */
function rowsFromObjects(records, columns) {
  return [columns, ...records.map((record) => columns.map((key) => record[key]))];
}

/** Map header cells to column indexes, tolerating case and surrounding space. */
function indexByHeader(headerRow) {
  const index = new Map();
  headerRow.forEach((cell, i) => {
    index.set(String(cell ?? '').trim().toLowerCase(), i);
  });
  return index;
}

/** Read a field by header name, or '' when the column is absent. */
function fieldAt(row, index, name) {
  const at = index.get(name);
  if (at === undefined) return '';
  return String(row[at] ?? '').trim();
}

/* ------------------------------------------------------------------ */
/* Node load schedule                                                  */
/* ------------------------------------------------------------------ */

/** Column order of the node load file. */
export const NODE_LOAD_COLUMNS = Object.freeze([
  'nodeId',
  'pointLabel',
  'nodeType',
  'loadId',
  'value',
  'unit',
]);

/** File name a node load schedule is downloaded as. */
export const NODE_LOAD_FILE = 'node_loads.csv';

/**
 * Every row of the node load schedule, including nodes with no load.
 *
 * A node with no load gets one row with empty `loadId`, `value` and `unit`. That
 * keeps the schedule a complete inventory: the person filling it in sees every
 * pole they have to account for, and a node they have not got to yet looks
 * different from one they have deliberately left empty.
 *
 * @param {Array<object>} nodeAssets Node assets from the registry.
 * @param {Array<object>} loads Load records.
 * @param {(nodeType: string) => boolean} isEligible Which node types take loads.
 * @returns {Array<Array<unknown>>} Rows including the header.
 */
export function nodeLoadRows(nodeAssets, loads, isEligible) {
  const rows = [];
  for (const asset of nodeAssets) {
    if (!isEligible(asset.nodeType)) continue;
    const mine = loads.filter((load) => load.nodeId === asset.id);
    if (mine.length === 0) {
      rows.push([asset.id, asset.label ?? '', asset.nodeType, '', '', '']);
      continue;
    }
    for (const load of mine) {
      rows.push([
        asset.id,
        asset.label ?? '',
        asset.nodeType,
        load.id,
        load.value,
        load.unit,
      ]);
    }
  }
  return rowsFromObjects(
    rows.map((row) => Object.fromEntries(NODE_LOAD_COLUMNS.map((key, i) => [key, row[i]]))),
    NODE_LOAD_COLUMNS,
  );
}

/** Serialize the node load schedule as CSV. */
export function nodeLoadsToCsv(nodeAssets, loads, isEligible) {
  return toDelimited(nodeLoadRows(nodeAssets, loads, isEligible), ',');
}

/** Serialize the node load schedule as TSV, ready to paste into a spreadsheet. */
export function nodeLoadsToTsv(nodeAssets, loads, isEligible) {
  return toDelimited(nodeLoadRows(nodeAssets, loads, isEligible), '\t');
}

/* ------------------------------------------------------------------ */
/* Span length schedule                                                */
/* ------------------------------------------------------------------ */

/** Column order of the span length file. */
export const SPAN_LENGTH_COLUMNS = Object.freeze([
  'spanId',
  'fromNodeId',
  'toNodeId',
  'fromLabel',
  'toLabel',
  'lengthM',
]);

/** File name a span length schedule is downloaded as. */
export const SPAN_LENGTH_FILE = 'span_lengths.csv';

/**
 * Every span, in order, with its measurement or a blank.
 *
 * One row per unique physical span: a span is an asset, so two routes crossing
 * the same cable produce one row here, not two.
 *
 * @param {Array<object>} spanAssets Span assets from the registry.
 * @param {Map<string, object>} spanLengths Measurements.
 * @param {(nodeId: string) => object|null} lookupNode Node asset lookup.
 * @returns {Array<Array<unknown>>} Rows including the header.
 */
export function spanLengthRows(spanAssets, spanLengths, lookupNode) {
  const rows = spanAssets.map((span) => {
    const from = lookupNode(span.a);
    const to = lookupNode(span.b);
    const record = spanLengths.get(span.id);
    return {
      spanId: span.id,
      fromNodeId: span.a,
      toNodeId: span.b,
      fromLabel: from?.label ?? '',
      toLabel: to?.label ?? '',
      lengthM: record ? record.lengthM : '',
    };
  });
  return rowsFromObjects(rows, SPAN_LENGTH_COLUMNS);
}

/** Serialize the span length schedule as CSV. */
export function spanLengthsToCsv(spanAssets, spanLengths, lookupNode) {
  return toDelimited(spanLengthRows(spanAssets, spanLengths, lookupNode), ',');
}

/** Serialize the span length schedule as TSV. */
export function spanLengthsToTsv(spanAssets, spanLengths, lookupNode) {
  return toDelimited(spanLengthRows(spanAssets, spanLengths, lookupNode), '\t');
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/** Refusal codes, so a caller can tell the kinds apart without parsing text. */
export const IMPORT_ERRORS = Object.freeze({
  EMPTY: 'empty',
  MISSING_HEADERS: 'missing-headers',
  FIELD_COUNT: 'field-count',
  DUPLICATE_ID: 'duplicate-id',
  UNKNOWN_NODE: 'unknown-node',
  UNKNOWN_SPAN: 'unknown-span',
  BAD_VALUE: 'bad-value',
  BAD_UNIT: 'bad-unit',
  BAD_NODE_TYPE: 'bad-node-type',
});

function importFail(code, message, details = []) {
  return { ok: false, code, message, details };
}

/**
 * Decide whether the text uses tabs or commas.
 *
 * A pasted spreadsheet block is tab separated; a downloaded file is comma
 * separated. Choosing from the first line means the caller does not have to say
 * which it has.
 *
 * @param {string} text Delimited text.
 * @returns {string} The delimiter.
 */
export function detectDelimiter(text) {
  const firstLine = String(text ?? '').split('\n')[0] ?? '';
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs >= commas && tabs > 0 ? '\t' : ',';
}

/**
 * Parse and validate an incoming node load schedule.
 *
 * Every row is checked, every problem is collected, and nothing is applied. The
 * caller receives a plan of what would change so it can show the user a preview
 * before committing.
 *
 * @param {string} text Delimited text.
 * @param {object} context
 * @param {Array<object>} context.loads Current records.
 * @param {(nodeId: string) => object|null} context.lookupNode Node lookup by asset id.
 * @param {(nodeType: string) => boolean} context.isEligible Node type rule.
 * @param {string} [context.mode] `replace` or `update`.
 * @returns {{ok: true, plan: object} | {ok: false, code: string, message: string, details: string[]}}
 */
export function parseNodeLoadImport(text, context) {
  const rows = parseDelimited(text, detectDelimiter(text));
  if (rows.length === 0) {
    return importFail(IMPORT_ERRORS.EMPTY, 'There is nothing to import: the text is empty.');
  }

  const header = indexByHeader(rows[0]);
  const missing = ['nodeid', 'value', 'unit'].filter((name) => !header.has(name));
  if (missing.length > 0) {
    return importFail(
      IMPORT_ERRORS.MISSING_HEADERS,
      'The first line must be a header row with the columns ' +
        `${NODE_LOAD_COLUMNS.join(', ')}. Missing: ${missing.join(', ')}.`,
    );
  }

  const expectedFields = rows[0].length;
  const problems = [];
  const records = [];
  const seenLoadIds = new Set();
  const unresolved = [];

  rows.slice(1).forEach((row, offset) => {
    const line = offset + 2;
    if (row.length === 1 && String(row[0]).trim() === '') return;
    if (row.length !== expectedFields) {
      problems.push(`Line ${line} has ${row.length} fields but the header has ${expectedFields}.`);
      return;
    }

    const nodeId = fieldAt(row, header, 'nodeid');
    const loadId = fieldAt(row, header, 'loadid');
    const valueText = fieldAt(row, header, 'value');
    const unitText = fieldAt(row, header, 'unit');

    // A row with no load at all is the "this node has none" placeholder the
    // export writes. It is only meaningful under `replace`, where clearing is
    // the intent; under `update` an omitted record is simply left alone.
    if (!loadId && !valueText && !unitText) {
      if (nodeId && !context.lookupNode(nodeId)) {
        unresolved.push({ line, nodeId, reason: 'not in this drawing' });
      }
      return;
    }

    if (!nodeId) {
      problems.push(`Line ${line} has no node identifier.`);
      return;
    }
    const node = context.lookupNode(nodeId);
    if (!node) {
      // Not a hard failure: the row is preserved as unresolved so the user can
      // see it and decide, rather than having it silently dropped.
      unresolved.push({ line, nodeId, loadId: loadId || null, reason: 'not in this drawing' });
      return;
    }
    if (!context.isEligible(node.nodeType)) {
      problems.push(`Line ${line} puts a load on a ${node.nodeType} point, which does not take loads.`);
      return;
    }

    if (loadId) {
      if (seenLoadIds.has(loadId)) {
        problems.push(`Line ${line} reuses the load identifier ${loadId}.`);
        return;
      }
      seenLoadIds.add(loadId);
    }

    const value = parseLoadValue(valueText);
    if (!value.ok) {
      problems.push(`Line ${line}: ${value.message}`);
      return;
    }
    const unit = normalizeUnit(unitText);
    if (!unit) {
      problems.push(`Line ${line} has "${unitText}" as a unit. Use ${LOAD_UNITS.join(', ')}.`);
      return;
    }

    records.push({ line, id: loadId || null, nodeId, value: value.value, unit });
  });

  if (problems.length > 0) {
    return importFail(
      IMPORT_ERRORS.BAD_VALUE,
      `That schedule was not imported because ${problems.length} ${
        problems.length === 1 ? 'line has' : 'lines have'
      } a problem. Nothing has been changed.`,
      problems,
    );
  }

  return { ok: true, plan: planLoadImport(records, context.loads, context.mode ?? 'replace', unresolved) };
}

/**
 * Work out what applying a parsed node load schedule would do.
 *
 * The counts are the point: the user is told how many records would be added,
 * updated and removed before they agree. A record that is not in the incoming
 * file counts as removed under `replace` (the file is the whole truth) and as
 * kept under `update` (the file is a change list).
 *
 * @param {Array<object>} records Parsed incoming records.
 * @param {Array<object>} current Existing records.
 * @param {string} mode `replace` or `update`.
 * @param {Array<object>} unresolved Rows referring to assets not in the drawing.
 * @returns {object} Plan.
 */
function planLoadImport(records, current, mode, unresolved) {
  const currentById = new Map(current.map((load) => [load.id, load]));
  const incomingIds = new Set(records.filter((r) => r.id).map((r) => r.id));

  const added = [];
  const updated = [];
  const unchanged = [];
  const removed = [];

  for (const record of records) {
    const existing = record.id ? currentById.get(record.id) : null;
    if (!existing) {
      added.push(record);
      continue;
    }
    const same =
      existing.nodeId === record.nodeId &&
      existing.value === record.value &&
      existing.unit === record.unit;
    if (same) unchanged.push(record);
    else updated.push(record);
  }

  if (mode === 'replace') {
    for (const load of current) {
      if (!incomingIds.has(load.id)) removed.push(load);
    }
  }

  return {
    kind: 'loads',
    mode,
    records,
    added,
    updated,
    unchanged,
    removed,
    unresolved,
  };
}

/**
 * Apply a node load plan to the current records.
 *
 * Only called after the user has seen the plan and agreed. The result is a new
 * list; ids that were already present keep them, and a record with no id is given
 * a fresh one at this point, which is why the plan can talk about "added" before
 * an id exists.
 *
 * @param {Array<object>} current Existing records.
 * @param {object} plan Plan from `parseNodeLoadImport`.
 * @param {Function} makeId Id factory for records that arrive without one.
 * @returns {{loads: Array<object>, addedIds: string[]}}
 */
export function applyNodeLoadPlan(current, plan, makeId) {
  const currentById = new Map(current.map((load) => [load.id, load]));
  const next = [];

  if (plan.mode === 'replace') {
    // The file is the whole truth, so the result is exactly its records.
    for (const record of plan.records) {
      next.push({
        id: record.id ?? makeId(),
        nodeId: record.nodeId,
        value: record.value,
        unit: record.unit,
      });
    }
    return { loads: next, addedIds: next.map((load) => load.id) };
  }

  // `update`: keep everything the file did not mention, then apply the changes.
  for (const load of current) next.push(load);
  const addedIds = [];
  for (const record of plan.records) {
    const existing = record.id ? currentById.get(record.id) : null;
    if (existing) {
      const index = next.findIndex((load) => load.id === existing.id);
      next[index] = { ...existing, nodeId: record.nodeId, value: record.value, unit: record.unit };
    } else {
      const id = record.id ?? makeId();
      next.push({ id, nodeId: record.nodeId, value: record.value, unit: record.unit });
      addedIds.push(id);
    }
  }
  return { loads: next, addedIds };
}

/**
 * Parse and validate an incoming span length schedule.
 *
 * @param {string} text Delimited text.
 * @param {object} context
 * @param {Map<string, object>} context.spanLengths Current measurements.
 * @param {(spanId: string) => object|null} context.lookupSpan Span lookup by asset id.
 * @param {string} [context.mode] `replace` or `update`.
 * @returns {{ok: true, plan: object} | {ok: false, code: string, message: string, details: string[]}}
 */
export function parseSpanLengthImport(text, context) {
  const rows = parseDelimited(text, detectDelimiter(text));
  if (rows.length === 0) {
    return importFail(IMPORT_ERRORS.EMPTY, 'There is nothing to import: the text is empty.');
  }

  const header = indexByHeader(rows[0]);
  const missing = ['spanid', 'lengthm'].filter((name) => !header.has(name));
  if (missing.length > 0) {
    return importFail(
      IMPORT_ERRORS.MISSING_HEADERS,
      'The first line must be a header row with the columns ' +
        `${SPAN_LENGTH_COLUMNS.join(', ')}. Missing: ${missing.join(', ')}.`,
    );
  }

  const expectedFields = rows[0].length;
  const problems = [];
  const records = [];
  const seenSpanIds = new Set();
  const unresolved = [];

  rows.slice(1).forEach((row, offset) => {
    const line = offset + 2;
    if (row.length === 1 && String(row[0]).trim() === '') return;
    if (row.length !== expectedFields) {
      problems.push(`Line ${line} has ${row.length} fields but the header has ${expectedFields}.`);
      return;
    }

    const spanId = fieldAt(row, header, 'spanid');
    const lengthText = fieldAt(row, header, 'lengthm');

    if (!spanId) {
      problems.push(`Line ${line} has no span identifier.`);
      return;
    }
    if (seenSpanIds.has(spanId)) {
      problems.push(`Line ${line} repeats the span ${spanId}, so it has two lengths.`);
      return;
    }
    seenSpanIds.add(spanId);

    const span = context.lookupSpan(spanId);
    if (!span) {
      unresolved.push({ line, spanId, reason: 'not in this drawing' });
      return;
    }

    // A blank length is the explicit "not measured" state, which is what the
    // export writes for an unmeasured span. It is a valid row, not an error.
    if (lengthText === '') {
      records.push({ line, spanId, lengthM: null });
      return;
    }

    const parsed = parseSpanLength(lengthText);
    if (!parsed.ok) {
      problems.push(`Line ${line}: ${parsed.message}`);
      return;
    }
    records.push({ line, spanId, lengthM: parsed.value });
  });

  if (problems.length > 0) {
    return importFail(
      IMPORT_ERRORS.BAD_VALUE,
      `That schedule was not imported because ${problems.length} ${
        problems.length === 1 ? 'line has' : 'lines have'
      } a problem. Nothing has been changed.`,
      problems,
    );
  }

  return {
    ok: true,
    plan: planSpanImport(records, context.spanLengths, context.mode ?? 'replace', unresolved),
  };
}

function planSpanImport(records, current, mode, unresolved) {
  const added = [];
  const updated = [];
  const unchanged = [];
  const removed = [];

  for (const record of records) {
    const existing = current.get(record.spanId) ?? null;
    if (record.lengthM === null) {
      if (existing) removed.push(existing);
      continue;
    }
    if (!existing) {
      added.push(record);
      continue;
    }
    if (existing.lengthM === record.lengthM) unchanged.push(record);
    else updated.push(record);
  }

  if (mode === 'replace') {
    const incoming = new Set(records.map((r) => r.spanId));
    for (const [spanId, record] of current) {
      if (!incoming.has(spanId)) removed.push(record);
    }
  }

  return { kind: 'spans', mode, records, added, updated, unchanged, removed, unresolved };
}

/**
 * Apply a span length plan.
 *
 * @param {Map<string, object>} current Existing measurements.
 * @param {object} plan Plan from `parseSpanLengthImport`.
 * @returns {Map<string, object>} New measurements.
 */
export function applySpanPlan(current, plan) {
  const next = plan.mode === 'replace' ? new Map() : new Map(current);
  for (const record of plan.records) {
    if (record.lengthM === null) {
      next.delete(record.spanId);
    } else {
      next.set(record.spanId, { spanId: record.spanId, lengthM: record.lengthM });
    }
  }
  return next;
}

/**
 * A one-line summary of a plan, for the confirmation the user sees.
 *
 * @param {object} plan Plan from either parser.
 * @returns {string} Sentence.
 */
export function describePlan(plan) {
  const noun = plan.kind === 'loads' ? 'load' : 'length';
  const plural = (n) => (n === 1 ? noun : `${noun}s`);
  const parts = [
    `${plan.added.length} ${plural(plan.added.length)} added`,
    `${plan.updated.length} ${plural(plan.updated.length)} updated`,
    `${plan.removed.length} ${plural(plan.removed.length)} removed`,
  ];
  if (plan.unchanged.length > 0) parts.push(`${plan.unchanged.length} unchanged`);
  if (plan.unresolved.length > 0) {
    parts.push(
      `${plan.unresolved.length} ${
        plan.unresolved.length === 1 ? 'row refers' : 'rows refer'
      } to something this drawing no longer has`,
    );
  }
  return `${parts.join(', ')}.`;
}
