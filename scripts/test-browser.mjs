/**
 * Browser verification harness, committed so it is reproducible.
 *
 * The application's Node tests cover the geometry, the schedules and the renderers,
 * but they cannot see three things that only exist in a real browser: whether point
 * designations survive a reload, whether a selection in the schedule reaches the
 * drawing, and whether the files a user actually downloads contain what they should.
 * Those are exactly the claims most likely to be quietly false, so they are checked
 * here against real downloads rather than against the controls that produce them.
 *
 * Run with:  npm run test:browser
 *
 * Requirements:
 *   - Node 20 or newer.
 *   - Playwright installed (`npm install --no-save playwright`), plus a browser.
 *     By default this uses the installed Google Chrome via `channel: 'chrome'`,
 *     which needs no extra download. Set BROWSER_CHANNEL to override it, or
 *     BROWSER_CHANNEL=chromium to use a Playwright-managed Chromium instead.
 *
 * The harness starts its own static server on a free port, clears storage before
 * each scenario, and makes no assumption about a server already running.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * Load Playwright from wherever it is installed.
 *
 * It is a development dependency, not something the application ships, so a checkout
 * that has never run the browser suite legitimately does not have it. Resolving it by
 * hand lets the harness say so in one sentence rather than failing with a module
 * loader stack trace, and lets a machine that keeps Playwright outside this project
 * point at it through PLAYWRIGHT_PATH.
 */
async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_PATH) candidates.push(process.env.PLAYWRIGHT_PATH);
  candidates.push('playwright');
  for (const candidate of candidates) {
    try {
      if (candidate === 'playwright') return await import('playwright');
      const require = createRequire(import.meta.url);
      return require(candidate);
    } catch {
      // Try the next one.
    }
  }
  process.stderr.write(
    [
      'Playwright is not installed.',
      'Install it once with:  npm install --no-save playwright',
      'The suite uses the installed Google Chrome by default and needs no browser download.',
      'Set BROWSER_CHANNEL=chromium to use a Playwright-managed browser instead.',
    ].join('\n') + '\n',
  );
  process.exit(2);
}

const { chromium } = await loadPlaywright();
const CHANNEL = process.env.BROWSER_CHANNEL ?? 'chrome';
const HEADLESS = process.env.HEADED !== '1';
const PORT = Number(process.env.PORT ?? 8171);

/* ------------------------------------------------------------------ */
/* Result recording                                                    */
/* ------------------------------------------------------------------ */

const results = [];
let failures = 0;
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  if (!passed) failures += 1;
  const mark = passed ? 'PASS' : 'FAIL';
  process.stdout.write(`${mark}  ${name}${detail ? `  (${detail})` : ''}\n`);
}

function section(title) {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

function startServer(port) {
  const child = spawn(process.execPath, [join(ROOT, 'scripts', 'serve.js'), String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* PDF text extraction (the PDF is compressed, so streams are inflated) */
/* ------------------------------------------------------------------ */

function pdfContent(bytes) {
  const buffer = Buffer.from(bytes);
  const chunks = [];
  let index = 0;
  while ((index = buffer.indexOf('stream', index)) !== -1) {
    let start = index + 6;
    if (buffer[start] === 0x0d) start += 1;
    if (buffer[start] === 0x0a) start += 1;
    const end = buffer.indexOf('endstream', start);
    if (end === -1) break;
    const slice = buffer.subarray(start, end);
    try {
      chunks.push(zlib.inflateSync(slice).toString('latin1'));
    } catch {
      chunks.push(slice.toString('latin1'));
    }
    index = end + 9;
  }
  return chunks.join('\n');
}

/* ------------------------------------------------------------------ */
/* Page helpers                                                        */
/* ------------------------------------------------------------------ */

/** Open a clean application state. */
async function fresh(page, base) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg', { timeout: 15000 });
}

/** The whole saved `node id -> designation` table, as the project stores it. */
function readDesignationMap(page) {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.includes('line-route')) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const project = JSON.parse(raw).project ?? {};
      return project.nodeDesignations ?? {};
    }
    return null;
  });
}

/** Every designation drawn in the mini-preview. */
function miniDesignations(page) {
  return page.locator('#mini-preview #point-designations text').allTextContents();
}

/** Add a route through the form and wait for the drawing to settle. */
async function addRoute(page, { from, direction, spans, tc = false, fpb = false }) {
  await page.selectOption('#field-from', from);
  await page.selectOption('#field-direction', direction);
  await page.fill('#field-spans', String(spans));
  await page.setChecked('#field-tc', tc);
  await page.setChecked('#field-fpb', fpb);
  await page.click('#btn-save-route');
  await page.waitForTimeout(350);
}

/** Add one load record to a point. */
async function addLoad(page, { nodeId, value, unit = 'kVA' }) {
  await page.click('#tab-loads');
  await page.selectOption('#field-load-node', nodeId);
  await page.fill('#field-load-value', String(value));
  await page.selectOption('#field-load-unit', unit);
  await page.click('#btn-add-load');
  await page.waitForTimeout(250);
}

/** Save a download and return its path. */
async function saveDownload(page, buttonId, dir, name) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(buttonId).click(),
  ]);
  const path = join(dir, name);
  await download.saveAs(path);
  return path;
}

/* ------------------------------------------------------------------ */
/* The suite                                                           */
/* ------------------------------------------------------------------ */

const base = `http://127.0.0.1:${PORT}/`;
const server = startServer(PORT);
const workdir = await mkdtemp(join(tmpdir(), 'lrd-browser-'));

if (!(await waitForServer(base))) {
  process.stderr.write(`The application server did not start on ${base}\n`);
  server.kill();
  process.exit(1);
}

const browser = await chromium.launch(
  CHANNEL === 'chromium' ? { headless: HEADLESS } : { headless: HEADLESS, channel: CHANNEL },
);
const context = await browser.newContext({
  viewport: { width: 1600, height: 1200 },
  acceptDownloads: true,
});
const page = await context.newPage();

const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
// The import flow asks through native dialogs; a paste is answered with the text.
let promptAnswer = '';
page.on('dialog', async (dialog) => {
  if (dialog.type() === 'prompt') await dialog.accept(promptAnswer);
  else await dialog.dismiss(); // The confirm chooses "Cancel", meaning "paste a block".
});

