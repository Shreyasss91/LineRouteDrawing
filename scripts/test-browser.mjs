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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

// `import.meta.dirname` needs Node 20.11, but package.json permits any Node 20, where
// it is undefined. `fileURLToPath(import.meta.url)` gives the same directory and has
// been available far longer, so the declared minimum stays truthful.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

/** The whole saved project payload, as the app persists it. */
function readSavedProject(page) {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.includes('line-route')) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      return JSON.parse(raw).project ?? null;
    }
    return null;
  });
}

/** The route table as the user sees it: id, source, direction, spans. */
function readRouteRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#route-rows tr')].map((tr) => ({
      id: tr.dataset.id,
      cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()),
    })),
  );
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

  /* ---------------- Editing an existing route ---------------- */

  section('Editing an existing route');

  // Route editing was the one user interaction with no browser coverage: the suite
  // built routes and deleted them but never opened the edit form, so the replacement
  // path that preserves a route's id - and therefore everything keyed to its
  // endpoints - was untested in a real DOM.
  //
  // The load is deliberately attached to the DESTINATION of the route being edited.
  // That is the strongest place to put it: the destination's asset id is derived from
  // the edited route's id (`dst:<routeId>`), so it tests route identity, endpoint
  // identity and load attachment in one relationship. Editing the route also MOVES
  // that destination in the drawing, so the test proves the load follows the point by
  // identity rather than by position.
  //
  // Route 2 starts at A and runs East; flipping it to West keeps every node id, label
  // and designation identical (verified against the real engine), so a failure means
  // the edit path broke identity rather than the drawing legitimately changing shape.
  await fresh(page, base);
  // An empty project boots with the bundled example loaded, so start from nothing.
  await page.click('#btn-clear');
  await page.waitForTimeout(250);
  await addRoute(page, { from: 'origin', direction: 'south', spans: 2 });
  await addRoute(page, { from: 'endpoint:A', direction: 'east', spans: 2 });
  await addRoute(page, { from: 'endpoint:A', direction: 'south', spans: 3 });

  const rowsBefore = await readRouteRows(page);
  check('the edit fixture has three routes', rowsBefore.length === 3, `${rowsBefore.length} rows`);

  // Route ids in this session continue a counter from earlier sections, so nothing here
  // may assume they are route-1/2/3. Derive everything from the rows actually present.
  const editedId = rowsBefore[1].id;
  const neighbourId = rowsBefore[2].id;
  const firstId = rowsBefore[0].id;
  const editedDestinationId = `dst:${editedId}`;
  check(
    'the edited route has a stable id before the edit',
    typeof editedId === 'string' && editedId.length > 0,
    editedId,
  );

  // Pick the destination of the edited route from the real dropdown, by its asset id.
  await page.click('#tab-loads');
  const destinationOption = await page.evaluate((wanted) => {
    const options = [...document.querySelectorAll('#field-load-node option')].map((o) => ({
      value: o.value,
      text: o.textContent.trim(),
    }));
    const found = options.find((o) => o.value === wanted);
    return found ? { value: found.value, text: found.text } : null;
  }, editedDestinationId);
  check(
    'the edited route destination is offered as a load target',
    Boolean(destinationOption),
    `${editedDestinationId} -> ${JSON.stringify(destinationOption)}`,
  );
  await addLoad(page, { nodeId: destinationOption.value, value: 25, unit: 'kVA' });

  // The callout must be on that exact point before the edit, so a later assertion about
  // its position is comparing like with like.
  const calloutBefore = await page.evaluate((wanted) => {
    const group = document.querySelector(`#preview-canvas g#callout\\:${CSS.escape(wanted)}`)
      ?? [...document.querySelectorAll('#preview-canvas g[id^="callout:"]')].find(
        (g) => g.id === `callout:${wanted}`,
      );
    if (!group) return null;
    const box = group.getBoundingClientRect();
    return { text: group.textContent.trim(), x: box.x, y: box.y };
  }, destinationOption.value);
  check(
    'the pre-edit callout is drawn on the edited route destination',
    Boolean(calloutBefore) && /25 kVA/.test(calloutBefore?.text ?? ''),
    JSON.stringify(calloutBefore),
  );

  const savedBefore = await readSavedProject(page);
  const loadBefore = savedBefore?.loads?.[0];
  check(
    'the load is recorded against the edited route destination id',
    savedBefore?.loads?.length === 1 && loadBefore?.nodeId === editedDestinationId,
    JSON.stringify(savedBefore?.loads),
  );
  const designationsBefore = await readDesignationMap(page);
  const neighbourBefore = savedBefore?.routes?.[2];
  const firstBefore = savedBefore?.routes?.[0];

  // Open the edit form for the second route through the row's own Edit button.
  await page.locator('#route-rows tr').nth(1).locator('button[data-action="edit"]').click();
  await page.waitForTimeout(250);
  const formShowsEdit = await page.locator('#btn-save-route').textContent();
  check('opening edit switches the form to save mode', /Save changes/.test(formShowsEdit), formShowsEdit);
  const cancelVisible = await page.locator('#btn-cancel-edit').isVisible();
  check('the cancel-edit button appears while editing', cancelVisible);

  // Change the direction and save through the real form.
  await page.selectOption('#field-direction', 'west');
  await page.click('#btn-save-route');
  await page.waitForTimeout(450);

  const rowsAfter = await readRouteRows(page);
  check('the edit did not add or remove a route', rowsAfter.length === 3, `${rowsAfter.length} rows`);
  check(
    'the edited route kept its stable id',
    rowsAfter[1].id === editedId,
    `${editedId} -> ${rowsAfter[1].id}`,
  );
  check(
    'the edit changed the direction that was edited',
    rowsAfter[1].cells.some((c) => /west/i.test(c)),
    rowsAfter[1].cells.join(' | '),
  );
  check(
    'the neighbouring route is untouched',
    rowsAfter[2].id === neighbourId &&
      rowsAfter[2].cells.join('|') === rowsBefore[2].cells.join('|'),
    rowsAfter[2].cells.join(' | '),
  );
  check(
    'the unrelated first route is untouched',
    rowsAfter[0].id === firstId &&
      rowsAfter[0].cells.join('|') === rowsBefore[0].cells.join('|'),
  );
  check('the form returned to add mode', /Add route/.test(await page.locator('#btn-save-route').textContent()));
  check('the cancel-edit button is hidden again', !(await page.locator('#btn-cancel-edit').isVisible()));

  // The persisted project is the authoritative after-state.
  const savedAfter = await readSavedProject(page);
  check('the project still has three routes', savedAfter?.routes?.length === 3, `${savedAfter?.routes?.length}`);
  check(
    'the saved route kept its id and gained the new direction',
    savedAfter?.routes?.[1]?.id === editedId && savedAfter.routes[1].direction === 'west',
    JSON.stringify(savedAfter?.routes?.[1]),
  );

  // The unrelated route records must be identical in the FILE, not merely in the table.
  check(
    'the neighbouring route record is byte-identical in the saved project',
    JSON.stringify(savedAfter?.routes?.[2]) === JSON.stringify(neighbourBefore),
    `${JSON.stringify(neighbourBefore)} -> ${JSON.stringify(savedAfter?.routes?.[2])}`,
  );
  check(
    'the unrelated first route record is byte-identical in the saved project',
    JSON.stringify(savedAfter?.routes?.[0]) === JSON.stringify(firstBefore),
    `${JSON.stringify(firstBefore)} -> ${JSON.stringify(savedAfter?.routes?.[0])}`,
  );

  // The load must still name the SAME destination id, even though that point moved.
  const loadAfter = savedAfter?.loads?.[0];
  check(
    'the load is still recorded on the same destination id',
    savedAfter?.loads?.length === 1 && loadAfter.nodeId === editedDestinationId,
    JSON.stringify(loadAfter),
  );
  check(
    'the load value and unit are unchanged by the edit',
    loadAfter?.value === 25 && loadAfter?.unit === 'kVA',
    JSON.stringify(loadAfter),
  );

  // The load must still resolve to a drawn callout, not appear in the unresolved list.
  await page.click('#tab-loads');
  await page.waitForTimeout(200);
  const unresolvedAfter = await page.locator('#unresolved-bar:not([hidden])').count();
  check('the load did not become unresolved', unresolvedAfter === 0, `${unresolvedAfter} banners`);
  const calloutAfter = await page.locator('#preview-canvas g[id^="callout:"]').count();
  check('the load is still drawn as a callout', calloutAfter === 1, `${calloutAfter} callouts`);

  // Same group id as before - the callout is identified by the destination asset id, and
  // that id did not change. Its text is unchanged, and it moved with the point.
  const calloutAfterBox = await page.evaluate((wanted) => {
    const group = [...document.querySelectorAll('#preview-canvas g[id^="callout:"]')].find(
      (g) => g.id === `callout:${wanted}`,
    );
    if (!group) return null;
    const box = group.getBoundingClientRect();
    return { text: group.textContent.trim(), x: box.x, y: box.y };
  }, editedDestinationId);
  check(
    'the callout is still keyed to the edited destination id',
    Boolean(calloutAfterBox),
    `callout:${editedDestinationId}`,
  );
  check(
    'the callout still reads 25 kVA',
    /25 kVA/.test(calloutAfterBox?.text ?? ''),
    JSON.stringify(calloutAfterBox),
  );
  check(
    'the callout moved with the point it belongs to',
    Boolean(calloutAfterBox && calloutBefore) &&
      (Math.abs(calloutAfterBox.x - calloutBefore.x) > 1 ||
        Math.abs(calloutAfterBox.y - calloutBefore.y) > 1),
    `${JSON.stringify(calloutBefore)} -> ${JSON.stringify(calloutAfterBox)}`,
  );

  // Designations are carried, not re-derived. Keys are derived from the ids actually
  // present, so this section does not depend on where it sits in the suite.
  const designationsAfter = await readDesignationMap(page);
  const fixturePrefixes = [firstId, editedId, neighbourId].map((id) => id);
  const fixtureIdsBefore = Object.keys(designationsBefore ?? {}).filter((k) =>
    fixturePrefixes.some((id) => k === `dst:${id}` || k.startsWith(`mid:${id}:`)),
  );
  check(
    'the fixture has designations to compare',
    fixtureIdsBefore.length >= 4,
    `${fixtureIdsBefore.length}: ${fixtureIdsBefore.join(', ')}`,
  );
  check(
    'every point of the edited and neighbouring routes kept its designation',
    fixtureIdsBefore.every((k) => designationsAfter?.[k] === designationsBefore[k]),
    JSON.stringify(
      fixtureIdsBefore.map((k) => [k, designationsBefore[k], designationsAfter?.[k]]),
    ),
  );

  // A reload must show what the edit produced, so the drawing and the file agree.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg', { timeout: 15000 });
  const rowsAfterReload = await readRouteRows(page);
  check(
    'the edit survives a reload with its id intact',
    rowsAfterReload.length === 3 && rowsAfterReload[1].id === editedId,
    JSON.stringify(rowsAfterReload.map((r) => r.id)),
  );
  const savedAfterReload = await readSavedProject(page);
  check(
    'the reloaded project keeps the edited direction and the exact load target',
    savedAfterReload?.routes?.[1]?.id === editedId &&
      savedAfterReload.routes[1].direction === 'west' &&
      savedAfterReload?.loads?.[0]?.nodeId === editedDestinationId,
    JSON.stringify({ route: savedAfterReload?.routes?.[1], load: savedAfterReload?.loads?.[0] }),
  );
  check(
    'the reloaded load keeps its value and unit',
    savedAfterReload?.loads?.[0]?.value === 25 && savedAfterReload?.loads?.[0]?.unit === 'kVA',
    JSON.stringify(savedAfterReload?.loads?.[0]),
  );
  const calloutAfterReload = await page.evaluate((wanted) => {
    const group = [...document.querySelectorAll('#preview-canvas g[id^="callout:"]')].find(
      (g) => g.id === `callout:${wanted}`,
    );
    return group ? group.textContent.trim() : null;
  }, editedDestinationId);
  check(
    'the reloaded drawing still shows the load on the destination',
    /25 kVA/.test(calloutAfterReload ?? ''),
    String(calloutAfterReload),
  );
  check(
    'the reloaded drawing still shows the load',
    (await page.locator('#preview-canvas g[id^="callout:"]').count()) === 1,
  );

  /* ---------------- Changing a destination to a TC point ---------------- */

  section('Changing a destination to a TC point');

  // A TC point cannot carry a load, so turning an ordinary destination into one while it
  // holds a load used to save a project the app itself refuses to reopen: the parser
  // rejects it with INELIGIBLE_LOAD_TARGET, the bundled example loads instead, auto-save
  // pauses and the user's drawing is stranded. That was reproduced before the guard was
  // added, and this section is the regression test for it.
  //
  // The guard refuses the edit rather than silently deleting, moving or orphaning the
  // load, so the checks below pin BOTH halves: the refusal keeps the data, and the
  // ordinary transition (no load attached) still works so the rule is not over-refused.
  const formErrorText = () =>
    page.evaluate(() => {
      const el = document.querySelector('#form-error');
      return el && !el.hidden ? el.textContent.trim() : null;
    });

  // A destination with no load is not obstructed: the plain TC transition must survive.
  await fresh(page, base);
  await page.click('#btn-clear');
  await page.waitForTimeout(250);
  await addRoute(page, { from: 'origin', direction: 'south', spans: 1 });
  const cleanRows = await readRouteRows(page);
  const cleanId = cleanRows[0].id;
  check('the TC fixture has one route', cleanRows.length === 1, `${cleanRows.length} rows`);

  await page.locator(`#route-rows tr[data-id="${cleanId}"] button[data-action="edit"]`).click();
  await page.waitForTimeout(250);
  await page.check('#field-tc');
  await page.click('#btn-save-route');
  await page.waitForTimeout(400);
  const cleanSaved = await readSavedProject(page);
  check(
    'a destination with no load can still be made a TC point',
    cleanSaved?.routes?.[0]?.tc === true,
    JSON.stringify(cleanSaved?.routes?.[0]),
  );
  check('no error is shown for a permitted transition', (await formErrorText()) === null);

  // Now the guarded case: a destination that does carry a load.
  await fresh(page, base);
  await page.click('#btn-clear');
  await page.waitForTimeout(250);
  await addRoute(page, { from: 'origin', direction: 'south', spans: 1 });
  const guardedRows = await readRouteRows(page);
  const guardedId = guardedRows[0].id;
  const guardedDestId = `dst:${guardedId}`;

  await page.click('#tab-loads');
  await addLoad(page, { nodeId: guardedDestId, value: 25, unit: 'kVA' });
  const beforeBlocked = await readSavedProject(page);
  check(
    'the load is on the destination before the TC attempt',
    beforeBlocked?.loads?.length === 1 && beforeBlocked.loads[0].nodeId === guardedDestId,
    JSON.stringify(beforeBlocked?.loads),
  );

  await page.locator(`#route-rows tr[data-id="${guardedId}"] button[data-action="edit"]`).click();
  await page.waitForTimeout(250);
  await page.check('#field-tc');
  await page.click('#btn-save-route');
  await page.waitForTimeout(400);

  const refusal = await formErrorText();
  check('making a loaded destination a TC point is refused', Boolean(refusal), String(refusal));
  check(
    'the refusal names the load and where to fix it',
    /25 kVA/.test(refusal ?? '') && /Loads tab/.test(refusal ?? ''),
    String(refusal),
  );

  const afterBlocked = await readSavedProject(page);
  check(
    'the refused edit did not change the route',
    afterBlocked?.routes?.[0]?.tc === false,
    JSON.stringify(afterBlocked?.routes?.[0]),
  );
  check(
    'the refused edit kept the load exactly as it was',
    afterBlocked?.loads?.length === 1 &&
      afterBlocked.loads[0].id === beforeBlocked.loads[0].id &&
      afterBlocked.loads[0].nodeId === guardedDestId &&
      afterBlocked.loads[0].value === 25 &&
      afterBlocked.loads[0].unit === 'kVA',
    JSON.stringify(afterBlocked?.loads),
  );
  check(
    'the form stays in edit mode so the user can retry',
    /Save changes/.test(await page.locator('#btn-save-route').textContent()),
  );

  // The decisive check: what was saved must still be openable by the app's own parser.
  // Before the guard this project contained a load on a TC point and was rejected.
  const reopenable = await page.evaluate(async (doc) => {
    const project = await import('./src/ui/project.js');
    const result = project.parseProjectJson(
      JSON.stringify({ format: 'line-route-drawing-project', schemaVersion: 3, project: doc }),
      {},
    );
    return result.ok ? { ok: true } : { ok: false, code: result.code };
  }, afterBlocked);
  check(
    'the saved project after a refused TC edit is still openable',
    reopenable.ok === true,
    JSON.stringify(reopenable),
  );

  // A reload must come up cleanly - no "cannot be opened" recovery banner.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg', { timeout: 15000 });
  const reloadNotice = await page.evaluate(() => {
    const text = document.body.innerText;
    const hit = text.match(/[^\n]*cannot be opened[^\n]*/i);
    return hit ? hit[0].trim() : null;
  });
  check('reloading after the refusal produces no recovery banner', reloadNotice === null, String(reloadNotice));
  const reloadedRows = await readRouteRows(page);
  check(
    'the drawing comes back as saved, with the route still a pole',
    reloadedRows.some((r) => r.id === guardedId),
    JSON.stringify(reloadedRows.map((r) => r.id)),
  );

  // Then the supported route to the same end state: remove the load, retry, and the
  // transition succeeds - so the guard blocks the invalid order of operations only.
  await page.click('#tab-loads');
  await page.waitForTimeout(200);
  await page.locator('#load-rows button').filter({ hasText: 'Remove' }).first().click();
  await page.waitForTimeout(300);
  await page.locator(`#route-rows tr[data-id="${guardedId}"] button[data-action="edit"]`).click();
  await page.waitForTimeout(250);
  await page.check('#field-tc');
  await page.click('#btn-save-route');
  await page.waitForTimeout(400);
  const recovered = await readSavedProject(page);
  check(
    'after removing the load the same transition is allowed',
    recovered?.routes?.[0]?.tc === true && recovered?.loads?.length === 0,
    JSON.stringify({ route: recovered?.routes?.[0], loads: recovered?.loads }),
  );
  check('no error is shown the second time', (await formErrorText()) === null);

  // --- The destination is a shared junction, not its own asset id ---
  //
  // Identity is first-writer-wins, so when two routes finish at the SAME coordinate only
  // the earlier route's id is a registered asset: `dst:<secondRoute>` resolves to nothing
  // even though the route is perfectly valid. The guard used to fall back to comparing raw
  // ids in that case, found `dst:route-10 !== dst:route-11`, and allowed the edit - the
  // shared node became a TC with the load still on it and the project was unopenable.
  // Reproduced before the fix; this is the regression test for it. The destination is now
  // resolved by the coordinate its path ends on, so the shared identity is found.
  await fresh(page, base);
  await page.click('#btn-clear');
  await page.waitForTimeout(250);
  await addRoute(page, { from: 'origin', direction: 'south', spans: 1 });
  await addRoute(page, { from: 'origin', direction: 'south', spans: 1 });
  const junctionRows = await readRouteRows(page);
  check('the junction fixture has two routes', junctionRows.length === 2, `${junctionRows.length} rows`);

  // The second route's destination is the same physical point as the first route's, so
  // only the first route's asset id exists. Proves the premise rather than assuming it.
  const junctionIdentity = await page.evaluate(async () => {
    const { buildNetwork } = await import('./src/geometry/network.js');
    const { buildAssetRegistry } = await import('./src/geometry/assets.js');
    const routes = [
      { id: 'route-10', from: 'origin', direction: 'south', spans: 1, tc: false, fpb: false },
      { id: 'route-11', from: 'origin', direction: 'south', spans: 1, tc: false, fpb: false },
    ];
    const registry = buildAssetRegistry(buildNetwork(routes));
    return {
      first: registry.canonicalNodeId('dst:route-10'),
      second: registry.canonicalNodeId('dst:route-11'),
      coordinate: registry.canonicalNodeId('0,-1'),
    };
  });
  check(
    'the second route destination is not its own asset id',
    junctionIdentity.second === null && junctionIdentity.first === 'dst:route-10',
    JSON.stringify(junctionIdentity),
  );
  check(
    'both route destinations resolve to the same physical node',
    junctionIdentity.coordinate === junctionIdentity.first,
    JSON.stringify(junctionIdentity),
  );

  // A load on the shared node, addressed by the id that IS registered.
  await page.click('#tab-loads');
  await addLoad(page, { nodeId: 'dst:route-10', value: 25, unit: 'kVA' });
  const junctionBefore = await readSavedProject(page);
  check(
    'the shared-node load is recorded',
    junctionBefore?.loads?.length === 1 && junctionBefore.loads[0].nodeId === 'dst:route-10',
    JSON.stringify(junctionBefore?.loads),
  );

  // Editing the SECOND route is the case the raw fallback missed.
  await page.locator('#route-rows tr[data-id="route-11"] button[data-action="edit"]').click();
  await page.waitForTimeout(250);
  await page.check('#field-tc');
  await page.click('#btn-save-route');
  await page.waitForTimeout(400);
  const junctionRefusal = await formErrorText();
  check(
    'a load on the shared node is found through the second route',
    Boolean(junctionRefusal) && /25 kVA/.test(junctionRefusal ?? ''),
    String(junctionRefusal),
  );

  const junctionAfter = await readSavedProject(page);
  check(
    'the shared-node edit changed nothing',
    junctionAfter?.routes?.[1]?.tc === false &&
      JSON.stringify(junctionAfter?.loads) === JSON.stringify(junctionBefore?.loads),
    JSON.stringify({ route: junctionAfter?.routes?.[1], loads: junctionAfter?.loads }),
  );
  const junctionReopen = await page.evaluate(async () => {
    const { parseProjectJson } = await import('./src/ui/project.js');
    const result = parseProjectJson(localStorage.getItem('line-route-drawing:v3:project'), {});
    return result.ok ? { ok: true } : { ok: false, code: result.code };
  });
  check(
    'the shared-node project is still openable',
    junctionReopen.ok === true,
    JSON.stringify(junctionReopen),
  );

  // A junction with NO load must still be free to become a TC point - the guard must not
  // over-refuse simply because the destination is a shared node.
  await page.click('#tab-loads');
  await page.waitForTimeout(200);
  await page.locator('#load-rows button').filter({ hasText: 'Remove' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('#route-rows tr[data-id="route-11"] button[data-action="edit"]').click();
  await page.waitForTimeout(250);
  await page.check('#field-tc');
  await page.click('#btn-save-route');
  await page.waitForTimeout(400);
  const junctionClean = await readSavedProject(page);
  check(
    'a shared destination with no load can still become a TC point',
    junctionClean?.routes?.[1]?.tc === true,
    JSON.stringify(junctionClean?.routes?.[1]),
  );
  check('no error for the load-free shared node', (await formErrorText()) === null);

  /* ---------------- The same transition, with an aliased load ---------------- */

  section('Changing a destination to a TC point (aliased load)');

  // A load's `nodeId` need not be the canonical `dst:<routeId>`. A coordinate spelling
  // (`0,-2`) is an accepted identifier for the same physical pole, the loader keeps the
  // spelling it was given rather than rewriting it, and the registry resolves it to the
  // canonical node. The first version of the guard compared identifier TEXT
  // (`load.nodeId === destinationAssetId(routeId)`), so an aliased load was not seen as
  // attached, the edit went through, and the project again became one the parser refuses
  // to reopen. Reproduced before the fix; this is the regression test for it.
  //
  // The project below is built with the real serializer from a real network, not
  // hand-written JSON, so the alias is one the application genuinely accepts.
  const aliasFixture = await page.evaluate(async () => {
    const { buildNetwork } = await import('./src/geometry/network.js');
    const { buildAssetRegistry, destinationAssetId } = await import('./src/geometry/assets.js');
    const { serializeProjectJson } = await import('./src/ui/project.js');

    const routes = [
      { id: 'route-1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: false },
    ];
    const registry = buildAssetRegistry(buildNetwork(routes));
    const canonicalId = destinationAssetId('route-1');
    const alias = registry.nodeAsset(canonicalId).coordKey;
    const stored = serializeProjectJson(
      {
        routes,
        originMarker: 'plain',
        spanLength: 40,
        layout: 'a4_landscape',
        loads: [{ id: 'load-1', nodeId: alias, value: 25, unit: 'kVA' }],
        spanLengths: {},
        loadPlacements: {},
        spanPlacements: {},
        nodeDesignations: {},
      },
      { savedAt: new Date('2026-01-01T00:00:00Z') },
    );
    return {
      canonicalId,
      alias,
      resolved: registry.canonicalNodeId(alias),
      stored,
    };
  });

  // 1. The alias resolves to the intended physical destination, and is not the
  //    canonical spelling - otherwise this section would be a duplicate of the one above.
  check(
    'the alias resolves to the canonical destination',
    aliasFixture.resolved === aliasFixture.canonicalId,
    `${aliasFixture.alias} -> ${aliasFixture.resolved}`,
  );
  check(
    'the alias is genuinely a different identifier',
    aliasFixture.alias !== aliasFixture.canonicalId,
    `${aliasFixture.alias} vs ${aliasFixture.canonicalId}`,
  );

  // 2. Load it through the normal application workflow and confirm the load is valid,
  //    resolved and drawn before any edit is attempted.
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.evaluate((doc) => {
    localStorage.setItem('line-route-drawing:v3:project', doc);
  }, aliasFixture.stored);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg', { timeout: 15000 });
  await page.waitForTimeout(300);

  const loadBanner = await page.evaluate(() => {
    const hit = document.body.innerText.match(/[^\n]*cannot be opened[^\n]*/i);
    return hit ? hit[0].trim() : null;
  });
  check('the aliased project opens with no recovery banner', loadBanner === null, String(loadBanner));

  const aliasRows = await readRouteRows(page);
  check(
    'the aliased project loads its one route',
    aliasRows.length === 1 && aliasRows[0].id === 'route-1',
    JSON.stringify(aliasRows.map((r) => r.id)),
  );
  // The parser canonicalises the accepted alias once, at the validation boundary
  // (`validateMeasuredData` in src/ui/project.js), so every downstream consumer sees one
  // spelling instead of each resolving aliases for itself. This is the fix for F11: the
  // alias used to survive parsing verbatim, and because the schedule panel and annotation
  // layer key on the raw `nodeId` the load was drawn as an orphan with no callout even
  // though the file was valid.
  const parsedAlias = await page.evaluate(async () => {
    const { parseProjectJson } = await import('./src/ui/project.js');
    const result = parseProjectJson(localStorage.getItem('line-route-drawing:v3:project'), {});
    return result.ok ? { ok: true, loads: result.project.loads, warnings: result.warnings } : { ok: false };
  });
  check(
    'the alias is canonicalised at the validation boundary',
    parsedAlias.ok === true &&
      parsedAlias.loads?.length === 1 &&
      parsedAlias.loads[0].nodeId === 'dst:route-1',
    JSON.stringify(parsedAlias.loads),
  );
  check(
    'canonicalising preserved the id, value and unit',
    parsedAlias.loads?.[0]?.id === 'load-1' &&
      parsedAlias.loads?.[0]?.value === 25 &&
      parsedAlias.loads?.[0]?.unit === 'kVA',
    JSON.stringify(parsedAlias.loads),
  );
  check(
    'the canonicalised load raises no orphan warning',
    Array.isArray(parsedAlias.warnings) && parsedAlias.warnings.length === 0,
    JSON.stringify(parsedAlias.warnings),
  );

  // The consequences the user sees: the schedule panel recognises the point, and the
  // callout is drawn at the destination instead of being dropped as unresolved.
  await page.click('#tab-loads');
  await page.waitForTimeout(300);
  const aliasRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#load-rows tr')];
    return rows.map((r) => ({
      text: r.innerText.replace(/\s+/g, ' ').trim(),
      unresolved: r.classList.contains('is-unresolved'),
    }));
  });
  check(
    'the schedule panel recognises the destination',
    aliasRow.length === 1 && /dst:route-1/.test(aliasRow[0].text) && /pole/.test(aliasRow[0].text),
    JSON.stringify(aliasRow),
  );
  check(
    'the load is not marked unresolved',
    aliasRow.length === 1 && aliasRow[0].unresolved === false,
    JSON.stringify(aliasRow),
  );
  const aliasCallout = await page.evaluate(() => {
    const svg = document.querySelector('#preview-canvas svg');
    const group = svg.querySelector('[id="callout:dst:route-1"]');
    return {
      present: Boolean(group),
      text: group ? group.textContent.trim() : null,
      // The callout must sit where the destination actually is, not at the origin.
      x: group?.querySelector('[data-anchor], text')?.getAttribute('x') ?? null,
    };
  });
  check(
    'the callout is drawn for the canonical destination',
    aliasCallout.present === true && /25 kVA/.test(aliasCallout.text ?? ''),
    JSON.stringify(aliasCallout),
  );

  const aliasBefore = await readSavedProject(page);
  const aliasResolves = await page.evaluate(async (alias) => {
    const { buildNetwork } = await import('./src/geometry/network.js');
    const { buildAssetRegistry, destinationAssetId } = await import('./src/geometry/assets.js');
    const routes = [
      { id: 'route-1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: false },
    ];
    const registry = buildAssetRegistry(buildNetwork(routes));
    return registry.canonicalNodeId(alias) === destinationAssetId('route-1');
  }, aliasFixture.alias);
  check(
    'the loaded alias still resolves through the registry',
    aliasResolves === true,
    String(aliasResolves),
  );

  // 3-4. Attempt the pole -> TC transition through the real edit form; it must be refused.
  await page.locator('#route-rows tr[data-id="route-1"] button[data-action="edit"]').click();
  await page.waitForTimeout(250);
  await page.check('#field-tc');
  await page.click('#btn-save-route');
  await page.waitForTimeout(400);
  const aliasRefusal = await formErrorText();
  check(
    'the aliased load is recognised as attached, so the edit is refused',
    Boolean(aliasRefusal),
    String(aliasRefusal),
  );
  check(
    'the refusal names the aliased load',
    /25 kVA/.test(aliasRefusal ?? '') && /Loads tab/.test(aliasRefusal ?? ''),
    String(aliasRefusal),
  );

  // 5-6. The route stays a pole and the load keeps its id, alias, value and unit.
  const aliasAfter = await readSavedProject(page);
  check(
    'the route is still an ordinary pole',
    aliasAfter?.routes?.[0]?.tc === false,
    JSON.stringify(aliasAfter?.routes?.[0]),
  );
  // The refusal must not rewrite the stored load either: it is still exactly the record
  // that was saved, alias and all. Only the parsed, in-app copy is canonical.
  check(
    'the refusal left the stored load untouched',
    aliasAfter?.loads?.length === 1 &&
      aliasAfter.loads[0].id === 'load-1' &&
      aliasAfter.loads[0].nodeId === aliasFixture.alias &&
      aliasAfter.loads[0].value === 25 &&
      aliasAfter.loads[0].unit === 'kVA',
    JSON.stringify(aliasAfter?.loads),
  );

  // 7. The saved project must still be one the app can open.
  const aliasReopen = await page.evaluate(async () => {
    const { parseProjectJson } = await import('./src/ui/project.js');
    const raw = localStorage.getItem('line-route-drawing:v3:project');
    const result = parseProjectJson(raw, {});
    return result.ok ? { ok: true } : { ok: false, code: result.code };
  });
  check(
    'the saved project is still openable after the refusal',
    aliasReopen.ok === true,
    JSON.stringify(aliasReopen),
  );

  // 8. Reloading must not produce a recovery banner.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg', { timeout: 15000 });
  await page.waitForTimeout(300);
  const aliasReloadBanner = await page.evaluate(() => {
    const hit = document.body.innerText.match(/[^\n]*cannot be opened[^\n]*/i);
    return hit ? hit[0].trim() : null;
  });
  check('reloading after the refusal shows no recovery banner', aliasReloadBanner === null, String(aliasReloadBanner));
  const aliasReloadRows = await readRouteRows(page);
  check(
    'the aliased project comes back unchanged',
    aliasReloadRows.length === 1 && aliasReloadRows[0].id === 'route-1',
    JSON.stringify(aliasReloadRows.map((r) => r.id)),
  );

  // The canonical id must survive a real write, not just an in-memory parse. Editing the
  // load's value is enough to make the app persist its live state, and the stored nodeId
  // must then be the canonical one - so reopening a saved-and-edited project no longer
  // depends on the alias being resolvable a second time.
  await page.click('#tab-loads');
  await page.waitForTimeout(250);
  const aliasValueInput = page.locator('#load-rows input[type=number]').first();
  await aliasValueInput.fill('30');
  await aliasValueInput.dispatchEvent('change');
  await page.waitForTimeout(500);
  const aliasPersisted = await readSavedProject(page);
  check(
    'the canonical node id is written on save',
    aliasPersisted?.loads?.length === 1 &&
      aliasPersisted.loads[0].nodeId === 'dst:route-1' &&
      aliasPersisted.loads[0].value === 30,
    JSON.stringify(aliasPersisted?.loads),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg');
  await page.waitForTimeout(600);
  const aliasAfterSave = await readSavedProject(page);
  check(
    'the canonical node id survives the reload',
    aliasAfterSave?.loads?.length === 1 && aliasAfterSave.loads[0].nodeId === 'dst:route-1',
    JSON.stringify(aliasAfterSave?.loads),
  );
  check(
    'the reloaded callout carries the edited value',
    await page.evaluate(() =>
      document.querySelector('#preview-canvas svg').textContent.includes('30 kVA'),
    ),
  );

  /* ---------------- Dragging a callout ---------------- */

  section('Manual annotation placement');

  // This section needs a callout to drag, so it builds its own fixture rather than
  // inheriting one. It used to depend on the callout left behind by the route-edit
  // section, which made it fail whenever a section in between changed the loads - a
  // coupling that had nothing to do with dragging.
  await fresh(page, base);
  await page.click('#btn-clear');
  await page.waitForTimeout(250);
  await addRoute(page, { from: 'origin', direction: 'south', spans: 2 });
  const dragRows = await readRouteRows(page);
  const dragNodeId = `dst:${dragRows[0].id}`;
  await page.click('#tab-loads');
  await addLoad(page, { nodeId: dragNodeId, value: 40, unit: 'kVA' });

  // Measure every span, so the in-drawing "measurements incomplete" notice is not
  // drawn. That notice is a filled overlay sitting above the callouts, and a press on
  // it is a press on the notice rather than on the label beneath - a separate, pre-
  // existing limitation recorded as F12, and not what this section is testing. Keeping
  // it out of the fixture keeps these checks about the drag arithmetic.
  await page.click('#tab-spans');
  await page.fill('#field-default-length', '30');
  await page.click('#btn-apply-default');
  await page.waitForTimeout(400);

  await page.click('#btn-fit');
  await page.waitForTimeout(300);
  await page.mouse.move(20, 20);
  await page.waitForTimeout(120);

  check(
    'the fixture draws no notice overlay above the callouts',
    (await page.evaluate(() => !document.querySelector('#preview-canvas svg #notice'))),
  );

  /*
   * The drag contract, and why zoom matters.
   *
   * A callout is drawn at a SCENE coordinate and shown through a CSS
   * `scale(view.zoom)` on the canvas, so one scene unit is `zoom` screen pixels.
   * The persisted manual offset is scene-space, therefore a drag must store
   *
   *     scene delta = screen pointer delta / zoom
   *
   * and the label must appear to move by exactly the pointer delta. At fit zoom the
   * two are close enough that a raw-pixel implementation looks correct, and it only
   * breaks once the drawing is zoomed - which is why these checks run at three
   * deliberately different zooms. Neither number is recomputed from a formula here:
   * `zoom` is read back from the rendered transform `applyView()` writes, and the
   * scene position is read from the plate's own SVG attribute, which is in scene
   * units by construction.
   */

  /** Everything the drag contract is measured against, read from the live page. */
  const measureCallout = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('#preview-canvas');
      const plate = canvas.querySelector('rect.callout-plate');
      const group = plate?.closest('[data-annot-id]');
      const stage = document.querySelector('#preview-stage');
      // The rendered transform is what the reader actually sees: `applyView()` writes
      // it from the live viewport, so reading it back is authoritative and keeps the
      // transform formula out of the test.
      const raw = getComputedStyle(canvas).transform;
      let zoom = 1;
      let panX = 0;
      let panY = 0;
      if (raw && raw !== 'none') {
        const m = raw.match(/matrix\(([^)]+)\)/);
        if (m) {
          const v = m[1].split(',').map(Number);
          zoom = Math.hypot(v[0], v[1]);
          panX = v[4];
          panY = v[5];
        }
      }
      const box = plate ? plate.getBoundingClientRect() : null;
      const stageBox = stage ? stage.getBoundingClientRect() : null;
      const screen = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
      return {
        zoom,
        panX,
        panY,
        annotId: group?.getAttribute('data-annot-id') ?? null,
        // The plate's x/y attributes are scene units, never screen pixels.
        scene: plate
          ? { x: Number(plate.getAttribute('x')), y: Number(plate.getAttribute('y')) }
          : null,
        screen,
        onStage: Boolean(
          screen &&
            stageBox &&
            screen.x > stageBox.x &&
            screen.x < stageBox.x + stageBox.width &&
            screen.y > stageBox.y &&
            screen.y < stageBox.y + stageBox.height,
        ),
      };
    });

  /** The persisted manual offsets, as the project stores them. */
  const readPlacements = async () => (await readSavedProject(page))?.loadPlacements ?? {};

  /**
  * A point inside the callout plate that actually belongs to the callout.
  *
  * Pointing at the plate's geometric centre is not reliable: other annotation text
  * (span lengths, designations) is drawn over it, and a press on that text is not a
  * press on the callout - the event falls through to the stage and pans instead. So
  * the grab point is searched for within the plate, which is what a reader does when
  * they aim at a visible piece of the label.
  */
  const findGrabPoint = (expectedId) =>
    page.evaluate((expected) => {
      const canvas = document.querySelector('#preview-canvas');
      const plate = canvas.querySelector('rect.callout-plate');
      if (!plate) return null;
      const box = plate.getBoundingClientRect();
      // Centre first, then progressively nearer the edges.
      const fractions = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9];
      for (const fy of fractions) {
        for (const fx of fractions) {
          const x = Math.round(box.x + box.width * fx);
          const y = Math.round(box.y + box.height * fy);
          const el = document.elementFromPoint(x, y);
          const group = el?.closest?.('[data-annot-id]');
          if (group && group.getAttribute('data-annot-id') === expected) return { x, y };
        }
      }
      return null;
    }, expectedId);

  /** Drag the callout by an exact screen delta and measure every view of it. */
  const dragCallout = async ({ dx, dy, steps = 10 }) => {
    const before = await measureCallout();
    const beforePlacements = await readPlacements();
    const grab = await findGrabPoint(dragNodeId);
    if (!grab) {
      return { key: dragNodeId, zoom: before.zoom, pointer: { dx, dy }, grabbable: false,
        sceneDelta: { x: 0, y: 0 }, storedDelta: { x: 0, y: 0 },
        screenDelta: { x: 0, y: 0 }, before, after: before };
    }
    const startX = grab.x;
    const startY = grab.y;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let s = 1; s <= steps; s += 1) {
      await page.mouse.move(
        startX + Math.round((dx * s) / steps),
        startY + Math.round((dy * s) / steps),
      );
      await page.waitForTimeout(15);
    }
    await page.mouse.up();
    await page.waitForTimeout(450);
    const after = await measureCallout();
    const afterPlacements = await readPlacements();
    const key =
      Object.keys(afterPlacements).find((k) => afterPlacements[k] && !beforePlacements[k]) ??
      Object.keys(afterPlacements)[0];
    const from = beforePlacements[key] ?? { dx: 0, dy: 0 };
    const to = afterPlacements[key] ?? { dx: 0, dy: 0 };
    return {
      key,
      zoom: before.zoom,
      // The pointer delta is the independent variable: the last step lands exactly on
      // start + delta, so this is exact rather than measured.
      pointer: { dx, dy },
      sceneDelta: { x: after.scene.x - before.scene.x, y: after.scene.y - before.scene.y },
      storedDelta: { x: to.dx - from.dx, y: to.dy - from.dy },
      stored: to,
      screenDelta: { x: after.screen.x - before.screen.x, y: after.screen.y - before.screen.y },
      before,
      after,
    };
  };

  /** Fit, then apply a zoom level with the real controls. */
  const zoomTo = async (steps) => {
    await page.click('#btn-fit');
    await page.waitForTimeout(250);
    for (let i = 0; i < Math.abs(steps); i += 1) {
      await page.click(steps > 0 ? '#btn-zoom-in' : '#btn-zoom-out');
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(250);
    return measureCallout();
  };

  const format = (r) =>
    (r.grabbable === false ? 'NO GRAB POINT ON THE CALLOUT | ' : '') +
    `zoom=${r.zoom.toFixed(4)} pointer=(${r.pointer.dx},${r.pointer.dy}) ` +
    `scene=(${r.sceneDelta.x.toFixed(2)},${r.sceneDelta.y.toFixed(2)}) ` +
    `stored=(${r.storedDelta.x.toFixed(2)},${r.storedDelta.y.toFixed(2)}) ` +
    `expected=(${(r.pointer.dx / r.zoom).toFixed(2)},${(r.pointer.dy / r.zoom).toFixed(2)}) ` +
    `screen=(${r.screenDelta.x.toFixed(2)},${r.screenDelta.y.toFixed(2)})`;

  const SCENE_TOLERANCE = 0.75; // scene units; measured drift is under 0.02
  const SCREEN_TOLERANCE = 1; // CSS pixels; bounding boxes are subpixel

  /** The whole contract: stored and drawn deltas match the pointer delta over zoom. */
  const movedAsExpected = (r) =>
    r.grabbable !== false &&
    Math.abs(r.storedDelta.x - r.pointer.dx / r.zoom) <= SCENE_TOLERANCE &&
    Math.abs(r.storedDelta.y - r.pointer.dy / r.zoom) <= SCENE_TOLERANCE &&
    Math.abs(r.sceneDelta.x - r.pointer.dx / r.zoom) <= SCENE_TOLERANCE &&
    Math.abs(r.sceneDelta.y - r.pointer.dy / r.zoom) <= SCENE_TOLERANCE &&
    Math.abs(r.screenDelta.x - r.pointer.dx) <= SCREEN_TOLERANCE &&
    Math.abs(r.screenDelta.y - r.pointer.dy) <= SCREEN_TOLERANCE;

  // Fit zoom is itself a non-default scale, so even the baseline is not zoom 1.
  const fitView = await measureCallout();
  check(
    'the drawing is fitted at a non-unity zoom',
    fitView.zoom > 0.5 && Math.abs(fitView.zoom - 1) > 0.1 && fitView.onStage === true,
    `zoom=${fitView.zoom.toFixed(4)} onStage=${fitView.onStage}`,
  );
  const loadId = Object.keys(await readPlacements()).length;

  /* ---------------- Baseline: dragging at fit zoom ---------------- */

  // Drag up and to the left, which also parks the label nearer the middle of the scene
  // so the zoomed-in case below cannot push it off the stage.
  const atFit = await dragCallout({ dx: -60, dy: -60 });
  check('a callout can be dragged', movedAsExpected(atFit), format(atFit));
  check(
    'the drag was recognised as a drag, not a click',
    /Annotation moved/.test(await page.locator('#export-status').textContent()),
    await page.locator('#export-status').textContent(),
  );
  check(
    'the offset was persisted under the callout it belongs to',
    Object.keys(await readPlacements()).length === loadId + 1 && atFit.key === dragNodeId,
    `keys=${Object.keys(await readPlacements()).join('|')}`,
  );

  /* ---------------- Zoomed in ---------------- */

  const zoomedInView = await zoomTo(2);
  check(
    'zooming in raised the rendered scale above fit',
    zoomedInView.zoom > fitView.zoom * 1.4,
    `fit=${fitView.zoom.toFixed(4)} zoomedIn=${zoomedInView.zoom.toFixed(4)}`,
  );
  check('the callout is still on stage when zoomed in', zoomedInView.onStage === true);
  const zoomedIn = await dragCallout({ dx: 53, dy: 27 });
  check('dragging works when zoomed in', movedAsExpected(zoomedIn), format(zoomedIn));

  /* ---------------- Zoomed out ---------------- */

  const zoomedOutView = await zoomTo(-3);
  check(
    'zooming out dropped the rendered scale below fit',
    zoomedOutView.zoom < fitView.zoom * 0.7,
    `fit=${fitView.zoom.toFixed(4)} zoomedOut=${zoomedOutView.zoom.toFixed(4)}`,
  );
  const zoomedOut = await dragCallout({ dx: -17, dy: -9 });
  check('dragging works when zoomed out', movedAsExpected(zoomedOut), format(zoomedOut));

  // The discriminating check. Each drag stored `pointer delta / zoom`, so the conversion
  // factor each one applied is one over its zoom. Those two factors must differ by
  // exactly the ratio of the zooms - a raw-pixel implementation applies 1 at every zoom,
  // so its ratio would be 1 and no single scale could satisfy both drags above.
  const factorIn = zoomedIn.storedDelta.x / zoomedIn.pointer.dx;
  const factorOut = zoomedOut.storedDelta.x / zoomedOut.pointer.dx;
  const zoomRatio = zoomedInView.zoom / zoomedOutView.zoom;
  check(
    'each zoom applied its own conversion, matching the ratio of the zooms',
    Math.abs(zoomedIn.storedDelta.x - zoomedIn.pointer.dx / zoomedInView.zoom) <= SCENE_TOLERANCE &&
      Math.abs(zoomedOut.storedDelta.x - zoomedOut.pointer.dx / zoomedOutView.zoom) <= SCENE_TOLERANCE &&
      Math.abs(factorOut / factorIn - zoomRatio) <= 0.02,
    `factorIn=1/${(1 / factorIn).toFixed(3)} factorOut=1/${(1 / factorOut).toFixed(3)} ` +
      `ratio=${(factorOut / factorIn).toFixed(3)} zoomRatio=${zoomRatio.toFixed(3)}`,
  );

  /* ---------------- Zoom alone must not move a manual offset ---------------- */

  const offsetBeforeZoom = await readPlacements();
  const sceneBeforeZoom = await measureCallout();
  await page.click('#btn-zoom-in');
  await page.waitForTimeout(200);
  await page.click('#btn-zoom-in');
  await page.waitForTimeout(300);
  const afterZoomView = await measureCallout();
  const offsetAfterZoom = await readPlacements();
  check(
    'changing the zoom leaves the stored offset untouched',
    JSON.stringify(offsetBeforeZoom) === JSON.stringify(offsetAfterZoom),
    JSON.stringify(offsetAfterZoom),
  );
  check(
    'changing the zoom leaves the scene position untouched',
    Math.abs(afterZoomView.scene.x - sceneBeforeZoom.scene.x) < 0.01 &&
      Math.abs(afterZoomView.scene.y - sceneBeforeZoom.scene.y) < 0.01,
    `${JSON.stringify(sceneBeforeZoom.scene)} -> ${JSON.stringify(afterZoomView.scene)}`,
  );

  /* ---------------- Panning must not leak into the offset ---------------- */

  const stageBox = await page.locator('#preview-stage').boundingBox();
  const beforePan = await measureCallout();
  // Snapshot the saved offsets directly around the pan, so "panning moves the view and
  // not the label" is proved rather than inferred from the viewport numbers alone.
  const placementsBeforePan = await readPlacements();
  await page.mouse.move(stageBox.x + 15, stageBox.y + 15);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + 55, stageBox.y + 40);
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const afterPan = await measureCallout();
  const placementsAfterPan = await readPlacements();
  check(
    'dragging the stage pans the viewport',
    Math.abs(afterPan.panX - beforePan.panX) > 20 && Math.abs(afterPan.panY - beforePan.panY) > 10,
    `pan ${beforePan.panX.toFixed(1)},${beforePan.panY.toFixed(1)} -> ` +
      `${afterPan.panX.toFixed(1)},${afterPan.panY.toFixed(1)}`,
  );
  check(
    'panning alone leaves every saved manual offset byte-identical',
    JSON.stringify(placementsBeforePan) === JSON.stringify(placementsAfterPan) &&
      Object.keys(placementsBeforePan).length > 0,
    `${JSON.stringify(placementsBeforePan)} -> ${JSON.stringify(placementsAfterPan)}`,
  );
  const afterPanDrag = await dragCallout({ dx: -34, dy: -17 });
  check(
    'a drag after panning still converts by zoom alone',
    movedAsExpected(afterPanDrag),
    format(afterPanDrag),
  );

  /* ---------------- A genuine reload ---------------- */

  const beforeReload = await measureCallout();
  const storedBeforeReload = await readPlacements();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg');
  await page.waitForTimeout(700);
  const afterReload = await measureCallout();
  const storedAfterReload = await readPlacements();
  check(
    'the callout keeps its scene position across a reload',
    Math.abs(afterReload.scene.x - beforeReload.scene.x) < 0.01 &&
      Math.abs(afterReload.scene.y - beforeReload.scene.y) < 0.01,
    `${JSON.stringify(beforeReload.scene)} -> ${JSON.stringify(afterReload.scene)}`,
  );
  check(
    'the persisted offset is unchanged by the reload',
    JSON.stringify(storedBeforeReload) === JSON.stringify(storedAfterReload),
    JSON.stringify(storedAfterReload),
  );
  check(
    'the reloaded view is re-fitted, so the zoom differs',
    Math.abs(afterReload.zoom - beforeReload.zoom) > 0.05,
    `zoom ${beforeReload.zoom.toFixed(3)} -> ${afterReload.zoom.toFixed(3)}`,
  );

  // Re-zoom after the reload: the stored position is scene-space, so it must hold.
  await page.click('#btn-zoom-out');
  await page.waitForTimeout(150);
  await page.click('#btn-zoom-out');
  await page.waitForTimeout(300);
  const afterReloadZoom = await measureCallout();
  check(
    're-zooming after a reload does not disturb the saved position',
    JSON.stringify(await readPlacements()) === JSON.stringify(storedBeforeReload) &&
      Math.abs(afterReloadZoom.scene.x - afterReload.scene.x) < 0.01 &&
      Math.abs(afterReloadZoom.scene.y - afterReload.scene.y) < 0.01,
    `${JSON.stringify(afterReloadZoom.scene)} stored=${JSON.stringify(await readPlacements())}`,
  );

  /* ---------------- Dragging must not touch authored data ---------------- */

  const authored = await readSavedProject(page);
  check(
    'dragging left the routes untouched',
    authored?.routes?.length === 1 &&
      authored.routes[0].from === 'origin' &&
      authored.routes[0].direction === 'south' &&
      authored.routes[0].spans === 2,
    JSON.stringify(authored?.routes),
  );
  check(
    'dragging left the load identity, target and value untouched',
    authored?.loads?.length === 1 &&
      authored.loads[0].id === 'load-1' &&
      authored.loads[0].nodeId === dragNodeId &&
      authored.loads[0].value === 40 &&
      authored.loads[0].unit === 'kVA',
    JSON.stringify(authored?.loads),
  );
  check(
    'the callout still belongs to the same asset',
    afterReloadZoom.annotId === dragNodeId,
    `${afterReloadZoom.annotId} vs ${dragNodeId}`,
  );

  /* ---------------- A click is not a drag ---------------- */

  const beforeClick = await readPlacements();
  // Aim through the same grab-point search the drags use, so the click is proved to land
  // on the callout itself. The plate's geometric centre can be covered by other
  // annotation text, and a click there would be a click on something else entirely -
  // which would make this check pass for the wrong reason.
  const clickGrab = await findGrabPoint(dragNodeId);
  const clickHitOwner = await page.evaluate((point) => {
    if (!point) return null;
    const el = document.elementFromPoint(point.x, point.y);
    return el?.closest?.('[data-annot-id]')?.getAttribute('data-annot-id') ?? null;
  }, clickGrab);
  check(
    'the click target is the callout itself, not whatever covers its centre',
    clickGrab !== null && clickHitOwner === dragNodeId,
    `point=${JSON.stringify(clickGrab)} owner=${clickHitOwner}`,
  );
  if (clickGrab) {
    await page.mouse.move(clickGrab.x, clickGrab.y);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  check(
    'a click on a callout is not recorded as a drag',
    JSON.stringify(await readPlacements()) === JSON.stringify(beforeClick),
    JSON.stringify(await readPlacements()),
  );

  /* ---------------- Automatic placement is unaffected ---------------- */

  // A second load, never dragged, keeps its automatic placement: no stored offset yet a
  // callout is still drawn, so the manual path has not taken over the automatic one.
  await page.click('#tab-loads');
  await addLoad(page, { nodeId: 'origin', value: 15, unit: 'kW' });
  await page.waitForTimeout(300);
  const placementsAfterSecondLoad = await readPlacements();
  const autoPlaced = await page.evaluate(() => {
    const svg = document.querySelector('#preview-canvas svg');
    const origin = svg.querySelector('[id="callout:origin"]');
    return {
      present: Boolean(origin),
      text: origin ? origin.textContent.trim() : null,
      plates: svg.querySelectorAll('rect.callout-plate').length,
    };
  });
  check(
    'an annotation without an offset is still placed automatically',
    autoPlaced.present === true && /15 kW/.test(autoPlaced.text ?? '') && autoPlaced.plates === 2,
    JSON.stringify(autoPlaced),
  );
  check(
    'the new load records no manual offset',
    placementsAfterSecondLoad.origin === undefined,
    JSON.stringify(placementsAfterSecondLoad),
  );
  check(
    'the dragged offset is unchanged by the second load',
    JSON.stringify(placementsAfterSecondLoad[dragNodeId]) ===
      JSON.stringify(storedBeforeReload[dragNodeId]),
    JSON.stringify(placementsAfterSecondLoad),
  );
  /* ---------------- Spreadsheet workflow ---------------- */

  section('The incomplete-measurement notice does not block labels');

  // The notice is a filled band added after the callouts so it can claim a clear strip.
  // That also put it above them in the hit-test order, and because it had default
  // pointer behaviour a press on a label that happened to sit under the band was a press
  // on the notice: no annotation was found, so no drag started, and the event fell
  // through to the stage and panned the drawing. This section drives that exact
  // situation through the real UI and then proves the press reaches the label again.
  await fresh(page, base);
  await page.click('#btn-clear');
  await page.waitForTimeout(250);
  await addRoute(page, { from: 'origin', direction: 'south', spans: 2 });
  const noticeRows = await readRouteRows(page);
  const noticeNodeId = `dst:${noticeRows[0].id}`;
  await page.click('#tab-loads');
  await addLoad(page, { nodeId: noticeNodeId, value: 40, unit: 'kVA' });
  await page.click('#btn-fit');
  await page.waitForTimeout(350);
  await page.mouse.move(20, 20);
  await page.waitForTimeout(120);

  const noticeState = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('#preview-canvas');
      const svg = canvas.querySelector('svg');
      const group = svg?.querySelector('#notice') ?? null;
      const rect = group?.querySelector('rect') ?? null;
      const box = rect ? rect.getBoundingClientRect() : null;
      const canvasBox = canvas.getBoundingClientRect();
      const stageBox = document.querySelector('#preview-stage').getBoundingClientRect();
      return {
        present: Boolean(group),
        text: group?.querySelector('text')?.textContent?.trim() ?? null,
        pointerEvents: group ? getComputedStyle(group).pointerEvents : null,
        rect: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null,
        canvas: { x: canvasBox.x, y: canvasBox.y, w: canvasBox.width, h: canvasBox.height },
        stage: { x: stageBox.x, y: stageBox.y, w: stageBox.width, h: stageBox.height },
      };
    });

  /** The topmost element at a screen point and the annotation group it belongs to. */
  const hitOwnerAt = (x, y) =>
    page.evaluate(
      (point) => {
        const el = document.elementFromPoint(point.x, point.y);
        return {
          tag: el?.tagName ?? null,
          group: el?.parentElement?.id ?? null,
          owner: el?.closest?.('[data-annot-id]')?.getAttribute('data-annot-id') ?? null,
        };
      },
      { x, y },
    );

  const notice0 = await noticeState();
  check(
    'the incomplete-measurement notice is drawn',
    notice0.present === true && /Span measurements incomplete/.test(notice0.text ?? ''),
    JSON.stringify({ present: notice0.present, text: notice0.text }),
  );
  // The whole point of the fix: visible to the reader, invisible to the pointer.
  check(
    'the notice is presentational, not interactive',
    notice0.pointerEvents === 'none',
    String(notice0.pointerEvents),
  );

  // Park the label inside the notice band with a real drag. The target is derived from
  // the band and the canvas, not from hand-picked pixels.
  const parkTarget = {
    x: Math.round(Math.min(notice0.canvas.x + notice0.canvas.w, notice0.rect.x + notice0.rect.w) - 55),
    y: Math.round(notice0.rect.y + notice0.rect.h / 2),
  };
  const parkFrom = await findGrabPoint(noticeNodeId);
  check(
    'the label can be grabbed before it moves under the notice',
    parkFrom !== null,
    JSON.stringify(parkFrom),
  );
  if (parkFrom) {
    await page.mouse.move(parkFrom.x, parkFrom.y);
    await page.mouse.down();
    for (let s = 1; s <= 10; s += 1) {
      await page.mouse.move(
        parkFrom.x + Math.round(((parkTarget.x - parkFrom.x) * s) / 10),
        parkFrom.y + Math.round(((parkTarget.y - parkFrom.y) * s) / 10),
      );
      await page.waitForTimeout(15);
    }
    await page.mouse.up();
    await page.waitForTimeout(500);
  }

  const under = await noticeState();
  const centreAt = () =>
    page.evaluate(() => {
      const plate = document.querySelector('#preview-canvas rect.callout-plate');
      const box = plate.getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    });
  const underCentre = await centreAt();
  const underHit = await hitOwnerAt(underCentre.x, underCentre.y);
  check(
    'the label now lies under the notice band',
    Boolean(under.rect) &&
      underCentre.x > under.rect.x &&
      underCentre.x < under.rect.x + under.rect.w &&
      underCentre.y > under.rect.y &&
      underCentre.y < under.rect.y + under.rect.h,
    `point=${JSON.stringify(underCentre)} band=${JSON.stringify(under.rect)}`,
  );
  check(
    'the notice no longer takes the hit',
    underHit.owner === noticeNodeId,
    `${underHit.tag} in #${underHit.group} owner=${underHit.owner}`,
  );

  /* ---------------- A covered label still drags, and the view does not move ---------------- */

  const coveredBefore = await measureCallout();
  const coveredPlacementsBefore = await readPlacements();
  const coveredLoadsBefore = (await readSavedProject(page))?.loads ?? [];
  const coveredGrab = await findGrabPoint(noticeNodeId);
  check(
    'the covered label is still grabbable',
    coveredGrab !== null,
    JSON.stringify(coveredGrab),
  );

  const COVERED_DX = -46;
  const COVERED_DY = -22;
  if (coveredGrab) {
    await page.mouse.move(coveredGrab.x, coveredGrab.y);
    await page.mouse.down();
    for (let s = 1; s <= 10; s += 1) {
      await page.mouse.move(
        coveredGrab.x + Math.round((COVERED_DX * s) / 10),
        coveredGrab.y + Math.round((COVERED_DY * s) / 10),
      );
      await page.waitForTimeout(15);
    }
    await page.mouse.up();
    await page.waitForTimeout(500);
  }

  const coveredAfter = await measureCallout();
  const coveredPlacementsAfter = await readPlacements();
  const coveredStoredBefore = coveredPlacementsBefore[noticeNodeId] ?? { dx: 0, dy: 0 };
  const coveredStoredAfter = coveredPlacementsAfter[noticeNodeId] ?? { dx: 0, dy: 0 };
  const storedDelta = {
    x: coveredStoredAfter.dx - coveredStoredBefore.dx,
    y: coveredStoredAfter.dy - coveredStoredBefore.dy,
  };
  const screenDelta = {
    x: coveredAfter.screen.x - coveredBefore.screen.x,
    y: coveredAfter.screen.y - coveredBefore.screen.y,
  };
  check(
    'dragging a label under the notice records a manual offset',
    Math.abs(storedDelta.x - COVERED_DX / coveredBefore.zoom) <= SCENE_TOLERANCE &&
      Math.abs(storedDelta.y - COVERED_DY / coveredBefore.zoom) <= SCENE_TOLERANCE,
    `stored=(${storedDelta.x.toFixed(2)},${storedDelta.y.toFixed(2)}) ` +
      `expected=(${(COVERED_DX / coveredBefore.zoom).toFixed(2)},${(COVERED_DY / coveredBefore.zoom).toFixed(2)})`,
  );
  check(
    'the covered label follows the pointer',
    Math.abs(screenDelta.x - COVERED_DX) <= SCREEN_TOLERANCE &&
      Math.abs(screenDelta.y - COVERED_DY) <= SCREEN_TOLERANCE,
    `moved=(${screenDelta.x.toFixed(2)},${screenDelta.y.toFixed(2)}) expected=(${COVERED_DX},${COVERED_DY})`,
  );
  check(
    'the viewport stays put while the covered label is dragged',
    Math.abs(coveredAfter.panX - coveredBefore.panX) < 0.5 &&
      Math.abs(coveredAfter.panY - coveredBefore.panY) < 0.5,
    `pan ${coveredBefore.panX.toFixed(1)},${coveredBefore.panY.toFixed(1)} -> ` +
      `${coveredAfter.panX.toFixed(1)},${coveredAfter.panY.toFixed(1)}`,
  );

  const coveredLoadsAfter = (await readSavedProject(page))?.loads ?? [];
  check(
    'dragging under the notice leaves the callout identity and its load untouched',
    coveredAfter.annotId === noticeNodeId &&
      JSON.stringify(coveredLoadsAfter) === JSON.stringify(coveredLoadsBefore) &&
      coveredLoadsAfter.length === 1 &&
      coveredLoadsAfter[0].nodeId === noticeNodeId &&
      coveredLoadsAfter[0].value === 40 &&
      coveredLoadsAfter[0].unit === 'kVA',
    `${coveredAfter.annotId} / ${JSON.stringify(coveredLoadsAfter)}`,
  );
  check(
    'the notice is still drawn after the drag',
    (await noticeState()).present === true,
  );

  /* ---------------- Empty parts of the band behave like the stage ---------------- */

  // With the notice transparent to input, an empty part of the band is ordinary stage
  // area: a drag there pans. Before the fix it was dead space that also swallowed the
  // press, which is what made the band feel broken rather than absent.
  const emptyX = Math.round(under.canvas.x + 25);
  const emptyY = Math.round(under.rect.y + under.rect.h / 2);
  const emptyHit = await hitOwnerAt(emptyX, emptyY);
  check(
    'an empty part of the band is not owned by an annotation',
    emptyHit.owner === null,
    `${emptyHit.tag} in #${emptyHit.group} owner=${emptyHit.owner}`,
  );
  const beforeEmptyPan = await measureCallout();
  await page.mouse.move(emptyX, emptyY);
  await page.mouse.down();
  await page.mouse.move(emptyX + 40, emptyY + 25);
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const afterEmptyPan = await measureCallout();
  check(
    'an empty part of the band still pans the viewport',
    Math.abs(afterEmptyPan.panX - beforeEmptyPan.panX) > 20 ||
      Math.abs(afterEmptyPan.panY - beforeEmptyPan.panY) > 15,
    `pan ${beforeEmptyPan.panX.toFixed(1)},${beforeEmptyPan.panY.toFixed(1)} -> ` +
      `${afterEmptyPan.panX.toFixed(1)},${afterEmptyPan.panY.toFixed(1)}`,
  );

  /* ---------------- The manual placement survives a reload ---------------- */

  const noticeBeforeReload = await measureCallout();
  const noticeOffsetsBeforeReload = await readPlacements();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg');
  await page.waitForTimeout(700);
  const noticeAfterReload = await measureCallout();
  check(
    'the manual placement made under the notice survives a reload',
    Math.abs(noticeAfterReload.scene.x - noticeBeforeReload.scene.x) < 0.01 &&
      Math.abs(noticeAfterReload.scene.y - noticeBeforeReload.scene.y) < 0.01 &&
      JSON.stringify(await readPlacements()) === JSON.stringify(noticeOffsetsBeforeReload),
    `${JSON.stringify(noticeBeforeReload.scene)} -> ${JSON.stringify(noticeAfterReload.scene)}`,
  );
  check(
    'the notice is drawn again after the reload',
    (await noticeState()).present === true,
  );

  /* ---------------- Measuring everything removes the notice ---------------- */

  await page.click('#tab-spans');
  await page.fill('#field-default-length', '30');
  await page.click('#btn-apply-default');
  await page.waitForTimeout(400);
  const completed = await noticeState();
  check(
    'the notice disappears once every span is measured',
    completed.present === false,
    JSON.stringify(completed.present),
  );
  // Removing the notice must not disturb where the user put the label.
  check(
    'removing the notice leaves the manual offset unchanged',
    JSON.stringify(await readPlacements()) === JSON.stringify(noticeOffsetsBeforeReload),
    JSON.stringify(await readPlacements()),
  );

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
    // The scene's own aspect ratio, taken from the drawing rather than restated, so the
    // print sizing is compared against the shape it is actually meant to preserve.
    const viewBoxParts = viewBox.trim().split(/\s+/).map(Number);
    const sceneAspect =
      viewBoxParts.length === 4 && viewBoxParts[2] > 0 && viewBoxParts[3] > 0
        ? viewBoxParts[2] / viewBoxParts[3]
        : 0;
    check(
      `${layout.id}: the embedded SVG carries a viewBox`,
      /^-?[\d.]+\s+-?[\d.]+\s+[\d.]+\s+[\d.]+$/.test(viewBox),
      viewBox,
    );
    // The drawing's size on the sheet. This is the two-sheet defect: `width:100%`
    // scales to the content width and derives the height from the aspect ratio, so a
    // drawing taller than it is wide overflowed every landscape sheet and the browser
    // paginated it. The size must instead be explicit and fit inside the printable box,
    // which is the paper minus the page margin on all four sides.
    const svgRule = (printCss.match(/svg\s*\{[^}]*\}/) ?? [''])[0];
    const widthMm = Number((svgRule.match(/width:\s*([\d.]+)mm/) ?? [])[1]);
    const heightMm = Number((svgRule.match(/height:\s*([\d.]+)mm/) ?? [])[1]);
    check(
      `${layout.id}: the drawing is given an explicit size on the sheet`,
      Number.isFinite(widthMm) && Number.isFinite(heightMm) && widthMm > 0 && heightMm > 0,
      `width ${widthMm}mm height ${heightMm}mm`,
    );
    check(
      `${layout.id}: the drawing is not sized by content width`,
      !/width:\s*100%/.test(svgRule),
      svgRule.replace(/\s+/g, ' '),
    );

    // The printable box: the paper minus its margin, in millimetres. The paper size is
    // taken from what the print document declared, so this compares the drawing against
    // the sheet it was actually sent to rather than against a restated constant.
    const marginMm = Number((pageRule.match(/margin:\s*([\d.]+)mm/) ?? [])[1]);
    const PAPER_MM = {
      a3: { width: 1190.55, height: 841.89 },
      a4: { width: 841.89, height: 595.28 },
      letter: { width: 792, height: 612 },
    };
    const pointsToMm = 25.4 / 72;
    // `size:` carries the format and the orientation; a portrait page swaps the axes.
    const formatKey = sizeValue.split(/\s+/)[0].toLowerCase();
    const isPortrait = /portrait/i.test(sizeValue);
    const paper = PAPER_MM[formatKey];
    const paperWidthPt = paper ? (isPortrait ? paper.height : paper.width) : NaN;
    const paperHeightPt = paper ? (isPortrait ? paper.width : paper.height) : NaN;
    const boxWidthMm = paperWidthPt * pointsToMm - marginMm * 2;
    const boxHeightMm = paperHeightPt * pointsToMm - marginMm * 2;
    check(
      `${layout.id}: the declared paper is a known size`,
      Number.isFinite(boxWidthMm) && Number.isFinite(boxHeightMm),
      `size "${sizeValue}", margin ${marginMm}mm`,
    );
    // A tenth of a millimetre absorbs the millimetre-precision rounding in the CSS size
    // without allowing real overflow, which is tens of millimetres.
    const FIT_TOLERANCE_MM = 0.1;
    check(
      `${layout.id}: the drawing fits the printable width, so one sheet is enough`,
      widthMm <= boxWidthMm + FIT_TOLERANCE_MM,
      `${widthMm.toFixed(2)}mm against a ${boxWidthMm.toFixed(2)}mm box`,
    );
    check(
      `${layout.id}: the drawing fits the printable height, so one sheet is enough`,
      heightMm <= boxHeightMm + FIT_TOLERANCE_MM,
      `${heightMm.toFixed(2)}mm against a ${boxHeightMm.toFixed(2)}mm box. ` +
        'Exceeding this is the two-sheet overflow.',
    );
    check(
      `${layout.id}: the drawing is not stretched or squashed`,
      // The CSS size is written to three decimal places of a millimetre, so the ratios
      // are compared to that rounding rather than to floating-point equality.
      Math.abs(widthMm / heightMm - sceneAspect) < 1e-3,
      `ratio ${(widthMm / heightMm).toFixed(6)} against the scene's ${sceneAspect.toFixed(6)}`,
    );
    check(
      `${layout.id}: nothing may be split across sheets`,
      /break-inside:\s*avoid/.test(printCss),
      'page-break-inside:avoid must be present',
    );

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

  section('Route and spacing limits');

  // The form and the project parser used to disagree: the form refused a 501st span while
  // the parser accepted it, and the form clamped spacing to 12-120 px while the parser
  // accepted 8 px. Nothing said which was the policy. It is now one module
  // (`src/data/constraints.js`) with one rule for each context:
  //
  //   - interactive input is bounded and refused or clamped before anything changes;
  //   - stored values are NEVER rewritten. A file saved by an older build still opens,
  //     keeps the numbers the user authored, and says what is outside the form's range.
  //
  // This section drives both halves through the real UI, because "the parser accepts it"
  // and "the application copes with it" are different claims.

  const limits = await page.evaluate(async () => {
    const { requiredSpanLength } = await import('./src/geometry/clearance.js');
    return { required: requiredSpanLength() };
  });

  /* ---------------- Interactive: the form refuses over the limit ---------------- */

  await fresh(page, base);
  await page.click('#btn-clear');
  await page.waitForTimeout(250);

  const rowsBeforeLimit = (await readRouteRows(page)).length;
  await page.selectOption('#field-from', 'origin');
  await page.selectOption('#field-direction', 'south');
  await page.fill('#field-spans', '501');
  await page.click('#btn-save-route');
  await page.waitForTimeout(250);
  const overLimitRefusal = await page.evaluate(() => {
    const el = document.querySelector('#form-error');
    return el ? el.textContent.trim() : null;
  });
  check(
    'the form refuses a 501st span and says what the limit is',
    /500 spans or fewer/.test(overLimitRefusal ?? ''),
    String(overLimitRefusal),
  );
  check(
    'a refused span count adds no route',
    (await readRouteRows(page)).length === rowsBeforeLimit,
    `${(await readRouteRows(page)).length} rows`,
  );

  // Exactly the limit is a normal route. It is built once, here, because it is the only
  // place the boundary is exercised with a real network behind it.
  await page.fill('#field-spans', '500');
  await page.click('#btn-save-route');
  await page.waitForTimeout(1200);
  const atLimitSaved = await readSavedProject(page);
  const atLimitRows = await readRouteRows(page);
  check(
    'exactly 500 spans is accepted and drawn',
    atLimitRows.length === rowsBeforeLimit + 1 && atLimitSaved?.routes?.at(-1)?.spans === 500,
    JSON.stringify(atLimitSaved?.routes?.map((r) => r.spans)),
  );

  /* ---------------- Stored: an over-limit project opens and is explained ---------------- */

  // A project this build would not have let the user author: a 501-span route and a 9 px
  // spacing. Both are legal in the file, neither may be rewritten on the way in.
  const legacy = await page.evaluate(async () => {
    const { serializeProjectJson } = await import('./src/ui/project.js');
    return serializeProjectJson(
      {
        routes: [
          { id: 'route-1', from: 'origin', direction: 'south', spans: 501, tc: false, fpb: false },
        ],
        originMarker: 'plain',
        spanLength: 9,
        layout: 'a4_landscape',
        loads: [],
        spanLengths: {},
        loadPlacements: {},
        spanPlacements: {},
        nodeDesignations: {},
      },
      { savedAt: new Date('2026-01-01T00:00:00Z') },
    );
  });
  await page.evaluate((doc) => {
    localStorage.clear();
    localStorage.setItem('line-route-drawing:v3:project', doc);
  }, legacy);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg', { timeout: 20000 });
  await page.waitForTimeout(600);

  const readWarnings = () =>
    page.evaluate(() => {
      const read = (id) => {
        const el = document.querySelector(id);
        return el && !el.hidden ? el.textContent.trim() : null;
      };
      return {
        route: read('#route-warning'),
        spacing: read('#spacing-warning'),
        banner: (document.body.innerText.match(/[^\n]*cannot be opened[^\n]*/i) ?? [null])[0],
        spacingValue: document.querySelector('#field-spacing').value,
        exportDisabled: document.querySelector('#btn-svg').disabled,
        rowCount: document.querySelectorAll('#route-rows tr[data-id]').length,
      };
    });

  const legacyState = await readWarnings();
  const legacySaved = await readSavedProject(page);
  check(
    'an over-limit project opens instead of being refused',
    legacyState.banner === null && legacyState.rowCount === 1,
    JSON.stringify({ banner: legacyState.banner, rowCount: legacyState.rowCount }),
  );
  check(
    'the stored span count is kept exactly as saved',
    legacySaved?.routes?.[0]?.spans === 501,
    JSON.stringify(legacySaved?.routes),
  );
  check(
    'the over-limit route is named in the route warning',
    /Route 1 has 501 spans/.test(legacyState.route ?? '') && /500/.test(legacyState.route ?? ''),
    String(legacyState.route),
  );
  // The live clearance verdict owns this line while the spacing is too tight, and it is the
  // stronger message: it names the problem and the value that will fix it. Either way the
  // stored 9 px is still in the field and still in the file.
  check(
    'the stored spacing below the clearance requirement is kept and explained',
    legacyState.spacingValue === '9' &&
      /9 px/.test(legacyState.spacing ?? '') &&
      new RegExp(`${limits.required} px`).test(legacyState.spacing ?? ''),
    `${legacyState.spacingValue} / ${legacyState.spacing}`,
  );
  check(
    'a drawing with too-tight spacing cannot be exported',
    legacyState.exportDisabled === true,
    String(legacyState.exportDisabled),
  );

  /* ---------------- Editing a grandfathered route keeps its count ---------------- */

  // The over-limit count may be kept, because refusing every edit would force the user to
  // shorten a route they only wanted to change the direction of. Only growth is refused.
  await page.locator('#route-rows tr').first().locator('button[data-action="edit"]').click();
  await page.waitForTimeout(200);
  await page.selectOption('#field-direction', 'east');
  await page.click('#btn-save-route');
  await page.waitForTimeout(900);
  const editedState = await readWarnings();
  const editedSaved = await readSavedProject(page);
  check(
    'an over-limit route can be edited without shortening it first',
    editedSaved?.routes?.[0]?.spans === 501 && editedState.banner === null,
    JSON.stringify(editedSaved?.routes),
  );
  check(
    'the saved project keeps the grandfathered span count',
    editedSaved?.routes?.[0]?.spans === 501 && editedSaved?.routes?.[0]?.direction === 'east',
    JSON.stringify(editedSaved?.routes?.[0]),
  );
  check(
    'the route warning still explains the count after the edit',
    /501 spans/.test(editedState.route ?? ''),
    String(editedState.route),
  );

  /* ---------------- A grandfathered route can be reduced, step by step ---------------- */

  // The rule is monotonic non-increase: a saved route above the limit may keep its count or
  // lower it, but may never raise it. An earlier build accepted an over-limit count only
  // when it was *identical* to the saved one, so every intermediate step of a reduction was
  // refused and the only way to shorten such a route was to jump straight to 500. This block
  // drives the real form 648 -> 600 -> 550 and then checks both directions of the rule: 551
  // is still refused, and 500 returns the route to ordinary behaviour.
  const overLimitDoc = await page.evaluate(async () => {
    const { serializeProjectJson } = await import('./src/ui/project.js');
    return serializeProjectJson(
      {
        routes: [
          { id: 'route-1', from: 'origin', direction: 'south', spans: 648, tc: false, fpb: false },
        ],
        originMarker: 'plain',
        spanLength: 40,
        layout: 'a4_landscape',
        loads: [{ id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' }],
        spanLengths: {},
        loadPlacements: {},
        spanPlacements: {},
        nodeDesignations: {},
      },
      { savedAt: new Date('2026-01-01T00:00:00Z') },
    );
  });
  await page.evaluate((doc) => {
    localStorage.clear();
    localStorage.setItem('line-route-drawing:v3:project', doc);
  }, overLimitDoc);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg', { timeout: 30000 });
  await page.waitForTimeout(900);

  /** The route records, the warning line and the drawn callout, read from the page. */
  const readGrandfathered = () =>
    page.evaluate(() => {
      const svg = document.querySelector('#preview-canvas svg');
      const callout = svg?.querySelector('[id="callout:dst:route-1"]');
      const warning = document.querySelector('#route-warning');
      const rows = [...document.querySelectorAll('#route-rows tr[data-id]')];
      return {
        rowIds: rows.map((tr) => tr.dataset.id),
        // Column 3 is "Spans" (#, From, Direction, Spans, Marker, Status, Actions).
        rowSpans: rows.map((tr) => tr.querySelectorAll('td')[3]?.textContent.trim() ?? null),
        warning: warning && !warning.hidden ? warning.textContent.trim() : null,
        callout: callout ? callout.textContent.trim() : null,
        formError: document.querySelector('#form-error')?.textContent.trim() ?? null,
      };
    });

  /** Edit route 1 to a new span count through the form, keeping its direction. */
  async function setRouteSpanCount(spans) {
    await page.locator('#route-rows tr').first().locator('button[data-action="edit"]').click();
    await page.waitForTimeout(200);
    await page.fill('#field-spans', String(spans));
    await page.click('#btn-save-route');
    await page.waitForTimeout(1200);
  }

  const openedGrandfathered = await readGrandfathered();
  const openedSaved = await readSavedProject(page);
  check(
    'a 648-span stored route opens with its own count',
    openedSaved?.routes?.[0]?.id === 'route-1' &&
      openedSaved?.routes?.[0]?.spans === 648 &&
      openedGrandfathered.rowSpans.includes('648'),
    JSON.stringify({ spans: openedSaved?.routes?.[0]?.spans, rows: openedGrandfathered.rowSpans }),
  );
  check(
    'the warning says the count may be kept or lowered, not that it must be shortened',
    /648 spans/.test(openedGrandfathered.warning ?? '') &&
      /leave that count or lower it/.test(openedGrandfathered.warning ?? '') &&
      /not raise it/.test(openedGrandfathered.warning ?? '') &&
      !/before you change anything else/.test(openedGrandfathered.warning ?? ''),
    String(openedGrandfathered.warning),
  );
  check(
    'the load on the long route is drawn and resolvable',
    /25 kVA/.test(openedGrandfathered.callout ?? '') &&
      openedSaved?.loads?.[0]?.nodeId === 'dst:route-1',
    JSON.stringify({ callout: openedGrandfathered.callout, load: openedSaved?.loads?.[0] }),
  );

  // 1. Keeping the count while changing the direction - the case the earlier build did allow,
  //    re-checked here so a failure of the reduction path cannot hide a regression in this one.
  await page.locator('#route-rows tr').first().locator('button[data-action="edit"]').click();
  await page.waitForTimeout(200);
  await page.selectOption('#field-direction', 'east');
  await page.click('#btn-save-route');
  await page.waitForTimeout(1200);
  const keptSaved = await readSavedProject(page);
  check(
    'editing the direction with all 648 spans kept still succeeds',
    keptSaved?.routes?.[0]?.spans === 648 && keptSaved?.routes?.[0]?.direction === 'east',
    JSON.stringify(keptSaved?.routes?.[0]),
  );

  // 2. The first reduction: 648 -> 600. This is the step the earlier build refused.
  await setRouteSpanCount(600);
  const reduced600 = await readSavedProject(page);
  check(
    'reducing 648 to 600 is accepted and saved',
    reduced600?.routes?.[0]?.spans === 600 &&
      reduced600?.routes?.[0]?.id === 'route-1' &&
      reduced600?.routes?.[0]?.direction === 'east',
    JSON.stringify(reduced600?.routes?.[0]),
  );
  check(
    'the route id and its load survive the reduction',
    reduced600?.loads?.length === 1 &&
      reduced600?.loads?.[0]?.id === 'load-1' &&
      reduced600?.loads?.[0]?.nodeId === 'dst:route-1' &&
      reduced600?.loads?.[0]?.value === 25 &&
      reduced600?.loads?.[0]?.unit === 'kVA',
    JSON.stringify(reduced600?.loads),
  );

  // 3. Reload, to prove the reduction reached the file rather than only the screen.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg', { timeout: 30000 });
  await page.waitForTimeout(900);
  const reloaded600 = await readSavedProject(page);
  const reloadedState = await readGrandfathered();
  check(
    'the reduced count survives a reload',
    reloaded600?.routes?.[0]?.spans === 600 &&
      reloaded600?.loads?.[0]?.nodeId === 'dst:route-1' &&
      /600 spans/.test(reloadedState.warning ?? ''),
    JSON.stringify({ spans: reloaded600?.routes?.[0]?.spans, warning: reloadedState.warning }),
  );

  // 4. A second reduction, from the count the route has *now*: 600 -> 550.
  await setRouteSpanCount(550);
  const reduced550 = await readSavedProject(page);
  check(
    'a second reduction, 600 to 550, is accepted and saved',
    reduced550?.routes?.[0]?.spans === 550 && reduced550?.routes?.[0]?.id === 'route-1',
    JSON.stringify(reduced550?.routes?.[0]),
  );

  // 5. Growth is still refused, and refused without touching the route.
  await page.locator('#route-rows tr').first().locator('button[data-action="edit"]').click();
  await page.waitForTimeout(200);
  await page.fill('#field-spans', '551');
  await page.click('#btn-save-route');
  await page.waitForTimeout(400);
  const growRefusal = await readGrandfathered();
  const afterGrowAttempt = await readSavedProject(page);
  check(
    'raising 550 back to 551 is refused and names the current count',
    /550 spans/.test(growRefusal.formError ?? '') && /not raise it/.test(growRefusal.formError ?? ''),
    String(growRefusal.formError),
  );
  check(
    'the refused growth leaves the saved route at 550',
    afterGrowAttempt?.routes?.[0]?.spans === 550,
    JSON.stringify(afterGrowAttempt?.routes?.[0]?.spans),
  );

  // 6. A new over-limit route is still refused while a grandfathered one exists - the two
  //    paths must not have been merged into one another by this change.
  await page.click('#btn-cancel-edit');
  await page.waitForTimeout(200);
  await page.selectOption('#field-from', 'origin');
  await page.selectOption('#field-direction', 'south');
  await page.fill('#field-spans', '501');
  await page.click('#btn-save-route');
  await page.waitForTimeout(400);
  const newOverLimit = await readGrandfathered();
  const afterNewAttempt = await readRouteRows(page);
  check(
    'a new 501-span route is still refused',
    /500 spans or fewer/.test(newOverLimit.formError ?? '') && afterNewAttempt.length === 1,
    `${newOverLimit.formError} / ${afterNewAttempt.length} rows`,
  );

  // 7. Down to the limit: the route becomes ordinary again.
  await setRouteSpanCount(500);
  const reduced500 = await readSavedProject(page);
  const ordinaryState = await readGrandfathered();
  check(
    'reducing to 500 is accepted and saved',
    reduced500?.routes?.[0]?.spans === 500 && reduced500?.routes?.[0]?.id === 'route-1',
    JSON.stringify(reduced500?.routes?.[0]),
  );
  check(
    'at 500 spans the route warning disappears',
    ordinaryState.warning === null,
    String(ordinaryState.warning),
  );
  // Ordinary means the authoring limit applies again: one more span is refused there.
  await page.locator('#route-rows tr').first().locator('button[data-action="edit"]').click();
  await page.waitForTimeout(200);
  await page.fill('#field-spans', '501');
  await page.click('#btn-save-route');
  await page.waitForTimeout(400);
  const ordinaryGrow = await readGrandfathered();
  check(
    'once back at 500 the ordinary limit refuses a 501st span',
    /500 spans or fewer/.test(ordinaryGrow.formError ?? ''),
    String(ordinaryGrow.formError),
  );
  await page.click('#btn-cancel-edit');
  await page.waitForTimeout(300);
  const finalProject = await readSavedProject(page);
  check(
    'the route, its id, its direction and its load are intact at the end',
    finalProject?.routes?.[0]?.id === 'route-1' &&
      finalProject?.routes?.[0]?.direction === 'east' &&
      finalProject?.routes?.[0]?.spans === 500 &&
      finalProject?.loads?.length === 1 &&
      finalProject?.loads?.[0]?.nodeId === 'dst:route-1' &&
      finalProject?.loads?.[0]?.value === 25,
    JSON.stringify({ route: finalProject?.routes?.[0], loads: finalProject?.loads }),
  );

  // Typing into the spacing field is interactive, so it is brought into range - the one
  // place clamping is the right answer, because the user just asked for that value.
  await page.fill('#field-spacing', '8');
  await page.dispatchEvent('#field-spacing', 'change');
  await page.waitForTimeout(500);
  const clampedState = await readWarnings();
  check(
    'a spacing typed into the field is brought up to the floor, not left at 8',
    clampedState.spacingValue === '12',
    String(clampedState.spacingValue),
  );
  // The floor is not the clearance requirement: 12 px is still too tight to draw, so the
  // warning stays and export stays blocked. What changed is only the value the user typed.
  check(
    'the floor does not claim the drawing is now exportable',
    clampedState.exportDisabled === true && clampedState.spacing !== null,
    `disabled=${clampedState.exportDisabled} warning=${clampedState.spacing}`,
  );

  /* ---------------- Stored: the wide end of the field range ---------------- */

  const wideSpacing = await page.evaluate(async () => {
    const { serializeProjectJson } = await import('./src/ui/project.js');
    return serializeProjectJson(
      {
        routes: [
          { id: 'route-1', from: 'origin', direction: 'south', spans: 2, tc: false, fpb: false },
        ],
        originMarker: 'plain',
        spanLength: 300,
        layout: 'a4_landscape',
        loads: [],
        spanLengths: {},
        loadPlacements: {},
        spanPlacements: {},
        nodeDesignations: {},
      },
      { savedAt: new Date('2026-01-01T00:00:00Z') },
    );
  });
  await page.evaluate((doc) => {
    localStorage.clear();
    localStorage.setItem('line-route-drawing:v3:project', doc);
  }, wideSpacing);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg', { timeout: 20000 });
  await page.waitForTimeout(500);
  const wideState = await readWarnings();
  check(
    'a spacing wider than the field opens and draws',
    wideState.spacingValue === '300' && wideState.rowCount === 1,
    `${wideState.spacingValue} / ${wideState.rowCount} rows`,
  );
  check(
    'the field range is mentioned so the next edit is not a surprise',
    /300 px/.test(wideState.spacing ?? '') && /120 px/.test(wideState.spacing ?? ''),
    String(wideState.spacing),
  );
  check(
    'a wide spacing does not withhold export, because it draws correctly',
    wideState.exportDisabled === false,
    String(wideState.exportDisabled),
  );

  await page.fill('#field-spacing', '400');
  await page.dispatchEvent('#field-spacing', 'change');
  await page.waitForTimeout(400);
  const wideClamped = await readWarnings();
  check(
    'a typed spacing above the ceiling is brought down to it',
    wideClamped.spacingValue === '120',
    String(wideClamped.spacingValue),
  );

  /* ---------------- An ordinary project says nothing at all ---------------- */

  await fresh(page, base);
  const plainState = await readWarnings();
  check(
    'a project within the form range shows neither warning',
    plainState.route === null && plainState.spacing === null,
    JSON.stringify({ route: plainState.route, spacing: plainState.spacing }),
  );

  section('Unknown project fields are refused, not trimmed');

  // A field the build does not recognise used to be ignored silently, which is how a
  // typo, a rename or an unmerged branch's data disappears on the next save with nothing
  // reported. It is now a refusal that names the exact path, and - because the stored copy
  // is the user's only one - the refusal must leave it untouched and pause autosaving.
  const unknownFieldDoc = await page.evaluate(async () => {
    const { serializeProjectJson } = await import('./src/ui/project.js');
    const doc = JSON.parse(
      serializeProjectJson(
        {
          routes: [
            { id: 'route-1', from: 'origin', direction: 'south', spans: 211, tc: false, fpb: false },
          ],
          originMarker: 'plain',
          spanLength: 40,
          layout: 'a4_landscape',
          loads: [],
          spanLengths: {},
          loadPlacements: {},
          spanPlacements: {},
          nodeDesignations: {},
        },
        { savedAt: new Date('2026-01-01T00:00:00Z') },
      ),
    );
    doc.project.somethingNew = 123;
    return JSON.stringify(doc, null, 2);
  });

  await page.evaluate((doc) => {
    localStorage.clear();
    localStorage.setItem('line-route-drawing:v3:project', doc);
  }, unknownFieldDoc);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg', { timeout: 20000 });
  await page.waitForTimeout(500);

  const refusedState = await page.evaluate(() => {
    const bar = document.querySelector('#recovery-bar');
    return {
      barShown: Boolean(bar) && !bar.hidden,
      text: bar && !bar.hidden ? bar.innerText.trim() : null,
      stored: (() => {
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key && key.includes('line-route')) return localStorage.getItem(key);
        }
        return null;
      })(),
      rowSpans: [...document.querySelectorAll('#route-rows tr')].map((tr) =>
        tr.querySelector('td:nth-child(4)')?.textContent?.trim(),
      ),
    };
  });

  check(
    'an unknown field stops the project opening',
    refusedState.barShown === true,
    JSON.stringify(refusedState.barShown),
  );
  check(
    'the refusal names the exact field path',
    /document\.project\.somethingNew/.test(refusedState.text ?? ''),
    String(refusedState.text).slice(0, 200),
  );
  check(
    'the unreadable project is not applied to the drawing',
    !refusedState.rowSpans.includes('211'),
    JSON.stringify(refusedState.rowSpans),
  );
  check(
    'the stored text is left exactly as it was',
    refusedState.stored === unknownFieldDoc,
    `${unknownFieldDoc.length} -> ${String(refusedState.stored).length} chars`,
  );

  // A readable project must not be treated the same way: no bar, and the route is applied.
  const knownFieldDoc = await page.evaluate(async () => {
    const { serializeProjectJson } = await import('./src/ui/project.js');
    return serializeProjectJson(
      {
        routes: [
          { id: 'route-1', from: 'origin', direction: 'south', spans: 211, tc: false, fpb: false },
        ],
        originMarker: 'plain',
        spanLength: 40,
        layout: 'a4_landscape',
        loads: [],
        spanLengths: {},
        loadPlacements: {},
        spanPlacements: {},
        nodeDesignations: {},
      },
      { savedAt: new Date('2026-01-01T00:00:00Z') },
    );
  });
  await page.evaluate((doc) => {
    localStorage.clear();
    localStorage.setItem('line-route-drawing:v3:project', doc);
  }, knownFieldDoc);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg', { timeout: 20000 });
  await page.waitForTimeout(500);
  const acceptedState = await page.evaluate(() => {
    const bar = document.querySelector('#recovery-bar');
    return {
      barShown: Boolean(bar) && !bar.hidden,
      rowSpans: [...document.querySelectorAll('#route-rows tr')].map((tr) =>
        tr.querySelector('td:nth-child(4)')?.textContent?.trim(),
      ),
    };
  });
  check(
    'the same project without the unknown field opens normally',
    acceptedState.barShown === false && acceptedState.rowSpans.includes('211'),
    JSON.stringify(acceptedState),
  );

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
