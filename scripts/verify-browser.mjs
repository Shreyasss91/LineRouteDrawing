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
    lines: new Set(
      [...svg.querySelectorAll('#route-lines line')].map((el) => el.getAttribute('data-edge')),
    ).size,
    poles: svg.querySelectorAll('#pole-markers path').length,
    tc: svg.querySelectorAll('#tc-markers polygon').length,
    texts: [...svg.querySelectorAll('#labels text')].map((t) => t.textContent),
    viewBox: svg.getAttribute('viewBox'),
  };
});
record('preview draws 33 merged route lines', svgInfo.lines === 33, `lines=${svgInfo.lines}`);
record(
  'preview draws one X per pole, excluding the TC anchor',
  svgInfo.poles === 33,
  `poles=${svgInfo.poles} (34 nodes, one TC point marked by its triangle)`,
);
record('preview draws 1 TC triangle', svgInfo.tc === 1, `tc=${svgInfo.tc}`);
record(
  'preview shows Origin and a label for every created endpoint',
  svgInfo.texts.includes('Origin') &&
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].every((l) => svgInfo.texts.includes(l)),
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
record('SVG export keeps X and TC symbols', svgChecks.poleCount === 33 && svgChecks.tcCount === 1, JSON.stringify({ poles: svgChecks.poleCount, tc: svgChecks.tcCount }));

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
  const edges = new Set(
    [...svg.querySelectorAll('#route-lines line')].map((el) => el.getAttribute('data-edge')),
  );
  return { lines: edges.size, poles: svg.querySelectorAll('#pole-markers path').length };
});
record('span spacing does not change topology', topologySame.lines === 33 && topologySame.poles === 33, JSON.stringify(topologySame));

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

// ---- 14. the TC point shows a triangle only, with no X stacked on it ----
await page.click('#btn-load-example');
await page.waitForTimeout(150);
const markerOverlap = await page.evaluate(() => {
  const svg = document.querySelector('#preview-canvas svg');
  const triangles = [...svg.querySelectorAll('#tc-markers polygon')].map((el) => {
    const [x, y] = el.getAttribute('points').trim().split(/\s+/)[0].split(',').map(Number);
    return { x, y };
  });
  const poleCentres = [...svg.querySelectorAll('#pole-markers path')].map((el) => {
    const n = el.getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
    return { x: (n[0] + n[2]) / 2, y: (n[1] + n[3]) / 2 };
  });
  const overlaps = triangles.filter((t) =>
    poleCentres.some((p) => Math.abs(p.x - t.x) < 1 && Math.abs(p.y - t.y) < 1),
  );
  return { triangles: triangles.length, poles: poleCentres.length, overlaps: overlaps.length };
});
record(
  'the TC triangle is not drawn over by a second X symbol',
  markerOverlap.triangles === 1 && markerOverlap.overlaps === 0,
  JSON.stringify(markerOverlap),
);

const tcSize = await page.evaluate(() => {
  const svg = document.querySelector('#preview-canvas svg');
  const pts = svg
    .querySelector('#tc-markers polygon')
    .getAttribute('points')
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number));
  const apexY = pts[0][1];
  const baseY = pts[1][1];
  const cx = pts[0][0];
  const poles = [...svg.querySelectorAll('#pole-markers path')].map((el) => {
    const n = el.getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
    return { x: (n[0] + n[2]) / 2, y: (n[1] + n[3]) / 2, half: Math.abs(n[2] - n[0]) / 2 };
  });
  const column = poles.filter((q) => Math.abs(q.x - cx) < 1).sort((a, b) => a.y - b.y);
  const above = column.filter((q) => q.y < apexY).pop();
  const below = column.find((q) => q.y > baseY);
  return {
    height: +(baseY - apexY).toFixed(1),
    width: +Math.abs(pts[1][0] - pts[2][0]).toFixed(1),
    gapAbove: above ? +(apexY - (above.y + above.half)).toFixed(1) : null,
    gapBelow: below ? +((below.y - below.half) - baseY).toFixed(1) : null,
  };
});
const tcInterior = await page.evaluate(() => {
  const svg = document.querySelector('#preview-canvas svg');
  const pts = svg
    .querySelector('#tc-markers polygon')
    .getAttribute('points')
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number));
  const apex = pts[0][1];
  const base = pts[1][1];
  const cx = pts[0][0];
  const halfWidth = Math.abs(pts[1][0] - cx);
  const lines = [...svg.querySelectorAll('line')].map((el) => ({
    x1: Number(el.getAttribute('x1')),
    y1: Number(el.getAttribute('y1')),
    x2: Number(el.getAttribute('x2')),
    y2: Number(el.getAttribute('y2')),
  }));
  // The outline belongs to the symbol; only the interior must stay empty.
  const inside = (x, y) => {
    const yn = (y - apex) / (base - apex);
    if (yn <= 0.001 || yn >= 0.999) return false;
    return Math.abs(x - cx) < halfWidth * (1 - yn) - 0.001;
  };
  let hits = 0;
  for (const line of lines) {
    for (let step = 0; step <= 40; step += 1) {
      const t = step / 40;
      const x = line.x1 + (line.x2 - line.x1) * t;
      const y = line.y1 + (line.y2 - line.y1) * t;
      if (inside(x, y)) hits += 1;
    }
  }
  const meetsApex = lines.some((line) => Math.abs(line.y1 - apex) < 1e-6 || Math.abs(line.y2 - apex) < 1e-6);
  return { hits, meetsApex, lines: lines.length };
});
record(
  'no route line is drawn inside the TC triangle',
  tcInterior.hits === 0,
  JSON.stringify(tcInterior),
);
record(
  'the trimmed line still meets the TC triangle',
  tcInterior.meetsApex === true,
  `a line ends on the apex: ${tcInterior.meetsApex}`,
);

