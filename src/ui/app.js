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
import { createSpanLengths } from '../data/schedules.js';
import { createNetworkPanel } from './network_panel.js';
import { buildAssetRegistry, spanAssetId } from '../geometry/assets.js';
import { checkSpanClearance, requiredSpanLength } from '../geometry/clearance.js';
import {
  parseProjectJson,
  projectFileName,
  sameAuthoredProject,
  serializeProjectJson,
} from './project.js';
import { clearStorage, loadFromStorage, saveToStorage } from './storage.js';
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
  recoveryBar: el('recovery-bar'),
  recoveryText: el('recovery-text'),
  recoveryDiscard: el('btn-recovery-discard'),
  recoveryNew: el('btn-recovery-new'),
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

/**
 * The Network Data section.
 *
 * It reads the live state through these callbacks rather than holding a second
 * copy, so the tables, the drawing and the file can never disagree about what has
 * been recorded.
 */
let networkPanel = null;

/** Apply a measured-data change and persist it, without rebuilding the routes. */
function applyMeasuredChange(patch) {
  if ('loads' in patch) state.loads = patch.loads;
  if ('spanLengths' in patch) state.spanLengths = patch.spanLengths;
  if ('loadPlacements' in patch) state.loadPlacements = patch.loadPlacements;
  if ('spanPlacements' in patch) state.spanPlacements = patch.spanPlacements;
  // The drawing depends on the measurements (annotations are drawn from them), so
  // the preview must be rebuilt; the routes themselves are untouched.
  recompute();
  renderPreview();
  networkPanel?.render();
  persistProject();
}

/** Report a result to the user in the existing status line. */
function notify(message) {
  dom.exportStatus.textContent = message;
}
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
 * Set while a saved project exists that this build could not read.
 *
 * Automatic saving is paused for the whole of it. The stored value is the only
 * copy of whatever the user had, so writing over it - even with an unchanged
 * drawing, even on a reload - would destroy data nobody asked to lose. Only the
 * user's explicit decision releases this.
 */
let recoveryPending = false;

/** The sentence shown in the recovery bar while it is pending. */
let recoveryNotice = null;

/**
 * Remember the current project in the browser.
 *
 * Called after every action that changes what the user has authored. A failure
 * is reported but never thrown: losing the ability to remember is not a reason
 * to stop them drawing.
 *
 * While recovery is pending nothing is written. This is the single gate that
 * keeps an unreadable project intact: every mutation in the app funnels through
 * here, so none of them can reach storage by another path.
 */
