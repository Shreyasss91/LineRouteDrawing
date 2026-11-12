/**
 * Regression tests for fitting a drawing onto one printed sheet.
 *
 * The defect these pin: `npm run test:print:headed -- --layout letter_landscape` was
 * acknowledged with the dialog showing A4, two sheets, and the drawing continuing onto
 * the second one. The paper selection was never the problem - the `@page` rule named
 * the right paper for all four layouts and Chrome's own MediaBox matched it exactly.
 * The problem was the size the drawing was given inside that page.
 *
 * The stylesheet used
 *
 *   svg{display:block;width:100%;height:auto}
 *
 * `width:100%` scales an image to the content width and derives the height from the
 * aspect ratio, without ever consulting the content height. The drawing is 536 wide by
 * 736 tall, so width-driven sizing made it taller than the printable area on every
 * landscape sheet, and the browser paginated it:
 *
 *   a4_landscape      printable 276.3 x 190.0 mm, drawing became 356.9 mm tall (2.00x)
 *   a3_landscape      printable 400.0 x 277.0 mm, drawing became 549.5 mm tall (1.98x)
 *   letter_landscape  printable 259.3 x 195.9 mm, drawing became 356.1 mm tall (1.82x)
 *   a4_portrait       printable 190.0 x 277.0 mm, drawing became 260.9 mm tall (0.94x)
 *
 * A4 portrait was the only layout that fitted, and only because its printable area is
 * taller than it is wide. That is why the defect looked layout-specific rather than
 * universal.
 *
 * The correction takes the smaller of the two ratios, so height binds on a
 * portrait-shaped drawing and the result always fits, at one scale for both axes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PAGE_LAYOUTS } from '../src/config.js';
import { MM_PER_POINT, fitSceneToPrintSheet } from '../src/render/print.js';

/** The margin the print stylesheet applies, in millimetres. */
const MARGIN_MM = 10;

/** The example drawing's scene extent, as the print path builds it. */
const SCENE = { width: 536, height: 736 };

/** Every configured layout, so a new paper cannot be added without being covered. */
const LAYOUT_IDS = Object.keys(PAGE_LAYOUTS);

/** Floating point tolerance for millimetre comparisons. */
const EPSILON = 1e-9;

/* ------------------------------------------------------------------ */
/* The defect: one sheet, every layout                               */
/* ------------------------------------------------------------------ */

test('every configured layout fits the drawing inside its printable area', () => {
  // The one-sheet requirement, stated as the property that guarantees it: neither
  // dimension of the fitted drawing may exceed the printable box it sits in.
  for (const id of LAYOUT_IDS) {
    const layout = PAGE_LAYOUTS[id];
    const fit = fitSceneToPrintSheet(SCENE, layout, MARGIN_MM);

    assert.ok(
      fit.widthMm <= fit.boxWidthMm + EPSILON,
      `${id}: drawing is ${fit.widthMm.toFixed(2)}mm wide but the box is ${fit.boxWidthMm.toFixed(2)}mm`,
    );
    assert.ok(
      fit.heightMm <= fit.boxHeightMm + EPSILON,
      `${id}: drawing is ${fit.heightMm.toFixed(2)}mm tall but the box is ${fit.boxHeightMm.toFixed(2)}mm. ` +
        'This is the two-sheet overflow: a taller-than-wide drawing sized by width.',
    );
  }
});

test('the drawing fills at least one dimension of every layout', () => {
  // Fitting inside the box is necessary but not sufficient: a calculation that returned
  // a tiny drawing would also fit. Exactly one dimension must be the binding one, so the
  // drawing uses the sheet it is given.
  for (const id of LAYOUT_IDS) {
    const fit = fitSceneToPrintSheet(SCENE, PAGE_LAYOUTS[id], MARGIN_MM);
    const bindsWidth = Math.abs(fit.widthMm - fit.boxWidthMm) < 1e-6;
    const bindsHeight = Math.abs(fit.heightMm - fit.boxHeightMm) < 1e-6;
    assert.ok(
      bindsWidth || bindsHeight,
      `${id}: the drawing touches neither edge, so it is smaller than it needs to be`,
    );
  }
});

test('the regression: letter_landscape no longer overflows onto a second sheet', () => {
  // The reported case, reproduced numerically. Before the correction the printed height
  // was the width-driven 356.1mm against a 195.9mm box - 1.82 sheets' worth - and
  // Chrome broke it across two pages.
  const layout = PAGE_LAYOUTS.letter_landscape;
  const fit = fitSceneToPrintSheet(SCENE, layout, MARGIN_MM);
  const boxHeightMm = layout.heightPt * MM_PER_POINT - MARGIN_MM * 2;

  // What the old stylesheet produced: scale from the content width alone.
  const boxWidthMm = layout.widthPt * MM_PER_POINT - MARGIN_MM * 2;
  const oldWidthDrivenHeightMm = SCENE.height * (boxWidthMm / SCENE.width);
  assert.ok(
    oldWidthDrivenHeightMm > boxHeightMm * 1.5,
    'the old sizing must reproduce the overflow, or this test proves nothing',
  );

  // What it produces now: inside the box, so one sheet.
  assert.ok(
    fit.heightMm <= boxHeightMm,
    `height ${fit.heightMm.toFixed(2)}mm must fit the ${boxHeightMm.toFixed(2)}mm box`,
  );
});

/* ------------------------------------------------------------------ */
/* Aspect ratio is preserved, never squashed                          */
/* ------------------------------------------------------------------ */

