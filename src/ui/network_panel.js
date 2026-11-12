/**
 * The Network Data section: load and span-length schedules.
 *
 * This module owns the two tables, the clipboard and CSV transfer, and the
 * selection that links a row to the drawing. It deliberately holds no copy of the
 * measured data: every render reads the live state passed in through `getState`,
 * and every change goes back through `onChange`, so there is exactly one source of
 * truth and the drawing cannot disagree with the table.
 *
 * The transfer flow, in order, is:
 *
 *   paste or file -> parse -> validate -> stage -> the user picks a mode -> apply
 *
 * Nothing is applied before the user has seen what would happen, because the file
 * is usually a whole survey and a wrong one is expensive to re-enter.
 */

import {
  LOAD_UNITS,
  addLoad,
  applyDefaultLength,
  isLoadEligible,
  measureCompleteness,
  nextLoadId,
  reassignLoad,
  removeLoad,
  removeLoadsForNode,
} from '../data/schedules.js';
import {
  NODE_LOAD_FILE,
  SPAN_LENGTH_FILE,
  applyNodeLoadPlan,
  applySpanPlan,
  describePlan,
  detectDelimiter,
  nodeLoadsToCsv,
  nodeLoadsToTsv,
  parseNodeLoadImport,
  parseSpanLengthImport,
  parseDelimited,
  toDelimited,
  SPAN_LENGTH_COLUMNS,
  spanLengthsToCsv,
  spanLengthsToTsv,
} from '../data/schedule_io.js';
import { buildAssetRegistry } from '../geometry/assets.js';

const el = (id) => document.getElementById(id);

/**
 * Build the Network Data section.
 *
 * @param {object} options
 * @param {() => object} options.getState Live application state.
 * @param {() => object} options.getNetwork Current built network.
 * @param {(change: object) => void} options.onChange Called with the keys to replace.
 * @param {() => void} options.onSelectNode Highlight a node in the drawing.
 * @param {() => void} options.onSelectSpan Highlight a span in the drawing.
 * @param {(message: string) => void} options.notify Report a result to the user.
 */
