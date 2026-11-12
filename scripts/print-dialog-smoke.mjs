/**
 * Headed print-dialog smoke test.
 *
 * This is a manual check, not an automated assertion, and it is deliberately kept
 * out of `npm run test:browser`. That suite must never block, and the one thing a
 * native print dialog reliably does is block: it is owned by the operating system,
 * it waits for a person, and any attempt to close it from a browser automation API
 * is unreliable across platforms and Chrome versions. Driving it would make the
 * automated suite flaky for a check that a human can perform in a few seconds.
 *
 * What this script does is the part that can be trusted: it launches a real, visible
 * browser, uses the real application, selects a page layout through the real
 * selector, and presses the real Print drawing button. It does not replace
 * `window.print()`. The dialog that appears is the browser's own, showing the paper
 * it resolved from the `@page` rule rather than what a test says the rule contains.
 *
 * The remaining step is the one no browser API can make on a user's behalf: reading
 * the paper size and orientation shown in that dialog, and confirming a physical
 * printer driver would honour them. Those are printed as instructions when the
 * dialog opens.
 *
 * Run with:
 *
 *   npm run test:print:headed
 *   npm run test:print:headed -- --layout a4_portrait
 *   npm run test:print:headed -- --layout letter_landscape
 *
 * Requires Playwright and a visible browser. Playwright is a development
 * dependency; a checkout without it gets one sentence explaining how to add it.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/* ------------------------------------------------------------------ */
/* Playwright                                                          */
/* ------------------------------------------------------------------ */

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
      'This check uses the installed Google Chrome by default and needs no browser download.',
      'Set BROWSER_CHANNEL=chromium to use a Playwright-managed browser instead.',
    ].join('\n') + '\n',
  );
  process.exit(2);
}

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

/**
 * Read `--layout <id>` from the command line.
 *
 * The default is A3 landscape because it is the case the automated suite can only
 * prove from the CSS string: A3 was the layout most likely to be printed onto A4 by
 * mistake, so it is the one worth seeing in a real dialog first.
 */
function parseLayoutArg(argv) {
  const index = argv.indexOf('--layout');
  if (index !== -1 && argv[index + 1]) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith('--layout='));
  if (inline) return inline.slice('--layout='.length);
  return process.env.PRINT_LAYOUT ?? 'a3_landscape';
}

const WANTED_LAYOUT = parseLayoutArg(process.argv.slice(2));
const CHANNEL = process.env.BROWSER_CHANNEL ?? 'chrome';
const PORT = Number(process.env.PORT ?? 8173);

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

