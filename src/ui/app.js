/**
 * Application controller: wires the route instruction table, the drawing
 * preview and the output actions to the geometry core.
 *
 * Responsibilities are deliberately narrow. This module owns DOM state and
 * user interaction; it never computes network geometry. Every coordinate it
 * draws comes from `buildScene`, and every file it writes comes from a
 * renderer that consumes that same scene.
 */

import { EXAMPLE_ROUTES, createConfig, PAGE_LAYOUTS } from '../config.js';
import { buildNetwork } from '../geometry/network.js';
import { buildScene } from '../geometry/scene.js';
import { checkSpanClearance, requiredSpanLength } from '../geometry/clearance.js';
import {
  parseProjectJson,
  projectFileName,
  serializeProjectJson,
} from './project.js';
import { loadFromStorage, saveToStorage } from './storage.js';
import { renderSceneToSvg } from '../render/svg.js';
import { renderSceneToPdf } from '../render/pdf.js';
import {
  createRoute,
  createState,
  latestSource,
  sourcesForRow,
  endpointLabel,
} from './state.js';
import { resolveExampleRoutes } from './example.js';

const DIRECTIONS = ['north', 'south', 'east', 'west'];

/** Unique instruction id factory used by the example loader. */
function nextRouteIdValue() {
  return createRoute({}).id;
}
const MIN_SPACING = 12;
/** Smallest spacing at which the marker symbols keep their clearance. */
const REQUIRED_SPACING = requiredSpanLength();
const MAX_SPACING = 120;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 6;

const el = (id) => document.getElementById(id);

const dom = {
  form: el('route-form'),
  from: el('field-from'),
  direction: el('field-direction'),
  spans: el('field-spans'),
  tc: el('field-tc'),
  fpb: el('field-fpb'),
  originMarker: el('field-origin-marker'),
  spacingWarning: el('spacing-warning'),
  persistenceNotice: el('persistence-notice'),
  saveProject: el('btn-save-project'),
  loadProject: el('btn-load-project'),
  projectFile: el('field-project-file'),
  saveRoute: el('btn-save-route'),
  cancelEdit: el('btn-cancel-edit'),
  formError: el('form-error'),
  rows: el('route-rows'),
  emptyState: el('empty-state'),
  errorList: el('error-list'),
  loadExample: el('btn-load-example'),
  clearAll: el('btn-clear'),
  spacing: el('field-spacing'),
  layout: el('field-layout'),
  stage: el('preview-stage'),
  canvas: el('preview-canvas'),
  previewEmpty: el('preview-empty'),
  zoomIn: el('btn-zoom-in'),
  zoomOut: el('btn-zoom-out'),
  fit: el('btn-fit'),
  reset: el('btn-reset'),
  pdf: el('btn-pdf'),
  svg: el('btn-svg'),
  print: el('btn-print'),
  exportStatus: el('export-status'),
};

const state = createState();
/** Viewport transform applied to the preview canvas. */
const view = { zoom: 1, x: 0, y: 0 };
/** Latest derived model, refreshed on every change. */
let current = { network: buildNetwork([]), scene: null };

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

/** Anything reported about saving, shown discreetly rather than as a dialog. */
let persistenceNotice = null;

/**
 * Remember the current project in the browser.
 *
 * Called after every action that changes what the user has authored. A failure
 * is reported but never thrown: losing the ability to remember is not a reason
 * to stop them drawing.
 */
function persistProject() {
  const result = saveToStorage({
    routes: state.routes,
    originMarker: state.originMarker,
    spanLength: state.spanLength,
    layout: state.layout,
  });
  persistenceNotice = result.ok ? null : result.message;
  renderPersistenceNotice();
  return result;
}

/** Show or clear the storage notice next to the project actions. */
function renderPersistenceNotice() {
  if (!dom.persistenceNotice) return;
  if (!persistenceNotice) {
    dom.persistenceNotice.hidden = true;
    dom.persistenceNotice.textContent = '';
    return;
  }
  dom.persistenceNotice.hidden = false;
  dom.persistenceNotice.textContent = persistenceNotice;
}

/**
 * Apply a validated project to the live state.
 *
 * The project arrives already validated and rebuilt through the geometry
 * engine, so this only assigns it. Derived data is rebuilt by `refresh`, which
 * is the same path a fresh example takes.
 *
 * @param {object} project Validated project.
 * @param {{refit?: boolean}} [options]
 */