record(
  'the TC triangle is drawn at the doubled size without reaching a pole',
  tcSize.height === 20 && tcSize.width === 24 && tcSize.gapAbove > 0 && tcSize.gapBelow > 0,
  JSON.stringify(tcSize),
);

// ---- 15. the From field preselects the most recently created endpoint ----
const preselected = await page.evaluate(() => {
  const select = document.querySelector('#field-from');
  return { id: select.value, label: select.selectedOptions[0]?.textContent ?? '' };
});
record(
  'From is preselecting the latest created endpoint after loading the example',
  preselected.id === 'endpoint:H' && preselected.label === 'H',
  JSON.stringify(preselected),
);

await page.click('#btn-clear');
await page.selectOption('#field-direction', 'south');
await page.fill('#field-spans', '1');
await page.click('#btn-save-route');
const afterStep1 = await page.evaluate(() => document.querySelector('#field-from').selectedOptions[0]?.textContent);
await page.selectOption('#field-direction', 'east');
await page.fill('#field-spans', '2');
await page.check('#field-tc');
await page.click('#btn-save-route');
const afterStep2 = await page.evaluate(() => document.querySelector('#field-from').selectedOptions[0]?.textContent);
record(
  'From advances to the newest endpoint as routes are added',
  afterStep1 === 'A' && afterStep2 === 'TC',
  `after first route=${afterStep1}, after TC route=${afterStep2}`,
);

// ---- 16. a new node is labelled as soon as it is created ------------
await page.click('#btn-clear');
await page.selectOption('#field-direction', 'south');
await page.fill('#field-spans', '2');
await page.click('#btn-save-route');
const labelsAfterOne = await page.evaluate(() =>
  [...document.querySelectorAll('#preview-canvas svg #labels text')].map((t) => t.textContent),
);
record(
  'a newly created node is labelled in the preview immediately',
  labelsAfterOne.includes('A') && labelsAfterOne.includes('Origin'),
  labelsAfterOne.join(','),
);

// ---- 17. FPB point draws a fitted box and no X ----------------------
await page.uncheck('#field-tc');
await page.check('#field-fpb');
await page.selectOption('#field-direction', 'east');
await page.fill('#field-spans', '3');
await page.click('#btn-save-route');
const fpbMarkers = await page.evaluate(() => {
  const svg = document.querySelector('#preview-canvas svg');
  const boxes = [...svg.querySelectorAll('#fpb-markers rect')].map((r) => ({
    x: Number(r.getAttribute('x')) + Number(r.getAttribute('width')) / 2,
    y: Number(r.getAttribute('y')) + Number(r.getAttribute('height')) / 2,
    w: Number(r.getAttribute('width')),
    h: Number(r.getAttribute('height')),
  }));
  const texts = [...svg.querySelectorAll('#fpb-markers text')].map((t) => t.textContent);
  const poles = [...svg.querySelectorAll('#pole-markers path')].map((el) => {
    const n = el.getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
    return { x: (n[0] + n[2]) / 2, y: (n[1] + n[3]) / 2 };
  });
  return { boxes, texts, poles };
});
const fpbBox = fpbMarkers.boxes[0];
const fpbOverlap = fpbMarkers.poles.filter(
  (p) => Math.abs(p.x - fpbBox.x) < 1 && Math.abs(p.y - fpbBox.y) < 1,
).length;
record(
  'the FPB point draws a box containing its label',
  fpbMarkers.boxes.length === 1 && fpbMarkers.texts[0] === 'FPB' && fpbBox.w > 0 && fpbBox.h > 0,
  JSON.stringify({ boxes: fpbMarkers.boxes.length, text: fpbMarkers.texts[0], w: fpbBox.w, h: fpbBox.h }),
);
record('the FPB box has no X drawn over it', fpbOverlap === 0, `overlaps=${fpbOverlap}`);
record(
  'the table records the marker kind',
  (await page.locator('#route-rows tr').nth(1).locator('td').nth(4).textContent()).trim() === 'FPB',
);

// both markers on one destination is refused
// The form resets its marker switches after each save, so set both explicitly.
await page.check('#field-tc');
await page.check('#field-fpb');
await page.fill('#field-spans', '1');
await page.click('#btn-save-route');
await page.waitForFunction(() => {
  const box = document.querySelector('#form-error');
  return box && !box.hidden && box.textContent.trim().length > 0;
}, null, { timeout: 2000 }).catch(() => {});
const bothMarkersError = await page.textContent('#form-error');
record(
  'a destination cannot be both TC and FPB',
  /not both/i.test(bothMarkersError ?? ''),
  (bothMarkersError ?? '').trim(),
);

