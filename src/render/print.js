/**
 * Fitting a drawing onto one printed sheet.
 *
 * The browser print path differs from the PDF path in one important way: the PDF
 * renderer draws every stroke itself through one page transform, so it decides
 * exactly where the drawing sits. The print path instead hands the browser an SVG in
 * an HTML document and lets the browser lay it out, which means the drawing's on-paper
 * size is decided by CSS rather than by the renderer.
 *
 * That is where the two-sheet defect came from. The stylesheet sized the image with
 * `width:100%;height:auto`, which scales to the content width without ever consulting
 * the content height. The drawing is 536 units wide by 736 tall - taller than it is
 * wide - so on every landscape sheet the width-driven size was 1.8 to 2.0 times taller
 * than the printable area and the browser broke it across two pages. A4 portrait was
 * the only layout that happened to fit, purely because its printable area is taller
 * than it is wide, which is why the defect looked intermittent.
 *
 * The fix is to compute an explicit size here, with the same rule the PDF renderer
 * uses: one scale for both axes, taken from whichever constraint binds, so the drawing
 * keeps its shape and always fits inside the printable area.
 *
 * This module is deliberately free of DOM access so the rule can be tested directly,
 * in the same way the geometry modules are.
 */

/** Points per millimetre. Both CSS paper and the print stylesheet are metric here. */
export const MM_PER_POINT = 25.4 / 72;

/**
 * Fit a scene onto one sheet of the chosen paper, preserving its aspect ratio.
 *
 * @param {{width: number, height: number}} scene The normalised scene's pixel extent.
 * @param {{widthPt: number, heightPt: number}} layout Paper size in points.
 * @param {number} marginMillimetres Uniform margin on all four sides.
 * @returns {{widthMm: number, heightMm: number, scale: number, boxWidthMm: number, boxHeightMm: number}}
 *   The size to print at, the single scale applied to both axes, and the printable box.
 * @throws {RangeError} When the margin leaves no room for the drawing.
 */
export function fitSceneToPrintSheet(scene, layout, marginMillimetres) {
  if (!scene || !(scene.width > 0) || !(scene.height > 0)) {
    throw new RangeError('A scene with a positive width and height is required.');
  }
  if (!layout || !(layout.widthPt > 0) || !(layout.heightPt > 0)) {
    throw new RangeError('A page layout with a positive width and height is required.');
  }
  if (!Number.isFinite(marginMillimetres) || marginMillimetres < 0) {
    throw new RangeError(`Invalid page margin: ${String(marginMillimetres)}.`);
  }

  const boxWidthMm = layout.widthPt * MM_PER_POINT - marginMillimetres * 2;
  const boxHeightMm = layout.heightPt * MM_PER_POINT - marginMillimetres * 2;
  if (!(boxWidthMm > 0) || !(boxHeightMm > 0)) {
    throw new RangeError('The page margin leaves no room for the drawing.');
  }

  // One scale for both axes, so the drawing keeps its shape. The smaller ratio is the
  // constraint that actually binds, whichever axis it is on.
  const scale = Math.min(boxWidthMm / scene.width, boxHeightMm / scene.height);
  return {
    widthMm: scene.width * scale,
    heightMm: scene.height * scale,
    scale,
    boxWidthMm,
    boxHeightMm,
  };
}
