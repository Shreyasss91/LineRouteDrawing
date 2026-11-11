/**
 * SVG renderer.
 *
 * Consumes ONLY the normalized render scene produced by `buildScene`. It never
 * calculates coordinates, poles or junctions itself: every primitive already
 * carries its pixel position. That keeps preview and export byte-identical in
 * geometry.
 *
 * Output is editable vector primitives (path, line, polygon, text), never a
 * raster image, so the result can be inserted into Word and PowerPoint.
 */

/** Escape text for XML content and attribute values. */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Format a number with at most two decimals, dropping trailing zeros. */
function num(value) {
  return String(Math.round(value * 100) / 100);
}

/**
 * Build the X (crossing) symbol path data for a pole.
 *
 * @param {{x: number, y: number, size: number}} pole Pole primitive.
 * @returns {string} SVG path `d` attribute.
 */
export function poleCrossPath(pole) {
  const { x, y, size } = pole;
  return (
    `M${num(x - size)} ${num(y - size)}L${num(x + size)} ${num(y + size)}` +
    `M${num(x + size)} ${num(y - size)}L${num(x - size)} ${num(y + size)}`
  );
}

/**
 * Build the TC triangle points. The triangle hangs below its anchor pole so
 * that the X and the triangle both remain identifiable.
 *
 * @param {{x: number, y: number, halfWidth: number, height: number}} tc TC primitive.
 * @returns {string} `points` attribute for a polygon.
 */
export function tcTrianglePoints(tc) {
  const { x, y, halfWidth, height } = tc;
  const top = y + halfWidth * 0.35;
  const bottom = top + height;
  return `${num(x)},${num(top)} ${num(x + halfWidth)},${num(bottom)} ${num(x - halfWidth)},${num(bottom)}`;
}

/**
 * Render a scene to an SVG document string.
 *
 * @param {object} scene Scene from `buildScene`.
 * @param {object} [options]
 * @param {boolean} [options.standalone] Emit a full XML declaration and namespaces.
 * @param {string}  [options.background] Optional background colour.
 * @param {number}  [options.scale] Uniform scale factor applied to the viewBox.
 * @returns {string} SVG markup.
 */
export function renderSceneToSvg(scene, options = {}) {
  const { standalone = true } = options;
  const width = scene.width;
  const height = scene.height;
  const parts = [];

  if (standalone) {
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  }

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `version="1.1" ` +
      `width="${num(width)}" height="${num(height)}" ` +
      `viewBox="0 0 ${num(width)} ${num(height)}" ` +
      `data-profile="${escapeXml(scene.profile.id)}">`,
  );

  if (options.background) {
    parts.push(`<rect x="0" y="0" width="${num(width)}" height="${num(height)}" fill="${escapeXml(options.background)}"/>`);
  }

  // Lines first so markers always sit on top of the strokes.
  if (scene.lines.length) {
    parts.push(`<g id="route-lines" fill="none" stroke="#111" stroke-linecap="square">`);
    for (const line of scene.lines) {
      parts.push(
        `<line id="${escapeXml(line.id)}" x1="${num(line.x1)}" y1="${num(line.y1)}" ` +
          `x2="${num(line.x2)}" y2="${num(line.y2)}" stroke-width="${num(line.strokeWidth)}"/>`,
      );
    }
    parts.push('</g>');
  }

  if (scene.poles.length) {
    parts.push(`<g id="pole-markers" fill="none" stroke="#111" stroke-width="1.4" stroke-linecap="square">`);
    for (const pole of scene.poles) {
      parts.push(`<path id="${escapeXml(pole.id)}" d="${poleCrossPath(pole)}"/>`);
    }
    parts.push('</g>');
  }

  if (scene.tc.length) {
    parts.push(`<g id="tc-markers" fill="none" stroke="#111" stroke-width="1.4" stroke-linejoin="miter">`);
    for (const tc of scene.tc) {
      parts.push(`<polygon id="${escapeXml(tc.id)}" points="${tcTrianglePoints(tc)}"/>`);
    }
    parts.push('</g>');
  }

  if (scene.fpb && scene.fpb.length) {
    // A feeder pillar box is a rectangle sized to its own label, with the text
    // inside it. The text is part of the symbol, so it survives in exports even
    // though every ordinary label is suppressed there.
    parts.push(`<g id="fpb-markers" fill="none" stroke="#111" stroke-width="1.5">`);
    for (const box of scene.fpb) {
      parts.push(
        `<rect id="${escapeXml(box.id)}" x="${num(box.boxX)}" y="${num(box.boxY)}" ` +
          `width="${num(box.width)}" height="${num(box.height)}" fill="#ffffff"/>`,
      );
      parts.push(
        `<text id="${escapeXml(box.id)}-label" x="${num(box.x)}" ` +
          `y="${num(box.y)}" fill="#111" stroke="none" font-family="${escapeXml(scene.fontFamily)}" ` +
          `font-size="${num(box.fontSize)}" text-anchor="middle" ` +
          `dominant-baseline="central">${escapeXml(box.text)}</text>`,
      );
    }
    parts.push('</g>');
  }

  if (scene.labels.length) {
    // A white halo keeps label text readable where a line passes close by,
    // without hiding the pole marker itself.
    parts.push(
      `<g id="labels" font-family="${escapeXml(scene.fontFamily)}" ` +
        `font-size="${num(scene.config.labelFontSize)}" paint-order="stroke" ` +
        `stroke="#ffffff" stroke-width="3" stroke-linejoin="round">`,
    );
    for (const label of scene.labels) {
      const tx = label.x + label.offsetX;
      const ty = label.y + label.offsetY;
      parts.push(
        `<text id="${escapeXml(label.id)}" x="${num(tx)}" y="${num(ty)}" ` +
          `text-anchor="${escapeXml(label.anchor)}" fill="#111">` +
          `${escapeXml(label.text)}</text>`,
      );
    }
    parts.push('</g>');
  }

  parts.push('</svg>');
  return parts.join('\n');
}
