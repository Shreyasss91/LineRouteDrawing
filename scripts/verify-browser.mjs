/**
 * Browser verification harness (development aid, not part of the app).
 *
 * Drives the real application in Chromium through the complete workflow and
 * records evidence: preview content, label visibility per profile, the PDF and
 * SVG downloads, and the print path. Run with:
 *
 *   node scripts/verify-browser.mjs
 *
 * Requires Playwright to be available (npx playwright). The application itself
 * never depends on it.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8123/';
const OUT = resolve('artifacts');

const results = [];
function record(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}\n`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 950 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

await mkdir(OUT, { recursive: true });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#preview-canvas svg', { timeout: 10000 });

// ---- 1. example loaded and drawn -------------------------------------
const rowCount = await page.locator('#route-rows tr').count();
record('example loads 9 route rows', rowCount === 9, `rows=${rowCount}`);

const svgInfo = await page.evaluate(() => {
  const svg = document.querySelector('#preview-canvas svg');
  return {
    lines: svg.querySelectorAll('#route-lines line').length,
    poles: svg.querySelectorAll('#pole-markers path').length,
    tc: svg.querySelectorAll('#tc-markers polygon').length,
    texts: [...svg.querySelectorAll('#labels text')].map((t) => t.textContent),
    viewBox: svg.getAttribute('viewBox'),
  };
});
record('preview draws 33 merged route lines', svgInfo.lines === 33, `lines=${svgInfo.lines}`);
record('preview draws 34 X pole markers', svgInfo.poles === 34, `poles=${svgInfo.poles}`);
record('preview draws 1 TC triangle', svgInfo.tc === 1, `tc=${svgInfo.tc}`);
record(
  'preview shows Origin and alphabetical labels',
  svgInfo.texts.includes('Origin') && ['A', 'B', 'C', 'D'].every((l) => svgInfo.texts.includes(l)),
  `texts=${svgInfo.texts.join(',')}`,
);

// ---- 2. no clipping: the whole drawing is inside the stage ------------
const fits = await page.evaluate(() => {
  const stage = document.querySelector('#preview-stage').getBoundingClientRect();
  const canvas = document.querySelector('#preview-canvas').getBoundingClientRect();
  return {
    inside:
      canvas.left >= stage.left - 1 &&
      canvas.top >= stage.top - 1 &&
      canvas.right <= stage.right + 1 &&
      canvas.bottom <= stage.bottom + 1,
    stage: { w: stage.width, h: stage.height },
    canvas: { w: canvas.width, h: canvas.height },
  };
});
record('initial drawing is fully visible without clipping', fits.inside, JSON.stringify(fits));

// ---- 3. zoom / pan / fit / reset -------------------------------------
const scaleOf = () => page.evaluate(() => {
  const t = document.querySelector('#preview-canvas').style.transform;
  return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? '1');
});
const initialScale = await scaleOf();
await page.click('#btn-zoom-in');
const zoomed = await scaleOf();
record('zoom in increases scale', zoomed > initialScale, `${initialScale} -> ${zoomed}`);
await page.click('#btn-zoom-out');
const unzoomed = await scaleOf();
record('zoom out decreases scale', unzoomed < zoomed, `${zoomed} -> ${unzoomed}`);
await page.click('#btn-reset');
record('reset returns to scale 1', (await scaleOf()) === 1);
await page.click('#btn-fit');
const fitted = await scaleOf();
record('fit to screen changes scale', Math.abs(fitted - 1) > 0.0001, `scale=${fitted}`);

// pan
const stageBox = await page.locator('#preview-stage').boundingBox();
const beforeTransform = await page.evaluate(() => document.querySelector('#preview-canvas').style.transform);
await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
await page.mouse.down();
await page.mouse.move(stageBox.x + stageBox.width / 2 + 60, stageBox.y + stageBox.height / 2 + 40, { steps: 6 });
await page.mouse.up();
const afterTransform = await page.evaluate(() => document.querySelector('#preview-canvas').style.transform);
record('pan moves the drawing', beforeTransform !== afterTransform, `${beforeTransform} -> ${afterTransform}`);

// ---- 4. adding a route updates the drawing ---------------------------
await page.selectOption('#field-from', { label: 'Origin' });
await page.selectOption('#field-direction', 'west');
await page.fill('#field-spans', '2');
await page.click('#btn-save-route');
const afterAdd = await page.locator('#route-rows tr').count();
record('adding a route appends a row', afterAdd === 10, `rows=${afterAdd}`);
const westAdded = await page.evaluate(() =>
  [...document.querySelectorAll('#preview-canvas svg #route-lines line')].some((l) => {
    const x1 = Number(l.getAttribute('x1'));
    const x2 = Number(l.getAttribute('x2'));
    return Math.max(x1, x2) > 300; // drawing grew west of the origin column
  }),
);
record('adding a route regenerates the drawing', westAdded);

// ---- 5. editing a route ---------------------------------------------
await page.locator('#route-rows tr').nth(1).locator('button[data-action="edit"]').click();
const prefilledSpans = await page.inputValue('#field-spans');
record('edit prefills the form', prefilledSpans === '4', `spans=${prefilledSpans}`);
await page.fill('#field-spans', '6');
await page.click('#btn-save-route');
const editedSpans = await page.locator('#route-rows tr').nth(1).locator('td').nth(3).textContent();
record('edited row shows the new span count', editedSpans.trim() === '6', `spans=${editedSpans.trim()}`);
const stillValid = await page.locator('#route-rows .status-bad').count();
record('dependent routes remain valid after the edit', stillValid === 0, `bad=${stillValid}`);

// restore the example
await page.click('#btn-load-example');
await page.waitForTimeout(150);

// ---- 6. validation feedback -----------------------------------------
await page.selectOption('#field-from', { label: 'Origin' });
await page.fill('#field-spans', '0');
await page.click('#btn-save-route');
const formError = await page.textContent('#form-error');
record('zero spans is refused with a message', /greater than zero/i.test(formError ?? ''), formError);
await page.fill('#field-spans', '1.5');
await page.click('#btn-save-route');
const decError = await page.textContent('#form-error');
record('decimal spans is refused with a message', /whole number/i.test(decError ?? ''), decError);

// ---- 7. SVG export ---------------------------------------------------
const svgDownload = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btn-svg'),
]).then(([d]) => d);
const svgPath = resolve(OUT, 'export.svg');
await svgDownload.saveAs(svgPath);
const svgText = readFileSync(svgPath, 'utf8');
const svgChecks = {
  vector: /<line /.test(svgText) && /<path /.test(svgText) && /<polygon /.test(svgText),
  noImage: !/<image/.test(svgText) && !/data:image/.test(svgText),
  noLabels: !/<text/.test(svgText) && !/Origin/.test(svgText),
  poleCount: (svgText.match(/<path /g) ?? []).length,
  tcCount: (svgText.match(/<polygon /g) ?? []).length,
};
record('SVG export is vector primitives', svgChecks.vector && svgChecks.noImage);
record('SVG export hides Origin and alphabetical labels', svgChecks.noLabels);
record('SVG export keeps X and TC symbols', svgChecks.poleCount === 34 && svgChecks.tcCount === 1, JSON.stringify({ poles: svgChecks.poleCount, tc: svgChecks.tcCount }));

// ---- 8. PDF export ---------------------------------------------------
const pdfDownload = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btn-pdf'),
]).then(([d]) => d);
const pdfPath = resolve(OUT, 'export.pdf');
await pdfDownload.saveAs(pdfPath);
const pdfBytes = readFileSync(pdfPath);
const pdfHead = pdfBytes.subarray(0, 5).toString('latin1');
const pdfText = pdfBytes.toString('latin1');
record('PDF export downloads a PDF file', pdfHead === '%PDF-', `head=${pdfHead} size=${pdfBytes.length}`);
record('PDF export contains no raster image', !/\/Subtype\s*\/Image/.test(pdfText) && !/\/DCTDecode/.test(pdfText));
record('PDF export hides Origin and alphabetical labels', !/Origin/.test(pdfText) && !/\(A\)/.test(pdfText));

// ---- 9. print path ---------------------------------------------------
await page.evaluate(() => {
  window.__printed = 0;
  const original = window.print;
  window.print = () => {
    window.__printed += 1;
    if (original) original.call(window);
  };
});
let printDialogSeen = false;
page.on('dialog', () => {
  printDialogSeen = true;
});
// Intercept the iframe's print call instead of opening a real dialog.
await page.addInitScript(() => {});
const printFrames = [];
page.on('frameattached', (f) => printFrames.push(f));
await page.evaluate(() => {
  // Patch HTMLIFrameElement frames' print before the app creates the iframe.
  const originalAppend = document.body.appendChild.bind(document.body);
  document.body.appendChild = (node) => {
    const result = originalAppend(node);
    if (node.tagName === 'IFRAME') {
      node.addEventListener('load', () => {
        try {
          node.contentWindow.print = () => {
            window.__printed = (window.__printed || 0) + 1;
          };
        } catch {
          /* cross-document access is not needed for the count below */
        }
      });
    }
    return result;
  };
});
await page.click('#btn-print');
await page.waitForTimeout(400);
const printStatus = await page.textContent('#export-status');
record('print action runs and reports a page layout', /print dialog/i.test(printStatus ?? ''), printStatus);

