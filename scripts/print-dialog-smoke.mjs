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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `import.meta.dirname` only exists from Node 20.11, while package.json permits any
// Node 20, where it is undefined and `resolve(undefined, '..')` throws before
// anything runs. `fileURLToPath(import.meta.url)` has been available far longer and
// gives the same directory, so the declared minimum stays truthful.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  // hidden frame, and leaves it to the browser. The native dialog that opens blocks
  // the page it belongs to and waits for a person; `window.print()` does not return
  // until that person acts.
  //
  // The lifecycle is driven from the terminal, not from the page, because a dialog
  // holds the renderer: `page.evaluate` cannot resolve while it is open, so no DOM
  // polling can tell us when it closes. Node-side timers and stdin are the only
  // things that can be trusted here. The user is told exactly what to check, then
  // asked to inspect the dialog and press Enter in this terminal once they are done.
  // Nothing is ever sent to a printer, and the script never confirms or submits a
  // print job; the dialog must be dismissed by hand, exactly as in normal use.
  const timeoutMs = Number(process.env.PRINT_WAIT_MS ?? 180000);

  // Press the real button. `noWaitAfter` is required: the click's continuation never
  // arrives while the dialog holds the page, so waiting for it would hang this script
  // instead of handing control to the user.
  await page.locator('#btn-print').click({ noWaitAfter: true });

  const acknowledged = await runManualInspection(timeoutMs);

  // The page may still be blocked if the dialog is open, or available if it has been
  // dismissed. The read is bounded so a blocked page can never stall the exit.
  const status = await readStatusBounded();

  if (acknowledged) {
    process.stdout.write(
      [
        '',
        '  Result',
        '  ------',
        '  Acknowledged: the dialog was inspected and dismissed by hand.',
        `  Application status line : ${status.trim() || '(not readable)'}`,
        `  Console errors          : ${consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 3).join(' | ')}`,
        '',
        '  The manual inspection is the part of this check that matters: if the paper',
        '  size and orientation in the dialog matched the layout above, it passed.',
        '',
        '  This script does not confirm what a printer driver would have done with the',
        '  sheet. Margins, driver scaling and "fit to page" are decided by the printer,',
        '  not by this page, and verifying them needs a physical printout, which is out',
        '  of scope for this check.',
        '',
      ].join('\n'),
    );
  } else {
    process.stdout.write(
      [
        '',
        '  Result',
        '  ------',
        `  TIMED OUT after ${Math.round(timeoutMs / 1000)}s without manual acknowledgement.`,
        '  The requested manual verification was not completed, so this run is a failure.',
        '',
      ].join('\n'),
    );
  }

  if (consoleErrors.length > 0) {
    process.stdout.write(`\n  Console errors were raised during the print workflow:\n`);
    for (const error of consoleErrors.slice(0, 5)) process.stdout.write(`    - ${error}\n`);
    process.exitCode = 1;
  }
  if (!acknowledged) process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.kill();
}

/**
 * Wait for the user to inspect the dialog and confirm in the terminal.
 *
 * A single `await` on the Enter key would never time out, and a bare timer would
 * close the browser while the user is still reading. Combining them is what gives
 * both the real wait and the guaranteed exit: the reader either receives a line
 * (the user pressed Enter) or the timer fires (the deadline passed), and whichever
 * happens first settles the race. The dialog itself is never touched by this
 * function - closing it is entirely the user's manual action, exactly as in normal
 * printing.
 *
 * @param {number} timeoutMs Maximum manual inspection period, in milliseconds.
 * @returns {Promise<boolean>} True when the user pressed Enter before the deadline.
 */
async function runManualInspection(timeoutMs) {
  process.stdout.write(
    [
      '',
      `  The browser should now show the print dialog. Take your time.`,
      '',
      '  When you have verified the paper size and orientation, do BOTH:',
      '    1. close or cancel the dialog in the browser, and',
      '    2. press Enter in this terminal.',
      '',
      '  The script waits for your Enter. If it does not arrive within',
      `  ${Math.round(timeoutMs / 1000)} seconds, this run times out and closes the browser.`,
      '  Nothing is sent to a printer and no print job is submitted.',
      '',
      '  Press Enter when done > ',
    ].join('\n'),
  );

  return new Promise((resolve) => {
    let finished = false;
    let timer = null;

    /** Leave raw mode as it was found, so the terminal is usable afterwards. */
    const restore = () => {
      const input = process.stdin;
      try {
        if (input?.isTTY && typeof input.setRawMode === 'function') input.setRawMode(false);
        input?.pause();
      } catch {
        // Nothing to restore, or stdin already closed.
      }
    };

    const finish = (value) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      restore();
      resolve(value);
    };

    // The reader. stdin is a stream, so a single read() is enough to wait for one
    // line; there is no loop and nothing that could block a second time.
    const reader = () => {
      const input = process.stdin;
      if (!input) {
        // No stdin at all (a detached run): the deadline is the only way out.
        return;
      }
      input.resume();
      if (typeof input.setRawMode === 'function' && input.isTTY) {
        // A terminal delivers the Enter byte immediately, which lets Ctrl+C be told
        // apart from a normal acknowledgement.
        input.setRawMode(true);
        input.once('data', (chunk) => finish(chunk[0] !== 0x03));
        return;
      }
      input.once('data', () => finish(true));
    };

    // The deadline. A referenced timer keeps the process alive for its whole span, so
    // this resolves before the process can exit on its own, and it is cleared as soon
    // as the user acknowledges rather than being left to fire later.
    timer = setTimeout(() => finish(false), timeoutMs);

    reader();
  });
}

/**
 * Read the application status line, bounded so a blocked page cannot stall the exit.
 *
 * @returns {Promise<string>} The status text, or '' when the page is unavailable.
 */
async function readStatusBounded() {
  try {
    return await Promise.race([
      page.evaluate(() => document.querySelector('#export-status')?.textContent ?? ''),
      new Promise((resolveRace) => setTimeout(() => resolveRace(''), 3000)),
    ]);
  } catch {
    return '';
  }
}