function applyProject(project, options = {}) {
  state.routes = project.routes.map((route) =>
    createRoute({
      from: route.from,
      direction: route.direction,
      spans: route.spans,
      tc: route.tc,
      fpb: route.fpb,
    }),
  );
  state.originMarker = project.originMarker;
  state.spanLength = project.spanLength;
  state.layout = project.layout;
  state.selectedId = null;

  dom.spacing.value = String(state.spanLength);
  dom.layout.value = state.layout;
  dom.originMarker.value = state.originMarker;
  clearForm();
  refresh({ refit: options.refit ?? true });
}

/**
 * Restore the remembered project at startup.
 *
 * Precedence: a readable project wins; nothing remembered falls through to the
 * example; an unreadable project is reported and left alone rather than
 * overwritten, with the example shown so the session is still usable.
 *
 * @returns {boolean} True when a remembered project was applied.
 */
function restoreOrStart() {
  const result = loadFromStorage();

  if (result.status === 'ok') {
    applyProject(result.project, { refit: true });
    return true;
  }

  if (result.status === 'invalid') {
    // Deliberately do not overwrite: the user's data is still there and a
    // corrected build may be able to read it.
    persistenceNotice = result.message;
    renderPersistenceNotice();
    loadExample();
    return false;
  }

  if (result.status === 'unavailable') {
    persistenceNotice = result.message;
    renderPersistenceNotice();
  }

  loadExample();
  return false;
}

