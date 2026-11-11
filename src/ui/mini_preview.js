/**
 * The compact drawing beside the Network Data schedules.
 *
 * A schedule row says `A1` and a person has to find A1 on the drawing. Doing that
 * by switching to the main preview and back loses the row they were on, so this
 * panel keeps a small, always-current copy of the drawing next to the table.
 *
 * WHAT IT IS
 *
 * It is a second presentation of the same scene the main preview and the exports
 * use. It builds no geometry of its own: it asks `renderSceneToSvg` for the markup
 * and adds one overlay on top - the point designations, which the main preview does
 * not show. Nothing here computes a coordinate, a symbol or a length, so it cannot
 * disagree with the drawing it is a copy of.
 *
 * The one thing it does own is the viewport. It sets a `viewBox` fitted to the
 * drawing so the whole network is always visible at whatever size the panel is,
 * which is what makes it useful at a glance. That is independent of the main
 * preview's zoom and pan, which it never reads or writes.
 */

/**
 * Fit a viewBox to a scene, with a little breathing room.
 *
 * @param {{width: number, height: number}} scene Scene dimensions.
 * @param {number} [margin] Padding in scene pixels.
 * @returns {string} A `viewBox` attribute value.
 */
export function fitViewBox(scene, margin = 10) {
  const width = Math.max(1, scene.width + margin * 2);
  const height = Math.max(1, scene.height + margin * 2);
  return `${-margin} ${-margin} ${width} ${height}`;
}

/**
 * Build the notation overlay: every pole's designation, drawn small beside it.
 *
 * The labels are the whole reason this panel exists, so they are drawn last and sit
 * above the symbols. A pole with no designation is skipped rather than labelled with
 * its internal id, which would put `mid:r2:0` on a reader's screen.
 *
 * @param {object} input
 * @param {Array<{id: string, designation: string|null}>} input.nodes Node assets.
 * @param {Map<string, {x: number, y: number}>} input.positions Asset id -> position.
 * @param {object} input.config Drawing configuration.
 * @param {(text: string) => string} input.escapeText SVG text escaper.
 * @returns {string} SVG markup for the overlay group.
 */
export function buildDesignationOverlay(input) {
  const { nodes, positions, config, escapeText, fontScale = 1 } = input;
  // The panel is a fraction of the drawing's own size, so a label sized in scene
  // pixels would be shrunk along with everything else and become unreadable. Scaling
  // the font by how far the drawing is being reduced keeps the names legible at the
  // panel's real size, which is the whole point of showing them here.
  const fontSize = config.miniDesignationFontSize * fontScale;
  const parts = [];
  parts.push('<g id="point-designations" style="pointer-events:none">');
  for (const node of nodes) {
    const label = node.designation;
    const position = positions?.get(node.id);
    if (!label || !position) continue;
    // Just clear of the symbol, so the name does not sit on the X it names.
    const x = position.x + (config.poleMarkerSize / 2 + 3) * fontScale;
    const y = position.y - (config.poleMarkerSize / 2 + 3) * fontScale;
    parts.push(
      `<text x="${round(x)}" y="${round(y)}" font-size="${round(fontSize)}" ` +
        `font-family="${escapeText(config.fontFamily)}" fill="#1f4d7a" ` +
        `paint-order="stroke" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round">` +
        `${escapeText(label)}</text>`,
    );
  }
  parts.push('</g>');
  return parts.join('');
}

/**
 * A selection ring for the currently selected node or span.
 *
 * Drawn as one overlay, replaced on every selection, so repeated clicks cannot
 * stack rings on top of one another.
 *
 * @param {object} input
 * @param {{kind: 'node'|'span', id: string}|null} input.selection Current selection.
 * @param {Map<string, {x: number, y: number}>} input.positions Node positions.
 * @param {Map<string, {x1: number, y1: number, x2: number, y2: number}>} input.spans
 *   Span endpoint positions, keyed by span asset id.
 * @param {object} input.config Drawing configuration.
 * @returns {string} SVG markup, empty when nothing is selected.
 */
export function buildSelectionRing(input) {
  const { selection, positions, spans, config } = input;
  if (!selection) return '';
  if (selection.kind === 'node') {
    const position = positions?.get(selection.id);
    if (!position) return '';
    return (
      '<g id="mini-selection" style="pointer-events:none">' +
      `<circle cx="${round(position.x)}" cy="${round(position.y)}" ` +
      `r="${round(config.poleMarkerSize * 0.9 + 5)}" fill="none" stroke="#d97706" ` +
      'stroke-width="2"/>' +
      '</g>'
    );
  }
  const span = spans?.get(selection.id);
  if (!span) return '';
  return (
    '<g id="mini-selection" style="pointer-events:none">' +
    `<line x1="${round(span.x1)}" y1="${round(span.y1)}" x2="${round(span.x2)}" ` +
    `y2="${round(span.y2)}" stroke="#d97706" stroke-width="4" stroke-linecap="round"/>` +
    '</g>'
  );
}

/**
 * Compose the mini-preview markup.
 *
 * @param {object} input
 * @param {string} input.sceneSvg Markup from `renderSceneToSvg` for the same scene.
 * @param {string} input.viewBox Fitted viewBox.
 * @param {string} input.overlay Designation overlay markup.
 * @param {string} input.ring Selection ring markup.
 * @returns {string} A self-contained SVG element.
 */
export function composeMiniPreview(input) {
  const { sceneSvg, viewBox, overlay, ring } = input;
  // The scene markup is a complete <svg>; the overlay has to go inside it, so the
  // closing tag is opened up and the extra groups appended. Doing it here rather
  // than rebuilding the drawing keeps one renderer for both views.
  const closing = sceneSvg.lastIndexOf('</svg>');
  const body = closing >= 0 ? sceneSvg.slice(0, closing) : sceneSvg;
  const withViewBox = body.replace(/viewBox="[^"]*"/, `viewBox="${viewBox}"`);
  // A fitted viewBox needs a size in the document, not the drawing's own pixel size.
  const sized = withViewBox
    .replace(/width="[^"]*"/, 'width="100%"')
    .replace(/height="[^"]*"/, 'height="100%"')
    .replace('data-profile="preview"', 'data-profile="mini"');
  return `${sized}${overlay}${ring}</svg>`;
}

/** Round to two decimals, so the markup stays readable. */
function round(value) {
  return Math.round(Number(value) * 100) / 100;
}