function persistProject() {
  if (recoveryPending) {
    return { ok: false, code: 'RECOVERY_PENDING', message: null, savedAt: null };
  }
  const result = saveToStorage(authoredProject());
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
  // The saved ids come back unchanged. Regenerating them would be invisible
  // until something referred to one - a selection, an edit, a delete - and then
  // the wrong row would be affected.
  state.routes = project.routes.map((route) =>
    createRoute({
      id: route.id,
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
  // The measurements come back exactly as saved. A load keeps its record identity
  // and its node asset id, so an unrelated edit elsewhere cannot move it.
  state.loads = Array.isArray(project.loads) ? project.loads : [];
  state.spanLengths = project.spanLengths instanceof Map ? project.spanLengths : createSpanLengths();
  state.loadPlacements = project.loadPlacements ?? {};
  state.spanPlacements = project.spanPlacements ?? {};
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
 * Four outcomes are reported differently, because they ask different things of
 * the user and confusing them is what loses data:
 *
 *   - `restored`     a saved project was read and applied. Normal.
 *   - `empty`        nothing was ever saved. The example is shown.
 *   - `unavailable`  storage cannot be used. Reported as a limitation, not a
 *                    fault, and the example is shown.
 *   - `recovery`     something is saved but this build cannot read it. The copy
 *                    is left exactly as it is and automatic saving stops until
 *                    the user decides.
 *
 * @returns {'restored'|'empty'|'unavailable'|'recovery'} What happened.
 */
function restoreOrStart() {
  const result = loadFromStorage();

  if (result.status === 'ok') {
    applyProject(result.project, { refit: true });
    return 'restored';
  }

  if (result.status === 'invalid') {
    // Recovery, not an empty state. Nothing is written from here on: the stored
    // value is the user's only copy and only an explicit choice may replace it.
    recoveryPending = true;
    showRecovery(result.message, result.raw);
    // The session stays usable. The example is shown with persistence paused,
    // so working on it cannot touch what is stored.
    loadExample();
    return 'recovery';
  }

  if (result.status === 'unavailable') {
    persistenceNotice = result.message;
    renderPersistenceNotice();
    loadExample();
    return 'unavailable';
  }

  loadExample();
  return 'empty';
}

/**
 * Show the recovery bar for an unreadable saved project.
 *
 * Kept as a distinct, persistent element rather than the ordinary notice: it
 * stays on screen until the user resolves it, because it describes a state that
 * outlives any single action.
 *
 * @param {string} message What is wrong, in the user's terms.
 * @param {string} [raw] The stored text, so its length can be reported.
 */
function showRecovery(message, raw) {
  const detail =
    'Your saved drawing is still in this browser and has not been changed. ' +
    'It could not be opened here, so automatic saving is paused until you decide ' +
    'what to do with it. You can keep working, and Save project will download ' +
    'what is on screen now.';
  const size = typeof raw === 'string' ? ` (${raw.length} characters)` : '';

  recoveryNotice = `${message} ${detail} Saved copy${size}.`;
  if (dom.recoveryBar) {
    dom.recoveryBar.hidden = false;
    if (dom.recoveryText) dom.recoveryText.textContent = recoveryNotice;
  }
  // The ordinary notice is for saving problems; this one has its own bar.
  persistenceNotice = null;
  renderPersistenceNotice();
}

/** Clear the recovery state, which resumes automatic saving. */
function endRecovery() {
  recoveryPending = false;
  recoveryNotice = null;
  if (dom.recoveryBar) dom.recoveryBar.hidden = true;
  if (dom.recoveryText) dom.recoveryText.textContent = '';
}

/**
 * Discard the unreadable saved project, after confirmation, and start again.
 *
 * This is the only path that may replace an unreadable copy. The old value is
 * removed rather than overwritten through a shifted key: a copy to a second key
 * would leave two projects on the origin and no promise that the second write
 * succeeded, so the raw value is simply released once the user has said so.
 *
 * @param {'example'|'blank'} [kind] What to start from.
 */
function discardUnreadableProject(kind = 'example') {
  const proceed = window.confirm(
    'The saved drawing in this browser could not be opened. ' +
      'Discarding it cannot be undone: any work it holds will be lost. ' +
      'Save project first if you want to keep a copy of what is on screen now. ' +
      'Discard the saved drawing and start again?',
  );
  if (!proceed) return;

  const removed = clearStorage();
  endRecovery();

  if (kind === 'blank') {
    state.routes = [];
    clearForm();
    refresh({ refit: false });
  } else {
    loadExample();
  }

  // Only now may storage be written, and only because the user chose it.
  persistProject();
  if (!removed) {
    persistenceNotice = 'The saved drawing could not be removed, so this browser will not remember this one.';
    renderPersistenceNotice();
  }
}

/**
 * The parts of the live state a user authors, in the same shape a project uses.
 *
 * Derived data is excluded so two descriptions of the same drawing compare
 * equal, and DOM state is never read: what is compared is what would be saved.
 *
 * @returns {object} Authored project.
 */
function currentAuthoredProject() {
  return authoredProject();
}

/**
 * The whole authored project, from the live state.
 *
 * One function so saving to storage and saving to a file cannot disagree: the two
 * used to build their payloads separately, and this feature adds four more keys
 * that both need.
 *
 * @returns {object} Authored project.
 */
function authoredProject() {
  return {
    routes: state.routes.map((route) => ({
      id: route.id,
      from: route.from,
      direction: route.direction,
      spans: route.spans,
      tc: route.tc,
      fpb: route.fpb,
    })),
    originMarker: state.originMarker,
    spanLength: state.spanLength,
    layout: state.layout,
    loads: state.loads,
    spanLengths: state.spanLengths,
    loadPlacements: state.loadPlacements,
    spanPlacements: state.spanPlacements,
  };
}

/** The measured data, in the shape `buildScene` expects for its fourth argument. */
function measuredData() {
  return {
    loads: state.loads,
    spanLengths: state.spanLengths,
    loadPlacements: state.loadPlacements,
    spanPlacements: state.spanPlacements,
  };
}

/** Save the project to a downloadable file. */
function saveProjectFile() {
  const text = serializeProjectJson(authoredProject());
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

  // Confirm only when something would actually be lost. "Is the table empty" is
  // the wrong question: a project with no routes may still hold an Origin
  // symbol, a spacing and a page layout the user chose, and replacing those
  // without asking is the same silent loss on a smaller scale.
  if (!sameAuthoredProject(currentAuthoredProject(), parsed.project)) {
    const proceed = window.confirm(
      'Open this project and replace what is on screen? ' +
        'The current drawing and settings are not kept.',
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

/**
 * Rebuild the canonical network and the preview scene from the routes.
 *
 * Also builds the lookup tables that link a drawn primitive back to an asset id:
 * the drawing is keyed by coordinate, the measured data by asset id, and these maps
 * are the bridge. They are built here, once, rather than re-derived per render.
 */
function recompute() {
  const network = buildNetwork(state.routes, { originMarker: state.originMarker });
  const scene = buildScene(network, 'preview', { spanLength: state.spanLength }, measuredData());
  const registry = buildAssetRegistry(network);

  // Scene primitive id -> asset id.
  const nodeForPole = new Map();
  const nodePositions = new Map();
  for (const asset of registry.allNodeAssets()) {
    nodeForPole.set(`pole:${asset.coordKey}`, asset.id);
    nodeForPole.set(`fpb:${asset.coordKey}`, asset.id);
    nodeForPole.set(`tc:${asset.coordKey}`, asset.id);
  }
  for (const pole of scene.poles) {
    const assetId = nodeForPole.get(pole.id);
    if (assetId) nodePositions.set(assetId, { x: pole.x, y: pole.y });
  }
  for (const box of scene.fpb) {
    const assetId = nodeForPole.get(box.id);
    if (assetId) nodePositions.set(assetId, { x: box.x, y: box.y });
  }
  for (const triangle of scene.tc) {
    const assetId = nodeForPole.get(triangle.id);
    if (assetId) nodePositions.set(assetId, { x: triangle.x, y: triangle.y });
  }

  // A drawn line's parent id -> span asset id. The graph edge key is the pair of
  // coordinate keys, and the registry resolves that pair to the canonical span.
  const spanForLine = new Map();
  for (const edge of network.graph.edges.values()) {
    const a = registry.canonicalNodeId(edge.a);
    const b = registry.canonicalNodeId(edge.b);
    if (!a || !b) continue;
    const spanId = registry.canonicalSpanId(spanAssetId(a, b));
    if (spanId) spanForLine.set(`line:${edge.key}`, spanId);
  }

  current = { network, scene, registry, nodeForPole, nodePositions, spanForLine };
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
  addHitAreas();
  applyHighlight();
  applyView();
}

/**
 * Add invisible click targets over the drawing.
 *
 * A transparent circle over each pole and a wide transparent band along each
 * span make a node or a span selectable by clicking it, which is how a person
 * points at "that pole". They carry the asset id rather than a coordinate, so the
 * selection is a selection of the thing itself.
 */
function addHitAreas() {
  const svg = dom.canvas.querySelector('svg');
  if (!svg) return;
  const scene = current.scene;
  const ns = 'http://www.w3.org/2000/svg';

  const group = document.createElementNS(ns, 'g');
  group.setAttribute('id', 'hit-areas');
  group.setAttribute('fill', 'transparent');
  group.style.pointerEvents = 'all';

  // Span bands first, so a pole on top of one wins the click.
  for (const line of scene.lines) {
    const span = current.spanForLine?.get(line.parentId);
    if (!span) continue;
    const band = document.createElementNS(ns, 'line');
    band.setAttribute('x1', String(line.x1));
    band.setAttribute('y1', String(line.y1));
    band.setAttribute('x2', String(line.x2));
    band.setAttribute('y2', String(line.y2));
    band.setAttribute('stroke', 'transparent');
    band.setAttribute('stroke-width', String(Math.max(8, scene.spanLength * 0.35)));
    band.setAttribute('stroke-linecap', 'round');
    band.setAttribute('data-span-hit', span);
    group.appendChild(band);
  }

  for (const pole of scene.poles) {
    const node = current.nodeForPole?.get(pole.id);
    if (!node) continue;
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', String(pole.x));
    circle.setAttribute('cy', String(pole.y));
    circle.setAttribute('r', String(Math.max(7, scene.spanLength * 0.28)));
    circle.setAttribute('data-node-hit', node);
    group.appendChild(circle);
  }
  for (const box of scene.fpb ?? []) {
    const node = current.nodeForPole?.get(box.id);
    if (!node) continue;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(box.boxX - 3));
    rect.setAttribute('y', String(box.boxY - 3));
    rect.setAttribute('width', String(box.width + 6));
    rect.setAttribute('height', String(box.height + 6));
    rect.setAttribute('data-node-hit', node);
    group.appendChild(rect);
  }

  svg.appendChild(group);
}

/** 'node' or 'span' currently highlighted in the drawing. */
let highlight = null;

/** Highlight a node asset in the drawing. */
function highlightNode(nodeId) {
  highlight = { kind: 'node', id: nodeId };
  applyHighlight();
}

/** Highlight a span asset in the drawing. */
function highlightSpan(spanId) {
  highlight = { kind: 'span', id: spanId };
  applyHighlight();
}

/**
 * Draw the highlight ring for the current selection.
 *
 * Painted as one overlay group replaced on every change, so repeated selections
 * cannot accumulate rings.
 */
function applyHighlight() {
  const svg = dom.canvas.querySelector('svg');
  if (!svg) return;
  svg.querySelector('#selection-highlight')?.remove();
  if (!highlight) return;

  const ns = 'http://www.w3.org/2000/svg';
  const group = document.createElementNS(ns, 'g');
  group.setAttribute('id', 'selection-highlight');
  group.style.pointerEvents = 'none';

  if (highlight.kind === 'node') {
    const position = current.nodePositions?.get(highlight.id);
    if (position) {
      const ring = document.createElementNS(ns, 'circle');
      ring.setAttribute('cx', String(position.x));
      ring.setAttribute('cy', String(position.y));
      ring.setAttribute('r', String(current.scene.config.poleMarkerSize + 6));
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', '#1f5fa8');
      ring.setAttribute('stroke-width', '1.6');
      ring.setAttribute('stroke-dasharray', '4 3');
      group.appendChild(ring);
    }
  } else {
    for (const line of current.scene.lines) {
      if (current.spanForLine?.get(line.parentId) !== highlight.id) continue;
      const band = document.createElementNS(ns, 'line');
      band.setAttribute('x1', String(line.x1));
      band.setAttribute('y1', String(line.y1));
      band.setAttribute('x2', String(line.x2));
      band.setAttribute('y2', String(line.y2));
      band.setAttribute('stroke', '#1f5fa8');
      band.setAttribute('stroke-width', '4');
      band.setAttribute('stroke-opacity', '0.4');
      band.setAttribute('stroke-linecap', 'round');
      group.appendChild(band);
    }
  }
  svg.appendChild(group);
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
  networkPanel?.render();
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
  const scene = buildScene(current.network, 'pdf', { spanLength: state.spanLength }, measuredData());
  const { doc, layout } = renderSceneToPdf(scene, { jsPDF, layout: state.layout });
  doc.save('line-route-drawing.pdf');
  dom.exportStatus.textContent = `PDF downloaded (${layout.label}).`;
}

function exportSvg() {
  if (!requireExportable()) return;
  const scene = buildScene(current.network, 'svg', { spanLength: state.spanLength }, measuredData());
  const svg = renderSceneToSvg(scene, { standalone: true, background: '#ffffff' });
  downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), 'line-route-drawing.svg');
  dom.exportStatus.textContent = 'SVG downloaded. Insert it with Insert > Pictures in Word or PowerPoint.';
}

function printDrawing() {
  if (!requireExportable()) return;
  const scene = buildScene(current.network, 'print', { spanLength: state.spanLength }, measuredData());
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
  // A click on a pole or a span selects it in the Network Data tables, which is
  // how a person points at what they mean instead of hunting for an id in a list.
  // A callout or a span label can be dragged to a clearer spot. The nudge is
  // stored as an offset from the automatic position, keyed by asset id, so it
  // survives a redraw and a reload, and a later edit that moves the pole carries
  // the annotation with it rather than leaving it stranded.
  let drag = null;

  /** Find the annotation record currently drawn for an asset, from the live scene. */
  function annotationFor(kind, assetId) {
    const anns = current.scene?.annotations;
    if (!anns) return null;
    const list = kind === 'load' ? anns.callouts : anns.spans;
    return list?.find((a) => a.assetId === assetId) ?? null;
  }

  dom.canvas.addEventListener('pointerdown', (event) => {
    const group = event.target.closest?.('[data-annot-id]');
    if (!group) return;
    const kind = group.getAttribute('data-annot-kind');
    const assetId = group.getAttribute('data-annot-id');
    if (!kind || !assetId) return;

    event.stopPropagation();
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY };
    const existing =
      kind === 'load' ? state.loadPlacements[assetId] : state.spanPlacements[assetId];
    // The position the label is drawn at right now, and which candidate the
    // automatic pass chose to put it there. Both are recorded so the offset is
    // measured from what the reader sees: dragging a label that the layout placed
    // on the pole's left must move it from the left, not from the first candidate.
    const drawn = annotationFor(kind, assetId);
    drag = {
      kind,
      assetId,
      start,
      base: { dx: existing?.dx ?? 0, dy: existing?.dy ?? 0 },
      ci: existing?.candidateIndex ?? drawn?.candidateIndex ?? 0,
      // Scene-space position at the moment the drag began, so zoom never bends the
      // distance the pointer travelled.
      origin: drawn ? { x: drawn.center.x, y: drawn.center.y } : null,
      moved: false,
    };
    dom.canvas.style.cursor = 'grabbing';
    dom.canvas.setPointerCapture?.(event.pointerId);
  });

  dom.canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const scale = view.zoom || 1;
    // Pointer travel in pixels, divided by the zoom, is the distance in scene
    // units. Accumulating that onto the base offset keeps a zoomed-out drag from
    // moving two and a half times as far as the cursor did.
    const dx = drag.base.dx + (event.clientX - drag.start.x) / scale;
    const dy = drag.base.dy + (event.clientY - drag.start.y) / scale;
    if (Math.abs(dx - drag.base.dx) > 0.5 || Math.abs(dy - drag.base.dy) > 0.5) drag.moved = true;
    const target = drag.kind === 'load' ? 'loadPlacements' : 'spanPlacements';
    // Live feedback while dragging, without persisting on every pointer move. The
    // candidate index travels with the offset so a redraw keeps the same anchor.
    state[target] = {
      ...state[target],
      [drag.assetId]: { dx, dy, candidateIndex: drag.ci },
    };
    recompute();
    renderPreview();
  });

  const endDrag = () => {
    if (!drag) return;
    const moved = drag.moved;
    dom.canvas.style.cursor = '';
    drag = null;
    if (moved) {
      // Only a real movement is written, so a plain click that starts on an
      // annotation does not record a zero offset as if it had been dragged.
      persistProject();
      recompute();
      renderPreview();
      networkPanel?.render();
      notify('Annotation moved. It stays there, even after a reload.');
    }
  };
  dom.canvas.addEventListener('pointerup', endDrag);
  dom.canvas.addEventListener('pointercancel', endDrag);

  dom.canvas.addEventListener('click', (event) => {
    const node = event.target.getAttribute?.('data-node-hit');
    const span = event.target.getAttribute?.('data-span-hit');
    if (node) {
      highlightNode(node);
      networkPanel?.selectNode?.(node);
      return;
    }
    if (span) {
      highlightSpan(span);
      networkPanel?.selectSpan?.(span);
    }
  });

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
  if (dom.recoveryDiscard) {
    dom.recoveryDiscard.addEventListener('click', () => discardUnreadableProject('example'));
  }
  if (dom.recoveryNew) {
    dom.recoveryNew.addEventListener('click', () => discardUnreadableProject('blank'));
  }
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

  // The Network Data section reads the live state and writes back through
  // `applyMeasuredChange`, so the tables and the drawing share one source.
  networkPanel = createNetworkPanel({
    getState: () => state,
    getNetwork: () => current.network,
    onChange: (patch) => applyMeasuredChange(patch),
    onSelectNode: (nodeId) => highlightNode(nodeId),
    onSelectSpan: (spanId) => highlightSpan(spanId),
    notify: (message) => notify(message),
  });

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