export function createNetworkPanel(options) {
  const { getState, getNetwork, onChange, notify } = options;

  const dom = {
    summary: el('network-summary'),
    tabs: [el('tab-loads'), el('tab-spans')],
    panels: [el('panel-loads'), el('panel-spans')],

    loadNode: el('field-load-node'),
    loadValue: el('field-load-value'),
    loadUnit: el('field-load-unit'),
    addLoad: el('btn-add-load'),
    loadFormError: el('load-form-error'),
    loadRows: el('load-rows'),
    loadEmpty: el('load-empty'),
    loadsTsv: el('btn-loads-tsv'),
    loadsCsv: el('btn-loads-csv'),
    loadsImport: el('btn-loads-import'),

    defaultLength: el('field-default-length'),
    applyDefault: el('btn-apply-default'),
    spanRows: el('span-rows'),
    spanEmpty: el('span-empty'),
    spansTsv: el('btn-spans-tsv'),
    spansCsv: el('btn-spans-csv'),
    spansImport: el('btn-spans-import'),

    staging: el('import-staging'),
    stagingHeading: el('import-heading'),
    stagingSummary: el('import-summary'),
    stagingDetails: el('import-details'),
    importApply: el('btn-import-apply'),
    importCancel: el('btn-import-cancel'),

    unresolvedBar: el('unresolved-bar'),
    unresolvedText: el('unresolved-text'),
    unresolvedReview: el('btn-unresolved-review'),
    unresolvedDiscard: el('btn-unresolved-discard'),
  };

  /** The file or paste waiting for the user's confirmation, if any. */
  let staged = null;
  /** Which schedule the staged import belongs to: 'loads' or 'spans'. */
  let stagedKind = null;
  /** Row currently selected, so the drawing can echo it. */
  let selectedNodeId = null;
  let selectedSpanId = null;

  /* ---------------------------------------------------------------- */
  /* Helpers                                                          */
  /* ---------------------------------------------------------------- */

  const state = () => getState();
  const network = () => getNetwork();

  /**
   * A registry for the current drawing, carrying its point designations.
   *
   * The designations are authored data held in state, so the panel reads them from
   * there rather than re-deriving names. If it derived them it could disagree with
   * the drawing, and a schedule that names a pole differently from the picture is
   * worse than one that names it by its internal id.
   */
  function registry() {
    return buildAssetRegistry(network(), { designations: state().nodeDesignations });
  }

  /** Node assets for the current drawing, in a stable order. */
  function nodeAssets() {
    return registry().allNodeAssets();
  }

  /**
   * Resolve an asset id to its node, for callers that need the node type.
   *
   * Canonicalised first, because a node is reachable under more than one accepted
   * spelling - its asset id and its coordinate key - and `nodeAsset()` only knows
   * the canonical one. Without this an aliased spelling returned null and the
   * eligibility check was skipped rather than applied.
   */
  function lookupNode(nodeId) {
    const reg = registry();
    return reg.nodeAsset(reg.canonicalNodeId(nodeId) ?? nodeId);
  }

  /** Span assets for the current drawing. */
  function spanAssets() {
    return registry().allSpanAssets();
  }

  /**
   * The designation shown for a node asset: `A1`, `Origin:2`, `FPB1`.
   *
   * Falls back to the drawn label and finally to the id, so a row is never blank
   * even if a name is somehow missing.
   */
  function nodeLabel(id) {
    const asset = nodeAssets().find((a) => a.id === id);
    return asset ? asset.designation ?? asset.label ?? asset.id : id;
  }

  /** The designation shown for a span: `A1–A2`, `Origin–Origin:1`. */
  function spanLabel(id) {
    const asset = spanAssets().find((a) => a.id === id);
    return asset ? asset.designation ?? asset.id : id;
  }

  /** Download text as a file. */
  function download(text, fileName, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Copy text to the clipboard.
   *
   * Falls back to a hidden textarea with the old selection API, because the async
   * clipboard is unavailable on a plain `file://` page in some browsers and that is
   * exactly how this tool is used.
   */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall through to the textarea path.
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }

  /** Ask for text to import: a pasted block, or a chosen file. */
  function askForText(kind) {
    const verb = kind === 'loads' ? 'node loads' : 'span lengths';
    const useFile = window.confirm(
      `Import ${verb}.\n\n` +
        `Press OK to choose a CSV file, or Cancel to paste a block copied from a ` +
        `spreadsheet instead.`,
    );

    if (!useFile) {
      const pasted = window.prompt(
        `Paste the ${verb} block, including its header row, then press OK.`,
      );
      if (pasted === null || pasted.trim() === '') return;
      stageImport(kind, pasted);
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv,text/plain';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => stageImport(kind, String(reader.result ?? ''));
      reader.onerror = () => notify('That file could not be read. Try choosing it again.');
      reader.readAsText(file);
    });
    input.click();
  }

  /**
   * Validate text and show the user what applying it would do.
   *
   * The plan is held until they press Apply, so nothing has changed if they
   * cancel or close the page.
   */
  function stageImport(kind, text) {
    const spans = spanAssets();
    // Canonicalising lookup, the same one the form uses, so an aliased spelling of a
    // point is judged by what it resolves to and not rejected as "not in this drawing".
    const lookupNodeForImport = (id) => lookupNode(id);
    const lookupSpan = (id) => spans.find((s) => s.id === id) ?? null;
    const s = state();

    const parsed =
      kind === 'loads'
        ? parseNodeLoadImport(text, {
            loads: s.loads,
            lookupNode: lookupNodeForImport,
            isEligible: (type) => isLoadEligible(type),
            mode: currentMode(),
          })
        : parseSpanLengthImport(text, {
            spanLengths: s.spanLengths,
            lookupSpan,
            mode: currentMode(),
          });

    if (!parsed.ok) {
      showStagedError(kind, parsed);
      return;
    }

    staged = { plan: parsed.plan, text };
    stagedKind = kind;
    showStagedPlan(parsed.plan);
  }

  /** The chosen import mode, defaulting to replace. */
  function currentMode() {
    const checked = document.querySelector('input[name="import-mode"]:checked');
    return checked ? checked.value : 'replace';
  }

  /** Report a refusal without applying anything. */
  function showStagedError(kind, parsed) {
    staged = null;
    stagedKind = null;
    dom.staging.hidden = false;
    dom.stagingHeading.textContent = 'That import was not accepted';
    dom.stagingSummary.textContent = parsed.message;
    dom.stagingDetails.replaceChildren();
    for (const detail of parsed.details ?? []) {
      const li = document.createElement('li');
      li.textContent = detail;
      dom.stagingDetails.appendChild(li);
    }
    // An error cannot be applied, so the button is removed rather than shown
    // greyed out: there is nothing the user can do to it but cancel.
    dom.importApply.disabled = true;
    dom.staging.scrollIntoView({ block: 'nearest' });
    void kind;
  }

  /** Show what the staged plan would change. */
  function showStagedPlan(plan) {
    const what = plan.kind === 'loads' ? 'loads' : 'span lengths';
    dom.staging.hidden = false;
    dom.stagingHeading.textContent =
      plan.mode === 'replace'
        ? `Replace the ${what} with this file?`
        : `Update ${what} from this file?`;
    dom.stagingSummary.textContent = describePlan(plan);
    dom.stagingDetails.replaceChildren();

    if (plan.unresolved.length > 0) {
      for (const orphan of plan.unresolved) {
        const li = document.createElement('li');
        li.textContent =
          `Line ${orphan.line} refers to ${orphan.nodeId ?? orphan.spanId}, which this ` +
          'drawing does not have. It will be kept and left for you to sort out.';
        dom.stagingDetails.appendChild(li);
      }
    }
    dom.importApply.disabled = false;
    dom.staging.scrollIntoView({ block: 'nearest' });
  }

  /** Apply the staged plan. */
  function applyStagedImport() {
    if (!staged) return;
    const plan = { ...staged.plan, mode: currentMode() };
    const s = state();
    if (stagedKind === 'loads') {
      // Re-plan against the chosen mode, so switching to "update" after staging
      // honours the smaller change set the user actually asked for.
      const lookupNodeForImport = (id) => lookupNode(id);
      const parsed = parseNodeLoadImport(staged.text, {
        loads: s.loads,
        lookupNode: lookupNodeForImport,
        isEligible: (type) => isLoadEligible(type),
        mode: plan.mode,
      });
      if (!parsed.ok) {
        showStagedError('loads', parsed);
        return;
      }
      const { loads } = applyNodeLoadPlan(s.loads, parsed.plan, nextLoadId);
      onChange({ loads });
      notify(
        `Imported ${describePlan(parsed.plan)} ${parsed.plan.unresolved.length ? '' : ''}`.trim(),
      );
    } else {
      const spans = spanAssets();
      const lookupSpan = (id) => spans.find((sp) => sp.id === id) ?? null;
      const parsed = parseSpanLengthImport(staged.text, {
        spanLengths: s.spanLengths,
        lookupSpan,
        mode: plan.mode,
      });
      if (!parsed.ok) {
        showStagedError('spans', parsed);
        return;
      }
      onChange({ spanLengths: applySpanPlan(s.spanLengths, parsed.plan) });
      notify(`Imported ${describePlan(parsed.plan)}`);
    }
    clearStaging();
  }

  /** Close the staging panel without applying anything. */
  function clearStaging() {
    staged = null;
    stagedKind = null;
    dom.staging.hidden = true;
    dom.stagingDetails.replaceChildren();
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                        */
  /* ---------------------------------------------------------------- */

  /** Redraw the whole section from the live state. */
  function render() {
    renderSummary();
    renderLoadNodeOptions();
    renderLoadRows();
    renderSpanRows();
    renderUnresolved();
  }

  /**
   * Move an orphaned load onto a point that still exists.
   *
   * The record keeps its id and value, so a load that was on a deleted branch
   * lands on the surviving pole the user chooses rather than being re-entered.
   */
  function reassignLoadNode(load) {
    const nodes = nodeAssets().filter((a) => isLoadEligible(a.nodeType));
    if (nodes.length === 0) {
      notify('There are no poles to move this load to. Add a route first.');
      return;
    }
    const list = nodes.map((n, i) => `${i + 1}. ${n.label ?? n.id} (${n.id})`).join('\n');
    const answer = window.prompt(
      `Move the load ${load.value} ${load.unit} from ${load.nodeId} to which point?` +
        '\n\n' +
        list +
        '\n\nEnter a number:',
    );
    if (answer === null) return;
    const index = Number(answer) - 1;
    const target = nodes[index];
    if (!target) {
      notify('That is not one of the points listed. The load has not been moved.');
      return;
    }
    const result = reassignLoad(state().loads, load.id, target.id);
    if (!result.ok) {
      notify(result.message);
      return;
    }
    onChange({ loads: result.loads });
    notify(`Load moved to ${target.label ?? target.id}.`);
  }

  /** The completeness line at the top. */
  function renderSummary() {
    const s = state();
    const spans = spanAssets();
    const completeness = measureCompleteness(
      s.spanLengths,
      spans.map((sp) => sp.id),
    );
    const loadCount = s.loads.length;

    const parts = [
      `${loadCount} ${loadCount === 1 ? 'load' : 'loads'} recorded`,
      completeness.total === 0
        ? 'no spans yet'
        : completeness.complete
          ? `all ${completeness.total} span lengths measured`
          : `${completeness.assigned} of ${completeness.total} span lengths measured`,
    ];
    dom.summary.replaceChildren();
    const text = document.createElement('span');
    text.textContent = parts.join(' · ');
    dom.summary.appendChild(text);
    if (completeness.total > 0 && !completeness.complete) {
      const note = document.createElement('span');
      note.className = 'is-incomplete';
      note.textContent = ` · ${completeness.unassigned} still to measure`;
      dom.summary.appendChild(note);
    }
  }

  /** The dropdown of points a load can be attached to. */
  function renderLoadNodeOptions() {
    const nodes = nodeAssets().filter((a) => isLoadEligible(a.nodeType));
    const previous = dom.loadNode.value;
    dom.loadNode.replaceChildren();

    if (nodes.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No poles yet';
      dom.loadNode.appendChild(option);
      dom.loadNode.disabled = true;
      dom.addLoad.disabled = true;
      return;
    }

    dom.loadNode.disabled = false;
    dom.addLoad.disabled = false;
    for (const node of nodes) {
      const option = document.createElement('option');
      option.value = node.id;
      // The stable id is what the record is stored against; the label is what the
      // user recognises. Showing both prevents picking the wrong "C" on a drawing
      // that has two of them.
      // The designation is what the schedule shows for this point, so it is what the
      // picker shows first; the id follows so a record can be traced to the file.
      option.textContent = `${node.designation ?? node.label ?? node.id} (${node.id})`;
      dom.loadNode.appendChild(option);
    }
    if (nodes.some((n) => n.id === previous)) dom.loadNode.value = previous;
  }

  /** The load schedule table. */
  function renderLoadRows() {
    const s = state();
    const nodes = nodeAssets();
    const known = new Map(nodes.map((n) => [n.id, n]));
    dom.loadRows.replaceChildren();

    if (s.loads.length === 0) {
      dom.loadEmpty.hidden = false;
      return;
    }
    dom.loadEmpty.hidden = true;

    for (const load of s.loads) {
      const row = document.createElement('tr');
      row.dataset.load = load.id;
      row.dataset.node = load.nodeId;
      if (load.nodeId === selectedNodeId) row.classList.add('is-selected');

      const orphan = !known.has(load.nodeId);
      if (orphan) row.classList.add('is-unresolved');

      // Point: the designation a person says out loud. This is the column the
      // schedule is read by, so it comes first.
      const pointCell = document.createElement('td');
      pointCell.textContent = orphan ? '— (missing)' : nodeLabel(load.nodeId);
      pointCell.className = 'point-designation';
      row.appendChild(pointCell);

      // Internal node id: what the record is actually stored against. Shown beside
      // the name so a reassignment can be checked against the file, and so nobody
      // can mistake a name for an identity.
      const nodeIdCell = document.createElement('td');
      nodeIdCell.textContent = load.nodeId;
      nodeIdCell.className = 'mono-id';
      row.appendChild(nodeIdCell);

      const typeCell = document.createElement('td');
      typeCell.textContent = orphan ? '—' : (known.get(load.nodeId)?.nodeType ?? '—');
      row.appendChild(typeCell);

      const idCell = document.createElement('td');
      idCell.textContent = load.id;
      row.appendChild(idCell);

      const valueCell = document.createElement('td');
      // The value is an editable field rather than text: a survey is corrected
      // often, and making the user delete and re-add to change 25 to 30 would
      // throw away the record's identity.
      const valueInput = document.createElement('input');
      valueInput.type = 'number';
      valueInput.min = '0';
      valueInput.step = 'any';
      valueInput.value = String(load.value);
      valueInput.className = 'inline-number';
      valueInput.setAttribute('aria-label', `Value for ${load.id}`);
      valueInput.addEventListener('change', () => {
        const value = Number(valueInput.value);
        if (!Number.isFinite(value) || value <= 0) {
          notify('A load value must be a number greater than zero. The old value is kept.');
          valueInput.value = String(load.value);
          return;
        }
        onChange({
          loads: state().loads.map((l) => (l.id === load.id ? { ...l, value } : l)),
        });
      });
      valueCell.appendChild(valueInput);
      row.appendChild(valueCell);

      const unitCell = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'unit-badge';
      badge.textContent = load.unit;
      unitCell.appendChild(badge);
      row.appendChild(unitCell);

      const actionCell = document.createElement('td');
      // A record whose point has gone can be moved to a point that still exists,
      // without losing its id or its value. Discarding is a separate decision.
      if (orphan) {
        const reassignBtn = document.createElement('button');
        reassignBtn.type = 'button';
        reassignBtn.className = 'btn btn-small';
        reassignBtn.textContent = 'Reassign';
        reassignBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          reassignLoadNode(load);
        });
        actionCell.appendChild(reassignBtn);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn-small';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        onChange({ loads: removeLoad(state().loads, load.id) });
        notify('Load removed.');
      });
      actionCell.appendChild(removeBtn);
      row.appendChild(actionCell);

      row.addEventListener('click', () => {
        selectedNodeId = load.nodeId;
        options.onSelectNode?.(load.nodeId);
        renderLoadRows();
      });

      dom.loadRows.appendChild(row);
    }
  }

  /** The span length schedule table. */
  function renderSpanRows() {
    const s = state();
    const spans = spanAssets();
    const nodes = new Map(nodeAssets().map((n) => [n.id, n]));
    dom.spanRows.replaceChildren();

    if (spans.length === 0) {
      dom.spanEmpty.hidden = false;
      return;
    }
    dom.spanEmpty.hidden = true;

    // Spans whose measurement refers to something no longer drawn are listed too,
    // marked, rather than hidden: a length the user typed must stay visible so
    // they can decide what to do with it.
    const drawn = new Set(spans.map((sp) => sp.id));
    const orphans = [...s.spanLengths.values()].filter((r) => !drawn.has(r.spanId));

    for (const span of spans) {
      const record = s.spanLengths.get(span.id);
      dom.spanRows.appendChild(
        spanRow({
          spanId: span.id,
          designation: span.designation,
          from: nodes.get(span.fromNodeId ?? span.a)?.designation ?? span.a,
          to: nodes.get(span.toNodeId ?? span.b)?.designation ?? span.b,
          record,
          orphan: false,
        }),
      );
    }
    for (const record of orphans) {
      dom.spanRows.appendChild(
        spanRow({
          spanId: record.spanId,
          designation: '— (not in drawing)',
          from: '—',
          to: '—',
          record,
          orphan: true,
        }),
      );
    }
  }

  /** One row of the span table. */
  function spanRow({ spanId, designation, from, to, record, orphan }) {
    const row = document.createElement('tr');
    row.dataset.span = spanId;
    if (spanId === selectedSpanId) row.classList.add('is-selected');
    if (orphan) row.classList.add('is-unresolved');

    // The readable name of the cable, which is how a row is found in the table.
    const nameCell = document.createElement('td');
    nameCell.textContent = designation;
    nameCell.className = 'span-designation';
    row.appendChild(nameCell);

    const idCell = document.createElement('td');
    idCell.textContent = spanId;
    idCell.className = 'mono-id';
    row.appendChild(idCell);

    const fromCell = document.createElement('td');
    fromCell.textContent = from;
    row.appendChild(fromCell);

    const toCell = document.createElement('td');
    toCell.textContent = to;
    row.appendChild(toCell);

    const lengthCell = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = 'any';
    input.className = 'inline-number';
    input.placeholder = '—';
    input.value = record ? String(Math.round(record.lengthM * 10) / 10) : '';
    input.setAttribute('aria-label', `Length in metres for span ${spanId}`);
    input.addEventListener('change', () => {
      const raw = input.value.trim();
      const next = new Map(state().spanLengths);
      if (raw === '') {
        next.delete(spanId);
        onChange({ spanLengths: next });
        return;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        notify('A span length must be a number greater than zero. Leave it blank if unmeasured.');
        input.value = record ? String(record.lengthM) : '';
        return;
      }
      next.set(spanId, { spanId, lengthM: value });
      onChange({ spanLengths: next });
    });
    lengthCell.appendChild(input);
    row.appendChild(lengthCell);

    const statusCell = document.createElement('td');
    const status = document.createElement('span');
    status.className = 'status-text';
    if (orphan) {
      status.textContent = 'not in drawing';
      status.classList.add('is-missing');
    } else if (record) {
      status.textContent = 'measured';
    } else {
      status.textContent = 'not measured';
      status.classList.add('is-missing');
    }
    statusCell.appendChild(status);
    row.appendChild(statusCell);

    row.addEventListener('click', (event) => {
      if (event.target.tagName === 'INPUT') return;
      selectedSpanId = spanId;
      options.onSelectSpan?.(spanId);
      renderSpanRows();
    });

    return row;
  }

  /** The bar listing records whose point or span is gone. */
  function renderUnresolved() {
    const s = state();
    const nodes = new Set(nodeAssets().map((n) => n.id));
    const spans = new Set(spanAssets().map((sp) => sp.id));
    const orphanLoads = s.loads.filter((l) => !nodes.has(l.nodeId));
    const orphanSpans = [...s.spanLengths.keys()].filter((id) => !spans.has(id));
    const total = orphanLoads.length + orphanSpans.length;

    if (total === 0) {
      dom.unresolvedBar.hidden = true;
      return;
    }
    dom.unresolvedBar.hidden = false;
    const loadWord = orphanLoads.length === 1 ? 'load' : 'loads';
    const spanWord = orphanSpans.length === 1 ? 'length' : 'lengths';
    const parts = [];
    if (orphanLoads.length) parts.push(`${orphanLoads.length} ${loadWord}`);
    if (orphanSpans.length) parts.push(`${orphanSpans.length} span ${spanWord}`);
    const plural = total !== 1;
    dom.unresolvedText.textContent =
      `${parts.join(' and ')} ${plural ? 'refer' : 'refers'} to points or spans this drawing ` +
      `no longer has. ${plural ? 'They are' : 'It is'} kept until you reassign or discard ` +
      `${
        plural ? 'them' : 'it'
      }, so nothing you recorded has been lost.`;
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                          */
  /* ---------------------------------------------------------------- */

  /** Add a load from the form. */
  function handleAddLoad() {
    const nodeId = dom.loadNode.value;
    if (!nodeId) {
      showFormError('Add a route first: a load needs a pole to sit on.');
      return;
    }
    const result = addLoad(state().loads, {
      nodeId,
      value: dom.loadValue.value,
      unit: dom.loadUnit.value,
      lookupNode,
    });
    if (!result.ok) {
      showFormError(result.message);
      return;
    }
    hideFormError();
    onChange({ loads: result.loads });
    dom.loadValue.value = '';
    dom.loadValue.focus();
    notify('Load added.');
  }

  function showFormError(message) {
    dom.loadFormError.hidden = false;
    dom.loadFormError.textContent = message;
  }

  function hideFormError() {
    dom.loadFormError.hidden = true;
    dom.loadFormError.textContent = '';
  }

  /** Fill every unmeasured span with the entered default. */
  function handleApplyDefault() {
    const raw = dom.defaultLength.value.trim();
    if (raw === '') {
      notify('Enter a default length first.');
      return;
    }
    const spans = spanAssets().map((sp) => sp.id);
    const result = applyDefaultLength(state().spanLengths, spans, raw);
    if (!result.ok) {
      notify(result.message);
      return;
    }
    onChange({ spanLengths: result.spanLengths });
    if (result.updated === 0) {
      notify('Every span already has a length, so nothing was changed.');
    } else {
      notify(
        `Filled ${result.updated} ${result.updated === 1 ? 'span' : 'spans'}` +
          (result.skipped ? `, leaving ${result.skipped} already measured.` : '.'),
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                           */
  /* ---------------------------------------------------------------- */

  function selectTab(index) {
    dom.tabs.forEach((tab, i) => {
      const active = i === index;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      dom.panels[i].hidden = !active;
    });
  }

  dom.tabs.forEach((tab, i) => tab.addEventListener('click', () => selectTab(i)));

  dom.addLoad.addEventListener('click', handleAddLoad);
  dom.loadValue.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleAddLoad();
    }
  });

  dom.applyDefault.addEventListener('click', handleApplyDefault);

  dom.loadsTsv.addEventListener('click', async () => {
    const text = nodeLoadsToTsv(nodeAssets(), state().loads, (t) => isLoadEligible(t));
    const ok = await copyText(text);
    notify(
      ok
        ? 'Node loads copied. Paste them into a spreadsheet; the header row is included.'
        : 'The browser refused clipboard access. Use Export CSV instead.',
    );
  });

  dom.loadsCsv.addEventListener('click', () => {
    download(nodeLoadsToCsv(nodeAssets(), state().loads, (t) => isLoadEligible(t)), NODE_LOAD_FILE, 'text/csv');
    notify(`Node loads exported as ${NODE_LOAD_FILE}.`);
  });

  dom.loadsImport.addEventListener('click', () => askForText('loads'));

  dom.spansTsv.addEventListener('click', async () => {
    const nodes = new Map(nodeAssets().map((n) => [n.id, n]));
    const text = spanLengthsToTsv(spanAssets(), state().spanLengths, (id) => nodes.get(id) ?? null);
    const ok = await copyText(text);
    notify(
      ok
        ? 'Span lengths copied. Paste them into a spreadsheet; the header row is included.'
        : 'The browser refused clipboard access. Use Export CSV instead.',
    );
  });

  dom.spansCsv.addEventListener('click', () => {
    const nodes = new Map(nodeAssets().map((n) => [n.id, n]));
    download(
      spanLengthsToCsv(spanAssets(), state().spanLengths, (id) => nodes.get(id) ?? null),
      SPAN_LENGTH_FILE,
      'text/csv',
    );
    notify(`Span lengths exported as ${SPAN_LENGTH_FILE}.`);
  });

  dom.spansImport.addEventListener('click', () => askForText('spans'));

  dom.importApply.addEventListener('click', applyStagedImport);
  dom.importCancel.addEventListener('click', clearStaging);
  document.querySelectorAll('input[name="import-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (staged && stagedKind) {
        // Re-stage so the summary reflects the mode the user just picked.
        stageImport(stagedKind, staged.text);
      }
    });
  });

  dom.unresolvedReview.addEventListener('click', () => {
    selectTab(0);
    const first = dom.loadRows.querySelector('tr.is-unresolved');
    if (first) {
      first.scrollIntoView({ block: 'center' });
      first.classList.add('is-selected');
      selectedNodeId = first.dataset.node;
      options.onSelectNode?.(selectedNodeId);
    }
  });

  dom.unresolvedDiscard.addEventListener('click', () => {
    const s = state();
    const nodes = new Set(nodeAssets().map((n) => n.id));
    const spans = new Set(spanAssets().map((sp) => sp.id));
    const orphanLoads = s.loads.filter((l) => !nodes.has(l.nodeId));
    const orphanSpans = [...s.spanLengths.keys()].filter((id) => !spans.has(id));
    const total = orphanLoads.length + orphanSpans.length;
    if (total === 0) return;

    const confirmed = window.confirm(
      `Discard ${total} ${total === 1 ? 'record' : 'records'} that no longer belong to ` +
        'this drawing?\n\nThis cannot be undone.',
    );
    if (!confirmed) return;

    let loads = s.loads;
    for (const load of orphanLoads) loads = removeLoad(loads, load.id);
    const spanLengths = new Map(s.spanLengths);
    for (const spanId of orphanSpans) spanLengths.delete(spanId);
    onChange({ loads, spanLengths });
    notify('The records that no longer belonged to this drawing were discarded.');
  });

  /** Select a node from the drawing, so the table follows the click. */
  function selectNode(nodeId) {
    selectedNodeId = nodeId;
    selectTab(0);
    renderLoadRows();
    const row = dom.loadRows.querySelector(`tr[data-node="${CSS.escape(nodeId)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }

  /** Select a span from the drawing. */
  function selectSpan(spanId) {
    selectedSpanId = spanId;
    selectTab(1);
    renderSpanRows();
    const row = dom.spanRows.querySelector(`tr[data-span="${CSS.escape(spanId)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }

  return { render, selectTab, clearStaging, selectNode, selectSpan };
}

export { removeLoadsForNode, reassignLoad, parseDelimited, toDelimited, detectDelimiter, SPAN_LENGTH_COLUMNS, LOAD_UNITS };