/** Save the project to a downloadable file. */
function saveProjectFile() {
  const text = serializeProjectJson({
    routes: state.routes,
    originMarker: state.originMarker,
    spanLength: state.spanLength,
    layout: state.layout,
  });
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = projectFileName();
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Read a chosen file and open it as the project.
 *
 * Nothing is applied until the whole file has been validated, so a bad file
 * leaves the current drawing exactly as it was. The text is only ever parsed as
 * data: nothing from the file is executed.
 *
 * @param {File} file Chosen file.
 */
async function loadProjectFile(file) {
  let text;
  try {
    text = await file.text();
  } catch {
    persistenceNotice = 'That file could not be read. Choose a project file saved by this tool.';
    renderPersistenceNotice();
    return;
  }

  const parsed = parseProjectJson(text);
  if (!parsed.ok) {
    persistenceNotice = parsed.message;
    renderPersistenceNotice();
    return;
  }

  const hasWork = state.routes.length > 0;
  if (hasWork) {
    const proceed = window.confirm(
      'Open this project and replace the drawing on screen? ' +
        'The current drawing is not kept.',
    );
    if (!proceed) return;
  }

  applyProject(parsed.project, { refit: true });
  persistenceNotice = null;
  renderPersistenceNotice();
  // Opening a project is a change like any other, so it becomes what a reload
  // restores.
  persistProject();
}

/* ------------------------------------------------------------------ */
/* Derived model                                                       */
/* ------------------------------------------------------------------ */

/** Rebuild the canonical network and the preview scene from the routes. */
function recompute() {
  const network = buildNetwork(state.routes, { originMarker: state.originMarker });
  const scene = buildScene(network, 'preview', { spanLength: state.spanLength });
  current = { network, scene };
  return current;
}

/** True when the current route list is valid and therefore exportable. */
function isExportable() {
  return current.network.ok && state.routes.length > 0 && spacingVerdict().ok;
}

/**
 * Whether the chosen spacing leaves room for the marker symbols.
 *
 * A spacing this tight would overlap the symbols and trim the route lines away,
 * so the drawing is refused rather than silently produced wrong.
 */
function spacingVerdict() {
  return checkSpanClearance(state.spanLength);
}

/* ------------------------------------------------------------------ */
/* Rendering: preview                                                  */
/* ------------------------------------------------------------------ */

function applyView() {
  dom.canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  dom.canvas.style.width = `${current.scene ? current.scene.width : 0}px`;
  dom.canvas.style.height = `${current.scene ? current.scene.height : 0}px`;
}

function renderPreview() {
  const { scene } = current;
  if (!scene || scene.lines.length === 0) {
    dom.canvas.innerHTML = '';
    dom.previewEmpty.hidden = false;
    return;
  }
  dom.previewEmpty.hidden = true;
  dom.canvas.innerHTML = renderSceneToSvg(scene, { standalone: false });
  applyView();
}

/** Scale the drawing to fit the stage with a little breathing room. */
function fitToScreen() {
  const stageRect = dom.stage.getBoundingClientRect();
  const scene = current.scene;
  if (!scene || !stageRect.width || !stageRect.height) return;
  const scale = Math.min(stageRect.width / scene.width, stageRect.height / scene.height) * 0.94;
  view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
  view.x = (stageRect.width - scene.width * view.zoom) / 2;
  view.y = (stageRect.height - scene.height * view.zoom) / 2;
  applyView();
}

function zoomBy(factor, originX, originY) {
  const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  const stageRect = dom.stage.getBoundingClientRect();
  const px = originX ?? stageRect.width / 2;
  const py = originY ?? stageRect.height / 2;
  // Keep the point under the cursor stationary while scaling.
  view.x = px - ((px - view.x) * nextZoom) / view.zoom;
  view.y = py - ((py - view.y) * nextZoom) / view.zoom;
  view.zoom = nextZoom;
  applyView();
}

function resetView() {
  view.zoom = 1;
  view.x = 0;
  view.y = 0;
  applyView();
}

/* ------------------------------------------------------------------ */
/* Rendering: route table                                              */
/* ------------------------------------------------------------------ */

/**
 * Text for a route's marker column.
 *
 * @param {object} route Route instruction.
 * @returns {string} `TC`, `FPB` or `No`.
 */
function markerCellText(route) {
  if (route.fpb) return 'FPB';
  if (route.tc) return 'TC';
  return 'No';
}

/**
 * Resolve the display text of a route's source, including the case where the
 * reference can no longer be resolved (an earlier row was edited or deleted).
 */
function describeSource(network, route, index) {
  const resolved = network.routes[index];
  if (resolved && resolved.ok) {
    const endpoint = network.endpoints.find((e) => e.id === resolved.sourceId);
    if (endpoint) return endpointLabel(endpoint);
  }
  const prefix = buildNetwork(state.routes.slice(0, index));
  const known = prefix.endpoints.find((e) => e.id === route.from);
  if (known) return endpointLabel(known);
  return 'not available';
}

function renderTable() {
  const { network } = current;
  const rows = [];
  dom.rows.innerHTML = '';

  state.routes.forEach((route, index) => {
    const resolved = network.routes[index];
    const tr = document.createElement('tr');
    tr.dataset.id = route.id;
    if (state.selectedId === route.id) tr.classList.add('is-selected');
    if (resolved && !resolved.ok) tr.classList.add('is-invalid');

    const directionLabel = route.direction.charAt(0).toUpperCase() + route.direction.slice(1);
    const sourceText = describeSource(network, route, index);
    const statusText = resolved && resolved.ok ? 'Valid' : 'Invalid';

    tr.innerHTML = `
      <td class="cell-index">${index + 1}</td>
      <td class="cell-from"></td>
      <td>${directionLabel}</td>
      <td>${Number(route.spans)}</td>
      <td>${markerCellText(route)}</td>
      <td><span class="${resolved && resolved.ok ? 'status-ok' : 'status-bad'}">${statusText}</span></td>
      <td class="cell-actions">
        <button type="button" class="btn btn-small" data-action="edit">Edit</button>
        <button type="button" class="btn btn-small btn-quiet" data-action="delete">Delete</button>
      </td>
    `;
    // Source text is inserted as text, never as markup.
    tr.querySelector('.cell-from').textContent = sourceText;
    rows.push(tr);
    dom.rows.appendChild(tr);
  });

  dom.emptyState.hidden = state.routes.length > 0;
}

/** Render validation errors in a readable list. */
function renderErrors() {
  const { network } = current;
  dom.errorList.innerHTML = '';
  if (network.errors.length === 0) {
    dom.errorList.hidden = true;
    return;
  }
  dom.errorList.hidden = false;
  const heading = document.createElement('h3');
  heading.textContent = network.errors.length === 1 ? '1 route needs attention' : `${network.errors.length} routes need attention`;
  const list = document.createElement('ul');
  for (const error of network.errors) {
    const item = document.createElement('li');
    item.textContent = error.message;
    list.appendChild(item);
  }
  dom.errorList.append(heading, list);
}

/* ------------------------------------------------------------------ */
/* Rendering: the From dropdown                                        */
/* ------------------------------------------------------------------ */

/**
 * Refresh the From dropdown for the row currently in the form.
 *
 * Only endpoints that exist at that point in the sequence are offered, so a
 * forward reference cannot be entered in the first place.
 */
function refreshFromOptions() {
  const editingIndex = state.selectedId
    ? state.routes.findIndex((r) => r.id === state.selectedId)
    : state.routes.length;
  const index = editingIndex < 0 ? state.routes.length : editingIndex;
  const currentRoute = state.selectedId ? state.routes.find((r) => r.id === state.selectedId) : null;
  const currentFrom = currentRoute ? currentRoute.from : dom.from.value;

  const options = sourcesForRow(state.routes, index, currentFrom, {
    originMarker: state.originMarker,
  });
  // While editing a row, the row's own source is the value that must survive
  // the rebuild. When adding a new route, the most recently created endpoint
  // is preselected, which is the common case: continue from where you stopped.
  const previous = currentRoute
    ? currentRoute.from
    : latestSource(state.routes, { originMarker: state.originMarker }).id;

  dom.from.innerHTML = '';
  if (options.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = endpointLabel({ kind: 'origin', name: 'Origin' }, state.originMarker);
    dom.from.appendChild(opt);
    return;
  }
  for (const source of options) {
    const opt = document.createElement('option');
    opt.value = source.id;
    opt.textContent = source.label;
    dom.from.appendChild(opt);
  }
  const keep = options.some((o) => o.id === previous) ? previous : options[0].id;
  dom.from.value = keep;
}

/* ------------------------------------------------------------------ */
/* Full refresh                                                        */
/* ------------------------------------------------------------------ */

function refresh({ refit = false } = {}) {
  recompute();
  renderTable();
  renderErrors();
  renderPreview();
  refreshFromOptions();
  updateOutputButtons();
  if (refit) fitToScreen();
}

function updateOutputButtons() {
  const ok = isExportable();
  const spacing = spacingVerdict();
  for (const button of [dom.pdf, dom.svg, dom.print]) {
    button.disabled = !ok;
    if (ok) {
      button.title = '';
    } else if (!spacing.ok) {
      button.title = spacing.message;
    } else {
      button.title = 'Fix the route errors before exporting.';
    }
  }
  showSpacingWarning(spacing);
}

/**
 * Show the spacing problem next to the drawing, or clear it.
 *
 * The user's chosen spacing is never changed for them: the message says what is
 * wrong and which value will work, and the preview keeps showing their choice.
 */
function showSpacingWarning(spacing) {
  if (!dom.spacingWarning) return;
  if (spacing.ok) {
    dom.spacingWarning.hidden = true;
    dom.spacingWarning.textContent = '';
    dom.spacingWarning.removeAttribute('data-required');
    return;
  }
  dom.spacingWarning.hidden = false;
  dom.spacingWarning.textContent = spacing.message;
  dom.spacingWarning.setAttribute('data-required', String(spacing.required));
}

/* ------------------------------------------------------------------ */
/* Form handling                                                       */
/* ------------------------------------------------------------------ */

function showFormError(message) {
  if (!message) {
    dom.formError.hidden = true;
    dom.formError.textContent = '';
    return;
  }
  dom.formError.hidden = false;
  dom.formError.textContent = message;
}

/** Reset the form to "add a new route" mode. */
function clearForm() {
  state.selectedId = null;
  dom.spans.value = '1';
  dom.tc.checked = false;
  dom.fpb.checked = false;
  dom.saveRoute.textContent = 'Add route';
  dom.cancelEdit.hidden = true;
  showFormError('');
  refreshFromOptions();
  renderTable();
}

/** Load an existing row into the form for editing. */
function startEdit(routeId) {
  const route = state.routes.find((r) => r.id === routeId);
  if (!route) return;
  state.selectedId = route.id;
  dom.direction.value = route.direction;
  dom.spans.value = String(route.spans);
  dom.tc.checked = Boolean(route.tc);
  dom.fpb.checked = Boolean(route.fpb);
  dom.saveRoute.textContent = 'Save changes';
  dom.cancelEdit.hidden = false;
  showFormError('');
  refreshFromOptions();
  dom.from.value = route.from;
  renderTable();
  dom.spans.focus();
}

/** Validate the form input before it reaches the route list. */
function readForm() {
  const spansRaw = dom.spans.value.trim();
  const spans = Number(spansRaw);
  if (spansRaw === '' || !Number.isFinite(spans)) {
    return { error: 'Enter a whole number of spans greater than zero.' };
  }
  if (!Number.isInteger(spans)) {
    return { error: 'Spans must be a whole number (no decimals).' };
  }
  if (spans <= 0) {
    return { error: 'Spans must be greater than zero.' };
  }
  if (spans > 500) {
    return { error: 'Use 500 spans or fewer for one route.' };
  }
  if (!DIRECTIONS.includes(dom.direction.value)) {
    return { error: 'Choose a direction: North, South, East or West.' };
  }
  if (!dom.from.value) {
    return { error: 'Choose the starting point for this route.' };
  }
  if (dom.tc.checked && dom.fpb.checked) {
    return { error: 'A destination is either a TC point or a feeder pillar box (FPB), not both.' };
  }
  return {
    value: {
      from: dom.from.value,
      direction: dom.direction.value,
      spans,
      tc: dom.tc.checked,
      fpb: dom.fpb.checked,
    },
  };
}

function handleSubmit(event) {
  event.preventDefault();
  const result = readForm();
  if (result.error) {
    showFormError(result.error);
    return;
  }
  showFormError('');

  if (state.selectedId) {
    const index = state.routes.findIndex((r) => r.id === state.selectedId);
    if (index >= 0) {
      const previousTc = state.routes[index].tc;
      state.routes[index] = { ...state.routes[index], ...result.value };
      // A TC flag change can alter which endpoints exist downstream, so the
      // whole list is re-evaluated by refresh(). Nothing is dropped.
      void previousTc;
    }
  } else {
    state.routes.push(createRoute(result.value));
  }

  clearForm();
  refresh({ refit: state.routes.length > 0 });
  persistProject();
}

function handleTableClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) {
    const row = event.target.closest('tr[data-id]');
    if (row) startEdit(row.dataset.id);
    return;
  }
  const row = button.closest('tr[data-id]');
  if (!row) return;
  const index = state.routes.findIndex((r) => r.id === row.dataset.id);
  if (button.dataset.action === 'edit' && index >= 0) {
    startEdit(row.dataset.id);
  } else if (button.dataset.action === 'delete' && index >= 0) {
    state.routes.splice(index, 1);
    if (state.selectedId === row.dataset.id) clearForm();
    refresh({ refit: true });
    persistProject();
  }
}