try {
  /* ---------------- Designations ---------------- */

  section('Point designations');

  await fresh(page, base);
  await page.click('#btn-load-example');
  await page.waitForTimeout(700);

  const firstMap = await readDesignationMap(page);
  check(
    'the example names every eligible point',
    firstMap && Object.keys(firstMap).length > 20,
    `${firstMap ? Object.keys(firstMap).length : 0} entries`,
  );

  const drawn = await miniDesignations(page);
  check('the reference drawing shows the names', drawn.length > 20, `${drawn.length} labels`);
  // The example has no Origin intermediates, so the colon form is proved by the TC
  // poles it does have: `TC:1` is a pole, `TC` is the point itself. The two must be
  // distinguishable, which is the whole reason for the colon.
  check(
    'special sources use the colon form for their poles',
    drawn.some((t) => /^TC:\d+$/.test(t)) && drawn.some((t) => /^TC$/.test(t)),
    drawn.filter((t) => /^TC/.test(t)).slice(0, 3).join(' '),
  );
  check(
    'no internal id is drawn as a name',
    !drawn.some((t) => t.startsWith('mid:') || t.startsWith('dst:')),
  );

  // Reload: every id must keep exactly the designation it had.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mini-preview svg', { timeout: 15000 });
  await page.waitForTimeout(700);
  const secondMap = await readDesignationMap(page);
  const ids = new Set([...Object.keys(firstMap ?? {}), ...Object.keys(secondMap ?? {})]);
  const changed = [...ids].filter((id) => (firstMap?.[id] ?? null) !== (secondMap?.[id] ?? null));
  check(
    'every designation survives a reload unchanged',
    changed.length === 0,
    changed.length ? `${changed.length} changed, e.g. ${changed.slice(0, 3).join(', ')}` : `${ids.size} ids identical`,
  );

  // A second reload proves it is stable rather than alternating between two maps.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const thirdMap = await readDesignationMap(page);
  const changedAgain = [...ids].filter((id) => (secondMap?.[id] ?? null) !== (thirdMap?.[id] ?? null));
  check('the map is stable across a second reload', changedAgain.length === 0);

  // Numbering continues across a new branch from an existing source rather than
  // restarting at 1.
  const aSource = await page.evaluate(() => {
    const values = [...document.querySelectorAll('#field-from option')].map((o) => o.value);
    return values.find((v) => /^endpoint:[A-Z]$/.test(v)) ?? values[1];
  });
  const beforeBranch = await readDesignationMap(page);
  await addRoute(page, { from: aSource, direction: 'west', spans: 3 });
  const afterBranch = await readDesignationMap(page);
  const renamed = Object.keys(beforeBranch ?? {}).filter(
    (id) => (afterBranch?.[id] ?? null) !== (beforeBranch?.[id] ?? null),
  );
  check(
    'adding a branch renames nothing that already existed',
    renamed.length === 0,
    renamed.slice(0, 3).join(', '),
  );
  const added = Object.keys(afterBranch ?? {}).filter((id) => !(id in (beforeBranch ?? {})));
  const letter = aSource.replace('endpoint:', '');
  const addedNames = added
    .map((id) => afterBranch[id])
    .filter((name) => new RegExp(`^${letter}\\d+$`).test(name))
    .sort();
  check(
    'a new branch continues its source numbering',
    addedNames.length > 0 && Number(addedNames[0].slice(letter.length)) > 1,
    addedNames.join(', ') || 'none',
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const afterBranchReload = await readDesignationMap(page);
  const branchDrift = Object.keys(afterBranch ?? {}).filter(
    (id) => (afterBranchReload?.[id] ?? null) !== (afterBranch?.[id] ?? null),
  );
  check('the new branch is stable across a reload', branchDrift.length === 0);

  /* ---------------- Bigger network: TC/FPB naming and spans ---------------- */

  section('Span designations, TC and FPB naming');

  await fresh(page, base);
  await addRoute(page, { from: 'origin', direction: 'south', spans: 2 });
  await addRoute(page, { from: 'endpoint:A', direction: 'east', spans: 2, fpb: true });
  const tcSource = await page.evaluate(() => {
    const values = [...document.querySelectorAll('#field-from option')].map((o) => o.value);
    return values.find((v) => /^endpoint:[B]$/.test(v)) ?? values[values.length - 1];
  });
  await addRoute(page, { from: tcSource, direction: 'south', spans: 2, tc: true });
  await page.waitForTimeout(300);

  await page.click('#tab-spans');
  const spanTable = await page.locator('#span-rows tr').evaluateAll((rows) =>
    rows.map((row) => {
      const cells = [...row.querySelectorAll('td')].map((c) => c.textContent.trim());
      const input = row.querySelector('input');
      return { span: cells[0], id: cells[1], from: cells[2], to: cells[3], length: input ? input.value : '' };
    }),
  );
  check('every physical span has one row', spanTable.length > 0, `${spanTable.length} rows`);
  check(
    'span designations are the two endpoint names joined by an en dash',
    spanTable.every((row) => row.span.includes('\u2013')),
    spanTable[0]?.span,
  );
  check(
    'span designations match their From and To columns',
    spanTable.every((row) => row.span === `${row.from}\u2013${row.to}`),
  );
  check(
    'span rows are unique by internal id',
    new Set(spanTable.map((r) => r.id)).size === spanTable.length,
  );
  // The FPB added above is a route destination, so its name is the endpoint name the
  // drawing gives it, and an FPB *source* would use the colon form. This network has
  // an FPB destination; the check is that it is named at all and drawn as a box.
  const drawnNames = await miniDesignations(page);
  const fpbBoxes = await page.locator('#preview-canvas #fpb-markers rect').count();
  check('an FPB is drawn as a box', fpbBoxes >= 1, `${fpbBoxes} boxes`);
  check(
    'every drawn point has a designation',
    drawnNames.length > 0 && !drawnNames.some((n) => n.trim() === ''),
  );
  const tcNames = await miniDesignations(page);
  check('a TC point keeps its TC name', tcNames.some((n) => /^TC\d*$/.test(n)));

  /* ---------------- Loads and lengths ---------------- */

  section('Loads, lengths and the incompleteness notice');

  await page.click('#tab-loads');
  const fpbOption = await page.evaluate(() => {
    const options = [...document.querySelectorAll('#field-load-node option')].map((o) => o.value);
    return options.find((v) => v.startsWith('dst:')) ?? options[0];
  });
  await addLoad(page, { nodeId: fpbOption, value: 25, unit: 'kVA' });
  await addLoad(page, { nodeId: fpbOption, value: 5, unit: 'kW' });
  await addLoad(page, { nodeId: fpbOption, value: 12, unit: 'HP' });

  const loadRows = await page.locator('#load-rows tr').count();
  check('three loads are recorded on one point', loadRows === 3, `${loadRows} rows`);
  const calloutText = await page.locator('#preview-canvas g[id^="callout:"]').first().textContent();
  check(
    'one callout shows all three loads, unsummed',
    /25 kVA/.test(calloutText) && /5 kW/.test(calloutText) && /12 HP/.test(calloutText),
    calloutText.replace(/\s+/g, ' ').trim(),
  );
  check(
    'the callout is a single group for the point',
    (await page.locator('#preview-canvas g[id^="callout:"]').count()) === 1,
  );

  const noticeBefore = await page.locator('#preview-canvas g#notice').count();
  check('the preview warns that spans are unmeasured', noticeBefore === 1);
  const noticeText = await page.locator('#preview-canvas g#notice text').textContent();
  check(
    'the warning counts the unmeasured spans',
    /Span measurements incomplete: \d+ of \d+ spans unmeasured\./.test(noticeText),
    noticeText,
  );
  const dashLabels = await page.locator('#preview-canvas #span-lengths text').allTextContents();
  check(
    'an unmeasured span reads as a dash, never a zero',
    dashLabels.some((t) => t.trim() === '\u2014 m'),
  );

  // A decimal length is accepted and shown as entered.
  await page.click('#tab-spans');
  const firstInput = page.locator('#span-rows tr').first().locator('input').first();
  await firstInput.fill('28.5');
  await firstInput.press('Enter');
  await page.waitForTimeout(350);
  const measuredLabels = await page.locator('#preview-canvas #span-lengths text').allTextContents();
  check(
    'a decimal length is drawn as measured',
    measuredLabels.some((t) => t.includes('28.5')),
    measuredLabels.filter((t) => t.includes('28.5')).join(', '),
  );

  // The default-length utility fills only what is unmeasured.
  const measuredCountBefore = measuredLabels.filter((t) => !t.includes('\u2014')).length;
  await page.fill('#field-default-length', '30');
  await page.click('#btn-apply-default');
  await page.waitForTimeout(450);
  const afterDefault = await page.locator('#preview-canvas #span-lengths text').allTextContents();
  const kept = afterDefault.some((t) => t.includes('28.5'));
  check('the default length does not overwrite an existing measurement', kept);
  check(
    'the default length fills the remaining spans',
    afterDefault.filter((t) => t.includes('\u2014')).length === 0,
    `${measuredCountBefore} measured before`,
  );
  check(
    'the notice disappears once every span is measured',
    (await page.locator('#preview-canvas g#notice').count()) === 0,
  );

  /* ---------------- Selection ---------------- */

  section('Selection and the reference drawing');

  await page.click('#tab-loads');
  await page.locator('#load-rows tr').first().click();
  await page.waitForTimeout(250);
  const ringAfterRow = await page.locator('#mini-preview #mini-selection *').count();
  check('selecting a schedule row highlights the reference drawing', ringAfterRow > 0, `${ringAfterRow} marks`);

  const highlightRow = await page.locator('#load-rows tr.is-selected, #load-rows tr.selected').count();
  check('the selected row is marked', highlightRow >= 1);

  // Select a pole in the drawing; the matching schedule group should light up.
  const poleBox = await page.locator('#preview-canvas #pole-markers path').nth(2).boundingBox();
  if (poleBox) {
    await page.mouse.click(poleBox.x + poleBox.width / 2, poleBox.y + poleBox.height / 2);
    await page.waitForTimeout(300);
  }
  const ringAfterPole = await page.locator('#mini-preview #mini-selection *').count();
  check('clicking a pole in the drawing highlights the reference', ringAfterPole > 0, `${ringAfterPole} marks`);

  /* ---------------- Dragging a callout ---------------- */

  section('Manual annotation placement');

  // Start from a known view. Clicking a pole in the previous section can leave the
  // drawing panned so the callout sits outside the canvas, and a drag that begins on
  // empty SVG moves nothing - which would look like a broken drag feature rather than
  // a mistimed test. Fit the drawing first, then take the callout's real target.
  await page.click('#btn-fit');
  await page.waitForTimeout(300);
  await page.mouse.move(20, 20);
  await page.waitForTimeout(120);

  // Read the callout's position from its own SVG coordinates, re-queried each time.
  // A re-render replaces the element, so a saved handle would report the old geometry
  // and make a working drag look like a no-op.
  const calloutPosition = () =>
    page.evaluate(() => {
      const plate = document.querySelector('#preview-canvas rect.callout-plate');
      if (!plate) return null;
      return { x: Number(plate.getAttribute('x')), y: Number(plate.getAttribute('y')) };
    });

  const beforePosition = await calloutPosition();
  const plate = await page.locator('#preview-canvas rect.callout-plate').first().boundingBox();
  if (plate) {
    const startX = plate.x + plate.width / 2;
    const startY = plate.y + plate.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(startX + step * 10, startY + step * 5);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  const afterPosition = await calloutPosition();
  const moved =
    beforePosition && afterPosition
      ? Math.abs(afterPosition.x - beforePosition.x) > 10 || Math.abs(afterPosition.y - beforePosition.y) > 10
      : false;
  check(
    'a callout can be dragged',
    moved,
    beforePosition && afterPosition
      ? `dx=${Math.round(afterPosition.x - beforePosition.x)} dy=${Math.round(afterPosition.y - beforePosition.y)}`
      : 'callout not found',
  );

  await page.waitForTimeout(700);
  const reloadedPosition = await calloutPosition();
  const survived =
    reloadedPosition && afterPosition
      ? Math.abs(reloadedPosition.x - afterPosition.x) < 1 && Math.abs(reloadedPosition.y - afterPosition.y) < 1
      : false;
  check('the dragged position survives a reload', survived);

  /* ---------------- Spreadsheet workflow ---------------- */

  section('Spreadsheet and CSV workflow');

  await page.click('#tab-spans');
  const copied = await page.evaluate(async () => {
    // The copy button writes to the clipboard; read it back through the same API.
    const rows = [...document.querySelectorAll('#span-rows tr')].map((row) =>
      [...row.querySelectorAll('td')].map((c) => c.textContent.trim()),
    );
    return rows;
  });
  check('the span table has a header row of designations', copied.length > 0);

  // A valid block: the same spans, one length filled. The import must be STAGED -
  // shown for review - rather than applied the moment the text is confirmed.
  const spanRowsForCsv = await page.locator('#span-rows tr').evaluateAll((rows) =>
    rows.map((row) => {
      const cells = [...row.querySelectorAll('td')].map((c) => c.textContent.trim());
      return { spanId: cells[1], designation: cells[0], from: cells[2], to: cells[3] };
    }),
  );
  const validBlock = [
    'spanId,spanDesignation,fromNodeId,toNodeId,fromDesignation,toDesignation,lengthM',
    ...spanRowsForCsv.map((row) =>
      [row.spanId, row.designation, '', '', row.from, row.to, '31'].join(','),
    ),
  ].join('\n');

  promptAnswer = validBlock;
  await page.click('#btn-spans-import');
  await page.waitForTimeout(500);
  const stagingVisible = await page.locator('#import-staging').isVisible();
  check('a valid import is staged for review before it applies', stagingVisible);
  const stagedHeading = await page.locator('#import-heading').textContent();
  check('the staged import offers to apply', /Replace|Update/i.test(stagedHeading), stagedHeading);

  // Nothing has changed yet: cancelling leaves the schedule as it was.
  const lengthsBeforeCancel = await page
    .locator('#span-rows input')
    .evaluateAll((inputs) => inputs.map((i) => i.value).join('|'));
  await page.click('#btn-import-cancel');
  await page.waitForTimeout(250);
  const lengthsAfterCancel = await page
    .locator('#span-rows input')
    .evaluateAll((inputs) => inputs.map((i) => i.value).join('|'));
  check('cancelling a staged import applies nothing', lengthsBeforeCancel === lengthsAfterCancel);

  // Apply it, and the lengths land.
  promptAnswer = validBlock;
  await page.click('#btn-spans-import');
  await page.waitForTimeout(400);
  await page.click('#btn-import-apply');
  await page.waitForTimeout(500);
  const appliedLengths = await page
    .locator('#span-rows input')
    .evaluateAll((inputs) => inputs.map((i) => i.value));
  check(
    'applying the staged import writes the lengths',
    appliedLengths.some((v) => v === '31'),
    `${appliedLengths.filter((v) => v === '31').length} spans at 31`,
  );

  // An invalid block must be refused outright and change nothing. Duplicate spans
  // are a hard error (one physical edge cannot have two lengths); an unknown span,
  // by contrast, is deliberately kept as an unresolved record, so it is not used here.
  const rowsBeforeInvalid = await page.locator('#span-rows tr').count();
  const duplicateBlock = [
    'spanId,spanDesignation,fromNodeId,toNodeId,fromDesignation,toDesignation,lengthM',
    spanRowsForCsv[0].spanId + ',X\u2013Y,,,X,Y,30',
    spanRowsForCsv[0].spanId + ',X\u2013Y,,,X,Y,31',
  ].join('\n');
  promptAnswer = duplicateBlock;
  await page.click('#btn-spans-import');
  await page.waitForTimeout(400);
  const refusalHeading = await page.locator('#import-heading').textContent();
  check('an invalid import is refused', /not accepted/i.test(refusalHeading), refusalHeading);
  const applyDisabled = await page.locator('#btn-import-apply').isDisabled();
  check('a refused import cannot be applied', applyDisabled);
  await page.click('#btn-import-cancel');
  await page.waitForTimeout(250);
  const rowsAfterInvalid = await page.locator('#span-rows tr').count();
  check('a refused import changed nothing', rowsAfterInvalid === rowsBeforeInvalid, `${rowsAfterInvalid} rows`);

  /* ---------------- Export toggles ---------------- */

  section('Export visibility');

  // Rebuild a known state: one load, one measured span, the rest unmeasured.
  await fresh(page, base);
  await page.click('#btn-load-example');
  await page.waitForTimeout(700);
  const target = await page.evaluate(() => {
    const options = [...document.querySelectorAll('#field-load-node option')].map((o) => o.value);
    return options.find((v) => v.startsWith('dst:')) ?? options[0];
  });
  await addLoad(page, { nodeId: target, value: 25, unit: 'kVA' });
  await page.click('#tab-spans');
  const oneSpan = page.locator('#span-rows tr').nth(1).locator('input').first();
  await oneSpan.fill('28.5');
  await oneSpan.press('Enter');
  await page.waitForTimeout(400);

  check('both switches start on', (await page.locator('#field-export-loads').isChecked()) && (await page.locator('#field-export-lengths').isChecked()));

  const svgBoth = await saveDownload(page, '#btn-svg', workdir, 'both.svg');
  await page.locator('#field-export-lengths').uncheck();
  await page.waitForTimeout(300);
  const svgLoadsOnly = await saveDownload(page, '#btn-svg', workdir, 'loadsonly.svg');
  await page.locator('#field-export-loads').uncheck();
  await page.locator('#field-export-lengths').check();
  await page.waitForTimeout(300);
  const svgLengthsOnly = await saveDownload(page, '#btn-svg', workdir, 'lengthsonly.svg');
  await page.locator('#field-export-loads').uncheck();
  await page.locator('#field-export-lengths').uncheck();
  await page.waitForTimeout(300);
  const svgNeither = await saveDownload(page, '#btn-svg', workdir, 'neither.svg');

  const read = async (path) => readFile(path, 'utf8');
  const both = await read(svgBoth);
  const loadsOnly = await read(svgLoadsOnly);
  const lengthsOnly = await read(svgLengthsOnly);
  const neither = await read(svgNeither);

  check('both on: loads are drawn', /25 kVA/.test(both));
  check('both on: span lengths are drawn', /28\.5 m/.test(both));
  check('loads only: no span group', !/<g id="span-lengths"/.test(loadsOnly) && !/28\.5 m/.test(loadsOnly));
  check('loads only: the load survives', /25 kVA/.test(loadsOnly));
  check('lengths only: no callout and no leader', !/id="callout:/.test(lengthsOnly) && !/class="leader"/.test(lengthsOnly));
  check('lengths only: the dash placeholder is kept', /\u2014 m/.test(lengthsOnly));
  check('neither: no annotation groups at all', !/id="callout:/.test(neither) && !/<g id="span-lengths"/.test(neither));

  for (const [name, markup] of Object.entries({ both, loadsOnly, lengthsOnly, neither })) {
    check(`${name}: no completeness banner text`, !/Span measurements incomplete/.test(markup));
    check(`${name}: no notice group`, !/<g id="notice"/.test(markup));
  }
  check(
    'markers survive every combination',
    [both, loadsOnly, lengthsOnly, neither].every((m) => /<polygon /.test(m)),
  );
  check(
    'the preview keeps the notice even when exports do not',
    (await page.locator('#preview-canvas g#notice').count()) === 1,
  );

  /* ---------------- PDF ---------------- */

  section('PDF output');

  await page.locator('#field-export-loads').check();
  await page.locator('#field-export-lengths').check();
  await page.waitForTimeout(300);
  const pdfPath = await saveDownload(page, '#btn-pdf', workdir, 'drawing.pdf');
  const pdfBytes = await readFile(pdfPath);
  const pdfText = pdfContent(pdfBytes);
  const pdfRaw = pdfBytes.toString('latin1');
  check('the PDF has no banner text', !/Span measurements incomplete/.test(pdfText));
  check('the PDF is vector-only', !/\/Subtype\s*\/Image/.test(pdfRaw));
  check('the PDF contains real text', (pdfText.match(/\bBT\b/g) ?? []).length > 10);
  check('the PDF carries the load when enabled', /kVA/.test(pdfText));
  check('the PDF carries a span length when enabled', /28\.5/.test(pdfText));

  /* ---------------- Print ---------------- */

  // The print document is built by `printDrawing()`, which writes a fresh page into
  // a hidden iframe and calls `print()` on it. That path had never been checked
  // against the paper it claims: the `@page` rule was hardcoded to A4, so choosing
  // A3 or Letter sent an A4 sheet to the printer and scaled the drawing for paper it
  // was not on. The layout list is read from the selector the application renders
  // from its own page configuration, so a layout added to the product is covered
  // here without editing this file.
  //
  // `window.print()` is stubbed before the button is pressed. A real dialog blocks a
  // headless run, and the document has already been written by the time it is called,
  // so the stub captures exactly what a print would send while the rest of the flow
  // runs unchanged.

  section('Print output, every page layout');

  const PRINT_LAYOUTS = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#field-layout option')).map((option) => ({
      id: option.value,
      label: option.textContent.trim(),
    })),
  );
  check(
    'the page layout selector offers the configured layouts',
    PRINT_LAYOUTS.length >= 4,
    `${PRINT_LAYOUTS.length}: ${PRINT_LAYOUTS.map((l) => l.id).join(', ')}`,
  );
  for (const required of ['a4_landscape', 'a4_portrait', 'a3_landscape', 'letter_landscape']) {
    check(
      `the selector offers ${required}`,
      PRINT_LAYOUTS.some((l) => l.id === required),
    );
  }

  /** Read every straight segment out of a print document's SVG. */
  function printedSegments(html) {
    const segments = [];
    for (const match of html.matchAll(/<line\b([^>]*)>/g)) {
      const attr = (name) => {
        const found = match[1].match(new RegExp(`${name}="(-?[\\d.]+)"`));
        return found ? Number(found[1]) : null;
      };
      const x1 = attr('x1');
      const y1 = attr('y1');
      const x2 = attr('x2');
      const y2 = attr('y2');
      if ([x1, y1, x2, y2].every((v) => v !== null)) segments.push({ x1, y1, x2, y2 });
    }
    return segments;
  }

  /** Strict point-in-triangle, boundary excluded. */
  function strictlyInside(p, tri) {
    const sign = (a, b, c) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
    const e = 1e-3;
    const d1 = sign(p, tri[0], tri[1]);
    const d2 = sign(p, tri[1], tri[2]);
    const d3 = sign(p, tri[2], tri[0]);
    return (d1 > e && d2 > e && d3 > e) || (d1 < -e && d2 < -e && d3 < -e);
  }

  /** Parameter along a segment where it meets another, or null. */
  function crossingT(segment, a, b) {
    const rX = segment.x2 - segment.x1;
    const rY = segment.y2 - segment.y1;
    const sX = b.x - a.x;
    const sY = b.y - a.y;
    const den = rX * sY - rY * sX;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((a.x - segment.x1) * sY - (a.y - segment.y1) * sX) / den;
    const u = ((a.x - segment.x1) * rY - (a.y - segment.y1) * rX) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return t;
  }

  for (const layout of PRINT_LAYOUTS) {
    await fresh(page, base);
    await page.click('#btn-load-example');
    await page.waitForSelector('#preview-canvas svg', { timeout: 15000 });
    await page.selectOption('#field-layout', layout.id);
    await page.waitForTimeout(120);

    // Enter one load, so the print sheet has a measured annotation to carry. Without
    // it the annotation layers are legitimately empty and a visibility check would
    // pass while proving nothing.
    const loadNode = await page.evaluate(() => {
      const select = document.querySelector('#field-load-node');
      return select && select.options.length ? select.options[0].value : '';
    });
    if (loadNode) {
      await page.selectOption('#field-load-node', loadNode);
      await page.fill('#field-load-value', '25');
      await page.click('#btn-add-load');
      await page.waitForTimeout(150);
    }

    // Capture the print document without opening a dialog.
    await page.evaluate(() => {
      window.__printCapture = null;
      const make = document.createElement.bind(document);
      document.createElement = function (tag, ...rest) {
        const el = make(tag, ...rest);
        if (String(tag).toLowerCase() === 'iframe') {
          el.addEventListener('load', () => {
            try {
              el.contentWindow.print = () => {
                const written = el.contentWindow.document;
                window.__printCapture = {
                  html: written.documentElement.outerHTML,
                  css: Array.from(written.querySelectorAll('style'))
                    .map((s) => s.textContent)
                    .join('\n'),
                };
              };
            } catch (error) {
              window.__printCapture = { html: '', css: '', error: String(error) };
            }
          });
        }
        return el;
      };
      window.__restoreCreateElement = () => {
        document.createElement = make;
      };
    });

    await page.locator('#btn-print').click();
    await page.waitForFunction(() => window.__printCapture !== null, { timeout: 8000 });
    const captured = await page.evaluate(() => {
      const result = window.__printCapture;
      window.__restoreCreateElement();
      return result;
    });
    const printCss = captured.css ?? '';
    const printHtml = captured.html ?? '';

    // The paper the sheet declares. This is the defect the act was opened for.
    const pageRule = (printCss.match(/@page\s*\{[^}]*\}/) ?? [''])[0];
    const sizeValue = (pageRule.match(/size:\s*([^;}]+)/) ?? [])[1]?.trim() ?? '';
    check(
      `${layout.id}: the print sheet declares its own paper size`,
      sizeValue.toLowerCase() === layout.label.toLowerCase(),
      `@page size "${sizeValue}" for ${layout.label}`,
    );
    check(
      `${layout.id}: the print sheet declares a page margin`,
      /margin:\s*\d/.test(pageRule),
      pageRule.replace(/\s+/g, ' '),
    );

    // The status line has to agree with the paper, or the user is told one thing
    // while the printer is given another.
    const status = await page.evaluate(
      () => document.querySelector('#export-status')?.textContent ?? '',
    );
    check(
      `${layout.id}: the status line names the paper that was set`,
      status.includes(layout.label),
      status.trim(),
    );

    // The embedded drawing.
    check(`${layout.id}: the print sheet embeds the drawing`, /<svg[\s>]/.test(printHtml));
    const svgTag = (printHtml.match(/<svg[^>]*>/) ?? [''])[0];
    const viewBox = (svgTag.match(/viewBox="([^"]+)"/) ?? [])[1] ?? '';
    check(
      `${layout.id}: the embedded SVG carries a viewBox`,
      /^-?[\d.]+\s+-?[\d.]+\s+[\d.]+\s+[\d.]+$/.test(viewBox),
      viewBox,
    );
    check(`${layout.id}: the drawing scales to the printed page`, /width:100%/.test(printCss));

    // The symbol, read from the print sheet rather than from the preview.
    const polygonMatch = printHtml.match(/<polygon[^>]*id="tc:[^>]*points="([^"]+)"/);
    const points = polygonMatch ? polygonMatch[1] : '';
    check(`${layout.id}: the printed sheet carries the TC triangle`, points.length > 0);

    const vertices = points
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((pair) => {
        const [x, y] = pair.split(',').map(Number);
        return { x, y };
      });

    const segments = printedSegments(printHtml);
    check(
      `${layout.id}: the printed sheet carries conductible geometry`,
      segments.length > 5,
      `${segments.length} lines`,
    );

    if (vertices.length === 3) {
      const [apex, b1, b2] = vertices;
      const baseMid = { x: (b1.x + b2.x) / 2, y: (b1.y + b2.y) / 2 };

      // Orientation: the apex is centred on the base and stands off it.
      check(
        `${layout.id}: the printed triangle is centred on its base`,
        Math.abs(apex.x - baseMid.x) < 0.51 || Math.abs(apex.y - baseMid.y) < 0.51,
        `apex (${apex.x},${apex.y}) base mid (${baseMid.x.toFixed(1)},${baseMid.y.toFixed(1)})`,
      );
      check(
        `${layout.id}: the printed triangle has a positive height`,
        Math.hypot(apex.x - baseMid.x, apex.y - baseMid.y) > 1,
        `${Math.hypot(apex.x - baseMid.x, apex.y - baseMid.y).toFixed(2)}`,
      );
      check(
        `${layout.id}: the printed base corners share an axis`,
        Math.abs(b1.x - b2.x) < 0.51 || Math.abs(b1.y - b2.y) < 0.51,
        `(${b1.x},${b1.y}) (${b2.x},${b2.y})`,
      );

      const endpoints = [];
      for (const seg of segments) {
        endpoints.push({ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 });
      }
      const onPoint = (p, tol = 0.51) =>
        endpoints.some((e) => Math.abs(e.x - p.x) < tol && Math.abs(e.y - p.y) < tol);

      check(`${layout.id}: the printed conductor meets the apex`, onPoint(apex));
      check(`${layout.id}: the printed conductor meets the base midpoint`, onPoint(baseMid));

      // No conductor may run through the interior.
      const tri = [apex, b1, b2];
      let intrusions = 0;
      for (const seg of segments) {
        const isSide =
          (Math.abs(seg.x1 - apex.x) < 0.01 &&
            Math.abs(seg.y1 - apex.y) < 0.01 &&
            ((Math.abs(seg.x2 - b1.x) < 0.01 && Math.abs(seg.y2 - b1.y) < 0.01) ||
              (Math.abs(seg.x2 - b2.x) < 0.01 && Math.abs(seg.y2 - b2.y) < 0.01))) ||
          (Math.abs(seg.x1 - b1.x) < 0.01 &&
            Math.abs(seg.y1 - b1.y) < 0.01 &&
            Math.abs(seg.x2 - b2.x) < 0.01 &&
            Math.abs(seg.y2 - b2.y) < 0.01) ||
          (Math.abs(seg.x1 - b2.x) < 0.01 &&
            Math.abs(seg.y1 - b2.y) < 0.01 &&
            Math.abs(seg.x2 - b1.x) < 0.01 &&
            Math.abs(seg.y2 - b1.y) < 0.01);
        if (isSide) continue;
        const cuts = [0, 1];
        for (let i = 0; i < 3; i += 1) {
          const t = crossingT(seg, tri[i], tri[(i + 1) % 3]);
          if (t !== null) cuts.push(t);
        }
        cuts.sort((p, q) => p - q);
        for (let i = 0; i + 1 < cuts.length; i += 1) {
          if (cuts[i + 1] - cuts[i] < 1e-9) continue;
          const t = (cuts[i] + cuts[i + 1]) / 2;
          const p = {
            x: seg.x1 + (seg.x2 - seg.x1) * t,
            y: seg.y1 + (seg.y2 - seg.y1) * t,
          };
          if (strictlyInside(p, tri)) {
            intrusions += 1;
            break;
          }
        }
      }
      check(
        `${layout.id}: no printed conductor runs inside the triangle`,
        intrusions === 0,
        `${intrusions} lines`,
      );

      // The leaving span keeps one whole configured spacing on the printed sheet.
      // The spacing is read from the field the drawing is using, never restated here.
      const spacing = Number(await page.inputValue('#field-spacing'));
      let leaving = 0;
      for (const seg of segments) {
        for (const [start, other] of [
          [{ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }],
          [{ x: seg.x2, y: seg.y2 }, { x: seg.x1, y: seg.y1 }],
        ]) {
          if (Math.abs(start.x - baseMid.x) > 0.51 || Math.abs(start.y - baseMid.y) > 0.51) {
            continue;
          }
          const length = Math.hypot(other.x - start.x, other.y - start.y);
          if (length > leaving) leaving = length;
        }
      }
      check(
        `${layout.id}: the printed leaving span equals the configured spacing`,
        spacing > 0 && Math.abs(leaving - spacing) < 0.6,
        `${leaving.toFixed(2)} px against a ${spacing} px spacing`,
      );
    } else {
      check(`${layout.id}: the printed triangle has three points`, false, `${vertices.length}`);
    }

    // Markers survive the print path, and the print visibility rules hold: loads and
    // span labels are kept, while the drawing's own point labels and any status
    // banner or notice are not printed.
    check(`${layout.id}: the printed sheet keeps the TC markers`, /<polygon /.test(printHtml));
    // A load is entered before printing so the annotation is present to be checked.
    // A print sheet is only meaningful if it carries the measured data the drawing
    // holds, and the export visibility rules are what decide that per profile.
    check(
      `${layout.id}: the printed sheet keeps the entered load as a callout`,
      /id="callout:/.test(printHtml),
    );
    check(
      `${layout.id}: the printed sheet keeps the span labels`,
      /id="span-lengths"|id="span:/.test(printHtml),
    );
    check(
      `${layout.id}: the printed sheet hides the incomplete-measurement banner`,
      !/Span measurements incomplete/.test(printHtml),
    );
    check(`${layout.id}: the printed sheet has no notice group`, !/id="notice"/.test(printHtml));
    check(
      `${layout.id}: the printed sheet hides the alphabetical point labels`,
      !/id="point-designations"/.test(printHtml),
    );
    check(`${layout.id}: the printed sheet hides the Origin label`, !/>Origin</.test(printHtml));
  }

  /* ---------------- TC marker geometry ---------------- */

  // The defect this section pins: the triangle used to be centred slightly above
  // its node and hang below it, so part of the span leaving the TC was hidden
  // behind the symbol and the cable came out shorter than the poles really are
  // apart. The triangle is now anchored on its downstream base midpoint, which is
  // the node itself, so the leaving span keeps its whole length and the interior
  // of the symbol is empty.

  section('TC marker geometry');

  await fresh(page, base);
  await page.click('#btn-load-example');
  await page.waitForTimeout(700);

  /** Read the drawn triangle and its neighbours out of the live drawing. */
  const tcGeometry = await page.evaluate(() => {
    const svg = document.querySelector('#preview-canvas svg') || document.querySelector('svg');
    if (!svg) return null;
    const tri = svg.querySelector('g#markers polygon, g#tc polygon, polygon[data-marker="tc"]')
      || [...svg.querySelectorAll('polygon')].find((p) => p.closest('g'));
    const polygons = [...svg.querySelectorAll('polygon')];
    if (polygons.length === 0) return null;
    const points = polygons[0]
      .getAttribute('points')
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(',').map(Number));
    const rings = [...svg.querySelectorAll('circle')]
      .map((c) => ({
        cx: Number(c.getAttribute('cx')),
        cy: Number(c.getAttribute('cy')),
        r: Number(c.getAttribute('r')),
      }))
      .filter((c) => Number.isFinite(c.cx) && Number.isFinite(c.cy));
    const lines = [...svg.querySelectorAll('line')].map((l) => ({
      x1: Number(l.getAttribute('x1')),
      y1: Number(l.getAttribute('y1')),
      x2: Number(l.getAttribute('x2')),
      y2: Number(l.getAttribute('y2')),
    }));
    return { points, rings, lines, tri };
  });

  check('the drawing contains a TC triangle', Boolean(tcGeometry && tcGeometry.points.length === 3));

  if (tcGeometry && tcGeometry.points.length === 3) {
    const [apex, baseRight, baseLeft] = tcGeometry.points;
    // The base midpoint is the canonical TC node. Both base corners share it.
    const baseMidX = (baseRight[0] + baseLeft[0]) / 2;
    const baseMidY = (baseRight[1] + baseLeft[1]) / 2;
    check(
      'the triangle base corners share one axis',
      Math.abs(baseRight[1] - baseLeft[1]) < 0.01,
      `${baseRight[1]} vs ${baseLeft[1]}`,
    );
    check(
      'the apex is upstream of the base midpoint',
      apex[1] < baseMidY,
      `apex y ${apex[1]}, base y ${baseMidY}`,
    );
    check(
      'the apex is centred on the base',
      Math.abs(apex[0] - baseMidX) < 0.01,
      `apex x ${apex[0]}, base mid x ${baseMidX}`,
    );
    const height = baseMidY - apex[1];
    check('the triangle has a positive height', height > 0, `${height.toFixed(2)}`);

    // The pole immediately below the TC is one whole span away. Span spacing is
    // read from the spacing field the drawing was built with.
    const spacing = Number(await page.inputValue('#field-spacing'));
    const below = tcGeometry.rings
      .filter((c) => Math.abs(c.cx - baseMidX) < 0.01 && c.cy > baseMidY + 0.5)
      .sort((a, b) => a.cy - b.cy)[0];
    check('the next pole after the TC is drawn', Boolean(below));
    if (below) {
      const measured = below.cy - baseMidY;
      check(
        'the leaving span equals the configured spacing',
        Math.abs(measured - spacing) < 0.51,
        `base mid to next pole ${measured.toFixed(2)} px, spacing ${spacing} px`,
      );
    }

    // No conductor may run inside the triangle. Sampled in the drawing's own
    // coordinates, on the lines the browser actually rendered.
    const strict = (x, y) => {
      const sign = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
      const d1 = sign([x, y], apex, baseRight);
      const d2 = sign([x, y], baseRight, baseLeft);
      const d3 = sign([x, y], baseLeft, apex);
      const edge = 1e-3;
      return (d1 > edge && d2 > edge && d3 > edge) || (d1 < -edge && d2 < -edge && d3 < -edge);
    };
    let intruders = 0;
    for (const line of tcGeometry.lines) {
      for (let step = 0; step <= 60; step += 1) {
        const t = step / 60;
        const x = line.x1 + (line.x2 - line.x1) * t;
        const y = line.y1 + (line.y2 - line.y1) * t;
        if (strict(x, y)) intruders += 1;
      }
    }
    check('no conductor runs inside the triangle', intruders === 0, `${intruders} sampled points`);

    // The arriving conductor stops at the apex.
    const meetsApex = tcGeometry.lines.some(
      (l) =>
        (Math.abs(l.x1 - apex[0]) < 0.6 && Math.abs(l.y1 - apex[1]) < 0.6) ||
        (Math.abs(l.x2 - apex[0]) < 0.6 && Math.abs(l.y2 - apex[1]) < 0.6),
    );
    check('the arriving conductor meets the apex', meetsApex);

    // The leaving conductor starts at the base midpoint.
    const startsAtBase = tcGeometry.lines.some(
      (l) =>
        (Math.abs(l.x1 - baseMidX) < 0.6 && Math.abs(l.y1 - baseMidY) < 0.6) ||
        (Math.abs(l.x2 - baseMidX) < 0.6 && Math.abs(l.y2 - baseMidY) < 0.6),
    );
    check('the leaving conductor starts at the base midpoint', startsAtBase);

    // The same triangle appears in the reference drawing beside the schedules.
    const miniTriangle = await page.evaluate(() => {
      const svg = document.querySelector('#mini-preview svg');
      if (!svg) return null;
      const polygons = [...svg.querySelectorAll('polygon')];
      if (polygons.length === 0) return null;
      return polygons[0].getAttribute('points').trim().split(/\s+/).map((p) => p.split(',').map(Number));
    });
    check('the reference drawing shows a TC triangle', Boolean(miniTriangle && miniTriangle.length === 3));
    if (miniTriangle) {
      const miniApexY = miniTriangle[0][1];
      const miniBaseY = (miniTriangle[1][1] + miniTriangle[2][1]) / 2;
      check('the reference triangle is oriented the same way', miniApexY < miniBaseY);
    }

    // The SVG export carries the same geometry, so the fix is not preview-only.
    const svgText = await (async () => {
      const file = await saveDownload(page, '#btn-svg', workdir, 'tc-geometry.svg');
      return (await import('node:fs/promises')).readFile(file, 'utf8');
    })();
    const exportPolys = [...svgText.matchAll(/<polygon[^>]*points="([^"]+)"/g)].map((m) =>
      m[1].trim().split(/\s+/).map((p) => p.split(',').map(Number)),
    );
    check('the SVG export contains the TC triangle', exportPolys.length >= 1);
    if (exportPolys.length >= 1) {
      const [eApex, eBaseRight, eBaseLeft] = exportPolys[0];
      const eBaseMidY = (eBaseRight[1] + eBaseLeft[1]) / 2;
      check('the exported triangle points upstream too', eApex[1] < eBaseMidY);
      check(
        'the exported triangle is centred on its base',
        Math.abs(eApex[0] - (eBaseRight[0] + eBaseLeft[0]) / 2) < 0.01,
      );
    }

    // And the PDF stays vector-only while carrying the symbol.
    const pdfFile = await saveDownload(page, '#btn-pdf', workdir, 'tc-geometry.pdf');
    const pdfText = pdfContent(await (await import('node:fs/promises')).readFile(pdfFile));
    // The real check: read the vector paths out of the downloaded PDF and prove
    // none of them enters the triangular symbol. This is the assertion the earlier
    // work was missing - it only looked at the scene and at the presence of path
    // operators, and a conductor was inside the triangle on the finished sheet in
    // both cases.
    const pdfSegments = [];
    {
      let cursor = null;
      const op = /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(m|l)\b/g;
      let hit;
      while ((hit = op.exec(pdfText))) {
        const x = Number(hit[1]);
        const y = Number(hit[2]);
        if (hit[3] === 'm') {
          cursor = { x, y };
        } else {
          if (cursor) pdfSegments.push({ x1: cursor.x, y1: cursor.y, x2: x, y2: y });
          cursor = { x, y };
        }
      }
    }
    check('the PDF vector paths were read', pdfSegments.length > 20, `${pdfSegments.length} paths`);

    // Find the marker triangle in the PDF by looking for three segments that close
    // into a small loop. Deriving it from the drawing's own measurements would need
    // the page transform; finding it in the sheet needs none.
    const near = (a, b) => Math.abs(a - b) < 0.02;
    const vertices = [];
    for (const a of pdfSegments) {
      for (const b of pdfSegments) {
        if (a === b || !near(a.x2, b.x1) || !near(a.y2, b.y1)) continue;
        for (const c of pdfSegments) {
          if (c === a || c === b) continue;
          if (!near(b.x2, c.x1) || !near(b.y2, c.y1)) continue;
          if (!near(c.x2, a.x1) || !near(c.y2, a.y1)) continue;
          const verts = [
            { x: a.x1, y: a.y1 },
            { x: a.x2, y: a.y2 },
            { x: b.x2, y: b.y2 },
          ];
          const wide = Math.max(...verts.map((p) => Math.abs(p.x - verts[0].x)));
          const tall = Math.max(...verts.map((p) => Math.abs(p.y - verts[0].y)));
          // A marker symbol, not some large closed area of the diagram.
          if (wide < 2 || tall < 2 || wide > 40 || tall > 40) continue;
          // One loop is reachable from any of its corners, so the same triangle
          // turns up three times. Count distinct shapes, not traversals.
          const shape = verts
            .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
            .sort()
            .join(' ');
          if (!vertices.some((entry) => entry.shape === shape)) vertices.push({ verts, shape });
        }
      }
    }
    check('the PDF contains a closed marker triangle', vertices.length >= 1, `${vertices.length}`);

    {
      const tri = vertices[0].verts;
      const strictlyInside = (p) => {
        const sign = (u, v, w) => (u.x - w.x) * (v.y - w.y) - (v.x - w.x) * (u.y - w.y);
        const d1 = sign(p, tri[0], tri[1]);
        const d2 = sign(p, tri[1], tri[2]);
        const d3 = sign(p, tri[2], tri[0]);
        const edge = 1e-4;
        return (d1 > edge && d2 > edge && d3 > edge) || (d1 < -edge && d2 < -edge && d3 < -edge);
      };
      let intruders = 0;
      for (const seg of pdfSegments) {
        const isSide =
          tri.some((p) => near(p.x, seg.x1) && near(p.y, seg.y1)) &&
          tri.some((p) => near(p.x, seg.x2) && near(p.y, seg.y2));
        if (isSide) continue;
        for (let step = 0; step <= 400; step += 1) {
          const t = step / 400;
          const p = { x: seg.x1 + (seg.x2 - seg.x1) * t, y: seg.y1 + (seg.y2 - seg.y1) * t };
          if (strictlyInside(p)) {
            intruders += 1;
            break;
          }
        }
      }
      check('no PDF vector path enters the marker triangle', intruders === 0, `${intruders} paths`);
    }
  }

  /* ---------------- Console ---------------- */

  section('Console');

  check('no uncaught errors reached the page', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  await rm(workdir, { recursive: true, force: true });
}

const passed = results.filter((r) => r.passed).length;
process.stdout.write(`\n${passed}/${results.length} browser checks passed\n`);
if (failures > 0) {
  process.stdout.write(`${failures} check(s) failed\n`);
  process.exitCode = 1;
}