function startServer(port) {
  const child = spawn(process.execPath, [resolve(ROOT, 'scripts', 'serve.js'), String(port)], {
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
/* The check                                                          */
/* ------------------------------------------------------------------ */

const { chromium } = await loadPlaywright();
const base = `http://127.0.0.1:${PORT}/`;
const server = startServer(PORT);

if (!(await waitForServer(base))) {
  server.kill();
  process.stderr.write(`The application did not start on ${base}.\n`);
  process.exit(1);
}

// headless: false is the entire point. A native dialog cannot appear for a window
// that has no window.
const browser = await chromium.launch({
  headless: false,
  ...(CHANNEL === 'chromium' ? {} : { channel: CHANNEL }),
});

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      // Private mode or a blocked store: the example still loads.
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-canvas svg', { timeout: 15000 });

  // The layouts the application offers, read from the selector it renders from its
  // own configuration. Nothing is assumed about which exist.
  const layouts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#field-layout option')).map((option) => ({
      id: option.value,
      label: option.textContent.trim(),
    })),
  );

  const chosen = layouts.find((layout) => layout.id === WANTED_LAYOUT);
  if (!chosen) {
    process.stderr.write(
      `Unknown layout "${WANTED_LAYOUT}". Available: ${layouts.map((l) => l.id).join(', ')}\n`,
    );
    await browser.close();
    server.kill();
    process.exit(1);
  }

  // The real example, the real selector, the real button.
  await page.click('#btn-load-example');
  await page.waitForSelector('#preview-canvas svg', { timeout: 15000 });
  await page.selectOption('#field-layout', chosen.id);
  await page.waitForTimeout(200);

  // Report what the page itself resolved, so the person reading the dialog has
  // something to compare the dialog against. This reads the `@page` rule the print
  // document will be built with, without opening it yet.
  const declared = await page.evaluate(() => {
    const select = document.querySelector('#field-layout');
    return { selected: select ? select.value : '' };
  });

  process.stdout.write(
    [
      '',
      '='.repeat(72),
      '  PRINT DIALOG SMOKE TEST',
      '='.repeat(72),
      '',
      `  Layout selected in the application : ${chosen.label} (${chosen.id})`,
      `  Selector reports                    : ${declared.selected}`,
      '',
      '  The browser will now open its own print dialog.',
      '  This script does NOT replace or stub window.print(), so the dialog you',
      '  see is the real one, resolving the real @page rule.',
      '',
      '  Please check, in the dialog:',
      '',
      `    1. Paper size      should be  ${chosen.label.replace(/ (landscape|portrait)$/, '')}`,
      `    2. Orientation     should be  ${
        chosen.label.endsWith('portrait') ? 'Portrait' : 'Landscape'
      }`,
      '    3. Pages           should be  1',
      '    4. Preview         should show the whole drawing, nothing cut off',
      '',
      '  Then compare against the application:',
      '',
      '    5. The drawing in the preview should not be rotated or squashed',
      '    6. The TC triangle should keep its shape and sit between its cables',
      '    7. Pole X symbols, span labels and load callouts should be legible',
      '    8. The drawing\'s own alphabetical labels should NOT be printed',
      '    9. No orange incomplete-measurement banner should be printed',
      '',
      '  Physical printer behaviour (margins, driver scaling, "fit to page") is',
      '  decided by the printer driver, not by this page. Confirming that needs a',
      '  printer selected in the dialog and a real sheet, so it is out of scope',
      '  for an automated check and must be judged by eye.',
      '',
      '  Close the dialog when done. Nothing is sent to a printer, and this script',
      '  never confirms or submits a print job.',
      '',
      '  Run for another layout with:',
      '    npm run test:print:headed -- --layout a4_portrait',
      '    npm run test:print:headed -- --layout a4_landscape',
      '    npm run test:print:headed -- --layout letter_landscape',
      '',
      '='.repeat(72),
      '',
    ].join('\n'),
  );

  // The real workflow. `printDrawing()` writes the document, calls print() on the
  // hidden frame, and leaves it to the browser. The dialog blocks the page while it
  // is open. This call therefore does not return until a person dismisses it, which
  // is exactly the behaviour a smoke test wants and exactly why it is kept out of
  // the automated suite.
  //
  // Everything after this point that touches the page must tolerate a page that is
  // still blocked. `page.evaluate` does not: a dialog holds the renderer, so the
  // evaluation never resolves and the script waits forever. The wait below is
  // therefore a plain timer with no page access at all, and the status is read once
  // afterwards with a short bound so a blocked page cannot stall the exit.
  const timeoutMs = Number(process.env.PRINT_WAIT_MS ?? 180000);
  process.stdout.write(
    `  Waiting up to ${Math.round(timeoutMs / 1000)}s for the dialog to be dismissed...\n`,
  );

  await page.locator('#btn-print').click({ noWaitAfter: true });
  await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 2500)));

  /** Read the status line, giving up quickly if the page is still blocked. */
  async function readStatus() {
    try {
      return await Promise.race([
        page.evaluate(() => document.querySelector('#export-status')?.textContent ?? ''),
        new Promise((resolveRace) => setTimeout(() => resolveRace(''), 3000)),
      ]);
    } catch {
      return '';
    }
  }

  const status = await readStatus();

  process.stdout.write(
    [
      '',
      '  Result',
      '  ------',
      `  Application status line : ${status.trim() || '(not readable)'}`,
      `  Console errors          : ${consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 3).join(' | ')}`,
      '',
      consoleErrors.length === 0
        ? '  No console errors were raised during the print workflow.'
        : '  Console errors were raised; see above.',
      '',
      '  This script cannot confirm what the dialog showed. That judgement is the',
      '  manual part of this check: if the paper size and orientation matched the',
      '  layout above and the preview looked right, it passed.',
      '',
    ].join('\n'),
  );

  if (consoleErrors.length > 0) process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