function loadExample() {
  // The example is authored with display names; resolve them to internal ids
  // through the same sequential rules the geometry engine applies.
  state.routes = resolveExampleRoutes(EXAMPLE_ROUTES, nextRouteIdValue);
  clearForm();
  refresh({ refit: true });
  persistProject();
}

function clearAll() {
  state.routes = [];
  clearForm();
  refresh({ refit: false });
  // Clearing is a project state like any other. Saving it means a reload shows
  // an empty drawing rather than resurrecting what was just cleared.
  persistProject();
}

/* ------------------------------------------------------------------ */
/* Exports                                                            */
/* ------------------------------------------------------------------ */

function requireExportable() {
  if (!isExportable()) {
    dom.exportStatus.textContent = 'Fix the route errors before exporting.';
    return false;
  }
  return true;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Release the object URL on the next tick so the download can start.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportPdf() {
  if (!requireExportable()) return;
  const jsPDF = window.jspdf && window.jspdf.jsPDF;
  if (typeof jsPDF !== 'function') {
    dom.exportStatus.textContent = 'The PDF library did not load. Reload the page and try again.';
    return;
  }
  const scene = buildScene(current.network, 'pdf', { spanLength: state.spanLength });
  const { doc, layout } = renderSceneToPdf(scene, { jsPDF, layout: state.layout });
  doc.save('line-route-drawing.pdf');
  dom.exportStatus.textContent = `PDF downloaded (${layout.label}).`;
}

function exportSvg() {
  if (!requireExportable()) return;
  const scene = buildScene(current.network, 'svg', { spanLength: state.spanLength });
  const svg = renderSceneToSvg(scene, { standalone: true, background: '#ffffff' });
  downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), 'line-route-drawing.svg');
  dom.exportStatus.textContent = 'SVG downloaded. Insert it with Insert > Pictures in Word or PowerPoint.';
}