// FPB survives into both exports
const fpbSvgDownload = await Promise.all([page.waitForEvent('download'), page.click('#btn-svg')]).then(([d]) => d);
const fpbSvgPath = resolve(OUT, 'fpb-check.svg');
await fpbSvgDownload.saveAs(fpbSvgPath);
const fpbSvgText = readFileSync(fpbSvgPath, 'utf8');
record(
  'SVG export keeps the FPB box and its label',
  /<g id="fpb-markers"/.test(fpbSvgText) && />FPB</.test(fpbSvgText) && !/>Origin</.test(fpbSvgText),
);

const fpbPdfDownload = await Promise.all([page.waitForEvent('download'), page.click('#btn-pdf')]).then(([d]) => d);
const fpbPdfPath = resolve(OUT, 'fpb-check.pdf');
await fpbPdfDownload.saveAs(fpbPdfPath);
const { inflateSync } = await import('node:zlib');
const fpbPdfBuf = readFileSync(fpbPdfPath);
const fpbPdfText = fpbPdfBuf.toString('latin1');
let streamAt = 0;
let rectOps = 0;
let fpbTextOps = 0;
while ((streamAt = fpbPdfText.indexOf('stream', streamAt)) !== -1) {
  const start = streamAt + 6;
  const stop = fpbPdfText.indexOf('endstream', start);
  if (stop < 0) break;
  let raw = fpbPdfBuf.subarray(start, stop);
  while (raw.length && (raw[0] === 10 || raw[0] === 13)) raw = raw.subarray(1);
  try {
    const decoded = inflateSync(raw).toString('latin1');
    rectOps += (decoded.match(/\sre[\s\n]/g) ?? []).length;
    fpbTextOps += (decoded.match(/\(FPB\) Tj/g) ?? []).length;
  } catch {
    /* an uncompressed stream does not inflate; ignore it */
  }
  streamAt = stop;
}
record(
  'PDF export draws the FPB as a vector rectangle with its label',
  rectOps > 0 && fpbTextOps > 0 && !/\/Subtype\s*\/Image/.test(fpbPdfText),
  `rectOps=${rectOps}, fpbTextOps=${fpbTextOps}`,
);

// leave the app in the example state for the remaining checks
await page.click('#btn-load-example');
await page.waitForTimeout(150);

// ---- 18. the Origin's own marker is selectable ----------------------
await page.click('#btn-load-example');
await page.waitForTimeout(150);
const readMarkers = () =>
  page.evaluate(() => {
    const svg = document.querySelector('#preview-canvas svg');
    return {
      poles: svg.querySelectorAll('#pole-markers path').length,
      tc: svg.querySelectorAll('#tc-markers polygon').length,
      fpb: svg.querySelectorAll('#fpb-markers rect').length,
    };
  });

const originPlain = await readMarkers();
record(
  'the Origin is a pole by default',
  originPlain.poles === 33 && originPlain.tc === 1 && originPlain.fpb === 0,
  JSON.stringify(originPlain),
);

await page.selectOption('#field-origin-marker', 'tc');
await page.waitForTimeout(200);
const originTc = await readMarkers();
record(
  'the Origin can be a TC point, losing its X and gaining a triangle',
  originTc.poles === 32 && originTc.tc === 2 && originTc.fpb === 0,
  JSON.stringify(originTc),
);

await page.selectOption('#field-origin-marker', 'fpb');
await page.waitForTimeout(200);
const originFpb = await readMarkers();
record(
  'the Origin can be an FPB point, losing its X and gaining a box',
  originFpb.poles === 32 && originFpb.tc === 1 && originFpb.fpb === 1,
  JSON.stringify(originFpb),
);

const originSvg = await Promise.all([page.waitForEvent('download'), page.click('#btn-svg')]).then(([d]) => d);
const originSvgPath = resolve(OUT, 'origin-fpb-check.svg');
await originSvg.saveAs(originSvgPath);
const originSvgText = readFileSync(originSvgPath, 'utf8');
record(
  'an FPB Origin survives into the SVG export',
  /<g id="fpb-markers"/.test(originSvgText) && />FPB</.test(originSvgText) && !/>Origin</.test(originSvgText),
);

await page.selectOption('#field-origin-marker', 'plain');
await page.waitForTimeout(150);
const originBack = await readMarkers();
record(
  'switching the Origin back to a pole restores its X',
  originBack.poles === 33 && originBack.fpb === 0,
  JSON.stringify(originBack),
);

// ---- 19. console cleanliness ----------------------------------------
record('no console or page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await page.screenshot({ path: resolve(OUT, 'preview.png'), fullPage: true });
await writeFile(resolve(OUT, 'results.json'), JSON.stringify(results, null, 2));

await browser.close();

const failed = results.filter((r) => !r.passed);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  process.exitCode = 1;
}