test('the aspect ratio is preserved exactly on every layout', () => {
  const sceneRatio = SCENE.width / SCENE.height;
  for (const id of LAYOUT_IDS) {
    const fit = fitSceneToPrintSheet(SCENE, PAGE_LAYOUTS[id], MARGIN_MM);
    assert.ok(
      Math.abs(fit.widthMm / fit.heightMm - sceneRatio) < 1e-9,
      `${id}: printed ratio ${(fit.widthMm / fit.heightMm).toFixed(6)} differs from ${sceneRatio.toFixed(6)}`,
    );
  }
});

test('both axes are scaled by the same factor', () => {
  for (const id of LAYOUT_IDS) {
    const fit = fitSceneToPrintSheet(SCENE, PAGE_LAYOUTS[id], MARGIN_MM);
    assert.ok(
      Math.abs(fit.widthMm / SCENE.width - fit.heightMm / SCENE.height) < 1e-12,
      `${id}: the two axes were scaled differently, which squashes the drawing`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Paper comes from PAGE_LAYOUTS, and the margin is accounted for      */
/* ------------------------------------------------------------------ */

test('the printable box is the paper size minus the margin on both sides', () => {
  for (const id of LAYOUT_IDS) {
    const layout = PAGE_LAYOUTS[id];
    const fit = fitSceneToPrintSheet(SCENE, layout, MARGIN_MM);
    assert.ok(Math.abs(fit.boxWidthMm - (layout.widthPt * MM_PER_POINT - MARGIN_MM * 2)) < 1e-9, id);
    assert.ok(Math.abs(fit.boxHeightMm - (layout.heightPt * MM_PER_POINT - MARGIN_MM * 2)) < 1e-9, id);
  }
});

test('a larger sheet produces a larger drawing, at the same shape', () => {
  // A3 landscape and A4 landscape share a height and orientation, so A3's extra width
  // must not change the drawing here: height binds on both, so both fit to full height.
  const a4 = fitSceneToPrintSheet(SCENE, PAGE_LAYOUTS.a4_landscape, MARGIN_MM);
  const a3 = fitSceneToPrintSheet(SCENE, PAGE_LAYOUTS.a3_landscape, MARGIN_MM);
  assert.ok(a3.heightMm > a4.heightMm, 'A3 is a taller printable area than A4 landscape');
  assert.ok(
    Math.abs(a3.widthMm / a3.heightMm - a4.widthMm / a4.heightMm) < 1e-12,
    'both must keep the same shape',
  );
});

test('every layout scales independently rather than sharing one constant', () => {
  const scales = new Set(
    LAYOUT_IDS.map((id) => fitSceneToPrintSheet(SCENE, PAGE_LAYOUTS[id], MARGIN_MM).scale.toFixed(9)),
  );
  assert.ok(scales.size >= 2, `expected distinct scales per paper, got ${[...scales].join(', ')}`);
});

test('a margin of zero uses the whole sheet', () => {
  const fit = fitSceneToPrintSheet(SCENE, PAGE_LAYOUTS.a4_landscape, 0);
  assert.ok(Math.abs(fit.boxHeightMm - PAGE_LAYOUTS.a4_landscape.heightPt * MM_PER_POINT) < 1e-9);
});

/* ------------------------------------------------------------------ */
/* Refusals, so a broken configuration cannot silently pass           */
/* ------------------------------------------------------------------ */

test('a margin that leaves no room is refused', () => {
  assert.throws(
    () => fitSceneToPrintSheet(SCENE, PAGE_LAYOUTS.a4_landscape, 200),
    /page margin leaves no room/i,
  );
});

test('an empty or invalid scene is refused', () => {
  for (const scene of [null, undefined, {}, { width: 0, height: 10 }, { width: 10, height: -1 }]) {
    assert.throws(() => fitSceneToPrintSheet(scene, PAGE_LAYOUTS.a4_landscape, MARGIN_MM), RangeError);
  }
});

test('an invalid layout or margin is refused', () => {
  assert.throws(() => fitSceneToPrintSheet(SCENE, null, MARGIN_MM), RangeError);
  assert.throws(() => fitSceneToPrintSheet(SCENE, { widthPt: 0, heightPt: 0 }, MARGIN_MM), RangeError);
  assert.throws(() => fitSceneToPrintSheet(SCENE, PAGE_LAYOUTS.a4_landscape, -1), RangeError);
  assert.throws(() => fitSceneToPrintSheet(SCENE, PAGE_LAYOUTS.a4_landscape, NaN), RangeError);
});

/* ------------------------------------------------------------------ */
/* Agreement with the PDF renderer                                    */
/* ------------------------------------------------------------------ */

test('the print fit agrees with the PDF renderer about where the drawing sits', () => {
  // The two outputs are different mechanisms - one draws through a page transform, the
  // other hands CSS an explicit size - but a reader comparing a printed sheet with a
  // downloaded PDF must find the same drawing at the same place on the same paper.
  // Both take the smaller of the two ratios, so the scales must match.
  for (const id of LAYOUT_IDS) {
    const layout = PAGE_LAYOUTS[id];
    const marginPt = MARGIN_MM / MM_PER_POINT;
    const pdfScale = Math.min(
      (layout.widthPt - marginPt * 2) / SCENE.width,
      (layout.heightPt - marginPt * 2) / SCENE.height,
    );
    const printFit = fitSceneToPrintSheet(SCENE, layout, MARGIN_MM);
    // The print fit is in millimetres per scene unit and the PDF's in points per scene
    // unit, so the two are compared after one conversion, not directly.
    const printScaleInPoints = printFit.scale / MM_PER_POINT;
    assert.ok(
      Math.abs(printScaleInPoints - pdfScale) < 1e-9,
      `${id}: print scale ${printScaleInPoints} disagrees with the PDF's ${pdfScale}`,
    );
  }
});