function printDrawing() {
  if (!requireExportable()) return;
  const scene = buildScene(current.network, 'print', { spanLength: state.spanLength });
  const layout = PAGE_LAYOUTS[state.layout] ?? PAGE_LAYOUTS.a4_landscape;
  const orientation = layout.orientation === 'portrait' ? 'portrait' : 'landscape';

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);

  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Line route drawing</title>' +
      '<style>@page{size:' +
      (layout.orientation === 'portrait' ? 'A4 portrait' : 'A4 landscape') +
      ';margin:10mm}html,body{margin:0;padding:0}svg{display:block;width:100%;height:auto}' +
      '</style></head><body>' +
      renderSceneToSvg(scene, { standalone: false }) +
      '</body></html>',
  );
  doc.close();

  const done = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  };
  if (doc.readyState === 'complete') {
    setTimeout(done, 60);
  } else {
    frame.onload = () => setTimeout(done, 60);
  }
  dom.exportStatus.textContent = `Sent to the print dialog (${layout.label}, ${orientation}).`;
}

/* ------------------------------------------------------------------ */
/* Preview interaction                                                */
/* ------------------------------------------------------------------ */

let panning = false;
let panStart = null;
const EDITING_TAGS = new Set(['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA', 'LABEL']);

function setupPreviewInteraction() {
  dom.stage.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, input, select')) return;
    panning = true;
    panStart = { x: event.clientX - view.x, y: event.clientY - view.y };
    dom.stage.classList.add('is-panning');
    dom.stage.setPointerCapture(event.pointerId);
  });

  dom.stage.addEventListener('pointermove', (event) => {
    if (!panning || !panStart) return;
    view.x = event.clientX - panStart.x;
    view.y = event.clientY - panStart.y;
    applyView();
  });

  const endPan = (event) => {
    if (!panning) return;
    panning = false;
    panStart = null;
    dom.stage.classList.remove('is-panning');
    if (dom.stage.hasPointerCapture?.(event.pointerId)) {
      dom.stage.releasePointerCapture(event.pointerId);
    }
  };
  dom.stage.addEventListener('pointerup', endPan);
  dom.stage.addEventListener('pointercancel', endPan);

  dom.stage.addEventListener(
    'wheel',
    (event) => {
      if (!current.scene || current.scene.lines.length === 0) return;
      event.preventDefault();
      const rect = dom.stage.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomBy(factor, event.clientX - rect.left, event.clientY - rect.top);
    },
    { passive: false },
  );

  dom.zoomIn.addEventListener('click', () => zoomBy(1.25));
  dom.zoomOut.addEventListener('click', () => zoomBy(1 / 1.25));
  dom.fit.addEventListener('click', () => fitToScreen());
  dom.reset.addEventListener('click', () => resetView());
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