// ---- 10. invalid network blocks export -------------------------------
await page.click('#btn-clear');
await page.selectOption('#field-from', { label: 'Origin' });
await page.fill('#field-spans', '1');
await page.click('#btn-save-route');
// Delete the only route: the list is now empty, so export is refused.
await page.locator('#route-rows tr').nth(0).locator('button[data-action="delete"]').click();
const disabled = await page.evaluate(() => ({
  pdf: document.querySelector('#btn-pdf').disabled,
  svg: document.querySelector('#btn-svg').disabled,
}));
record('export is blocked when there is nothing valid to draw', disabled.pdf && disabled.svg, JSON.stringify(disabled));

// ---- 11. span spacing affects drawing uniformly ----------------------
await page.click('#btn-load-example');
await page.waitForTimeout(150);
const widthAt40 = await page.evaluate(() => Number(/width="([\d.]+)"/.exec(document.querySelector('#preview-canvas svg').outerHTML)?.[1] ?? 0));
await page.fill('#field-spacing', '60');
await page.locator('#field-spacing').dispatchEvent('change');
await page.waitForTimeout(150);
const widthAt60 = await page.evaluate(() => Number(/width="([\d.]+)"/.exec(document.querySelector('#preview-canvas svg').outerHTML)?.[1] ?? 0));
record('span spacing scales the drawing uniformly', widthAt60 > widthAt40, `${widthAt40} -> ${widthAt60}`);
const topologySame = await page.evaluate(() => {
  const svg = document.querySelector('#preview-canvas svg');
  return { lines: svg.querySelectorAll('#route-lines line').length, poles: svg.querySelectorAll('#pole-markers path').length };
});
record('span spacing does not change topology', topologySame.lines === 33 && topologySame.poles === 34, JSON.stringify(topologySame));