function setupEventListeners() {
  dom.form.addEventListener('submit', handleSubmit);
  dom.cancelEdit.addEventListener('click', () => clearForm());
  dom.rows.addEventListener('click', handleTableClick);
  dom.loadExample.addEventListener('click', loadExample);
  dom.clearAll.addEventListener('click', clearAll);
  dom.pdf.addEventListener('click', exportPdf);
  dom.svg.addEventListener('click', exportSvg);
  dom.print.addEventListener('click', printDrawing);
  dom.saveProject.addEventListener('click', saveProjectFile);
  dom.loadProject.addEventListener('click', () => dom.projectFile.click());
  dom.projectFile.addEventListener('change', () => {
    const file = dom.projectFile.files && dom.projectFile.files[0];
    if (!file) return;
    loadProjectFile(file);
    // Reset so choosing the same file twice fires `change` again.
    dom.projectFile.value = '';
  });

  dom.spacing.addEventListener('change', () => {
    const value = Number(dom.spacing.value);
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(MAX_SPACING, Math.max(MIN_SPACING, Math.round(value)));
    dom.spacing.value = String(clamped);
    state.spanLength = clamped;
    refresh({ refit: true });
    persistProject();
  });

  dom.originMarker.addEventListener('change', () => {
    state.originMarker = dom.originMarker.value;
    // Rebuild the dropdown so its Origin label matches the symbol now drawn.
    refresh({ refit: false });
    persistProject();
  });

  dom.layout.addEventListener('change', () => {
    state.layout = dom.layout.value;
    updateOutputButtons();
    persistProject();
  });

  // Keep the dropdown honest while the user changes the form.
  dom.direction.addEventListener('change', () => {
    // A direction change on an existing row can invalidate dependents, but that
    // is reported after saving. Nothing is applied on the fly.
  });

  window.addEventListener('resize', () => {
    if (current.scene && current.scene.lines.length > 0) fitToScreen();
  });
}

function boot() {
  setupEventListeners();
  setupPreviewInteraction();
  dom.spacing.value = String(state.spanLength);
  dom.spacing.min = String(REQUIRED_SPACING);
  dom.layout.value = state.layout;
  dom.originMarker.value = state.originMarker;
  refresh();
  dom.exportStatus.textContent = '';
  // A remembered project is restored; otherwise the example keeps the tool
  // immediately useful on a first visit.
  restoreOrStart();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