// ---- 12. TC point is selectable by its TC identifier -----------------
await page.click('#btn-load-example');
await page.waitForTimeout(150);
const fromOptions = await page.evaluate(() =>
  [...document.querySelectorAll('#field-from option')].map((o) => o.textContent),
);
record(
  'dropdown offers the TC point by its identifier',
  fromOptions.includes('TC'),
  fromOptions.join(','),
);

// ---- 13. deleting an earlier route invalidates dependents ------------
await page.locator('#route-rows tr').nth(0).locator('button[data-action="delete"]').click();
await page.waitForTimeout(150);
const invalidCount = await page.locator('#route-rows .status-bad').count();
const errorShown = await page.evaluate(() => {
  const box = document.querySelector('#error-list');
  return { hidden: box.hidden, text: box.textContent };
});
record('deleting a source row marks dependents invalid', invalidCount > 0, `invalid rows=${invalidCount}`);
record(
  'dependent rows are explained, not dropped',
  !errorShown.hidden && /has not been created yet/i.test(errorShown.text),
  errorShown.text.slice(0, 120),
);
const blocked = await page.evaluate(() => document.querySelector('#btn-pdf').disabled);
record('export is blocked while dependents are invalid', blocked);

// ---- 14. console cleanliness ----------------------------------------
record('no console or page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await page.screenshot({ path: resolve(OUT, 'preview.png'), fullPage: true });
await writeFile(resolve(OUT, 'results.json'), JSON.stringify(results, null, 2));

await browser.close();

const failed = results.filter((r) => !r.passed);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  process.exitCode = 1;
}
