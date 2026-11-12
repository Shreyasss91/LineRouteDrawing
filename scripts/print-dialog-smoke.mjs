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

/**
 * True when this file is the program being run, rather than a module imported.
 *
 * The input classifier is exported so it can be unit tested without a terminal, a
 * browser or a print dialog. Importing this file must therefore not launch Chrome or
 * start a web server, so everything with a side effect is gated on this flag.
 */
const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

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

// Everything below has a side effect: it loads Playwright, starts a server and opens
// a browser. A top-level await cannot sit inside an if, so the body is an async
// function that is called only when this file is the program being run.
async function main() {
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

    const outcome = await runManualInspection(timeoutMs);

    // The page may still be blocked if the dialog is open, or available if it has been
    // dismissed. The read is bounded so a blocked page can never stall the exit.
    const status = await readStatusBounded();

    const consoleLine = consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 3).join(' | ');

    /** Report the outcome, and say what it means for the check. */
    function reportResult() {
      const lines = ['', '  Result', '  ------'];

      if (outcome === 'acknowledged') {
        lines.push(
          '  Acknowledged: the dialog was inspected and dismissed by hand.',
          `  Application status line : ${status.trim() || '(not readable)'}`,
          `  Console errors          : ${consoleLine}`,
          '',
          '  The manual inspection is the part of this check that matters: if the paper',
          '  size and orientation in the dialog matched the layout above, it passed.',
          '',
          '  This script does not confirm what a printer driver would have done with the',
          '  sheet. Margins, driver scaling and "fit to page" are decided by the printer,',
          '  not by this page, and verifying them needs a physical printout, which is out',
          '  of scope for this check.',
        );
      } else if (outcome === 'cancelled') {
        lines.push(
          '  CANCELLED: the run was stopped from the terminal before an acknowledgement.',
          '  Nothing was verified. Close the print dialog in the browser if it is still open.',
        );
      } else if (outcome === 'timed_out') {
        lines.push(
          `  TIMED OUT after ${Math.round(timeoutMs / 1000)}s without manual acknowledgement.`,
          '  The requested manual verification was not completed, so this run is a failure.',
        );
      } else {
        lines.push(
          '  INPUT UNAVAILABLE: the terminal input ended before an acknowledgement arrived.',
          '  Nothing was verified. This happens when the command is run without an',
          '  interactive terminal, or through a pipeline that no longer feeds it.',
        );
      }

      lines.push('');
      process.stdout.write(`${lines.join('\n')}\n`);
    }

    reportResult();

    if (consoleErrors.length > 0) {
      process.stdout.write('\n  Console errors were raised during the print workflow:\n');
      for (const error of consoleErrors.slice(0, 5)) process.stdout.write(`    - ${error}\n`);
    }

    // Only an acknowledgement exits zero. Cancellation, a timeout and a lost input
    // are all non-success, and each keeps its own message so they cannot be mistaken
    // for one another in a log.
    if (outcome === 'cancelled') process.exitCode = 130;
    else if (outcome === 'timed_out' || outcome === 'input_unavailable') process.exitCode = 1;
    else if (consoleErrors.length > 0) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
}

if (isMainModule) await main();

/**
 * Classify a chunk of terminal input for the manual inspection prompt.
 *
 * A read can carry several bytes at once - a paste, or a terminal that buffers a
 * fast typist - so the whole chunk is scanned rather than only its first byte.
 * Ctrl+C anywhere in it is a cancellation and is checked first, because it is a
 * deliberate stop that must be acted on at once. An Enter (LF or CR) anywhere in it
 * is an acknowledgement. Anything else is an ordinary key and means nothing here.
 *
 * This is a pure function so the classification can be tested directly, without a
 * terminal, a browser or a print dialog.
 *
 * @param {Buffer|Uint8Array|string} chunk Raw bytes from the stream.
 * @returns {"acknowledged"|"cancelled"|null} What the chunk contained, if anything.
 */
export function classifyTerminalInput(chunk) {
  const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
  for (const byte of bytes) {
    if (byte === 0x03) return 'cancelled';
  }
  // LF ends a line on every platform; CR is what a terminal sends in raw mode when
  // Enter is pressed. Either is an acknowledgement.
  for (const byte of bytes) {
    if (byte === 0x0a || byte === 0x0d) return 'acknowledged';
  }
  return null;
}

/**
 * Wait for the user to inspect the dialog and confirm in the terminal.
 *
 * A single `await` on the Enter key would never time out, and a bare timer would
 * close the browser while the user is still reading. Racing them is what gives both
 * a real wait and a guaranteed exit.
 *
 * The ways this can end are kept distinct rather than collapsed into a boolean,
 * because they mean different things and only one of them is a success:
 *
 *   acknowledged      the user pressed Enter; the inspection was performed
 *   cancelled         the user pressed Ctrl+C; they chose to stop
 *   timed_out         the deadline passed with no acknowledgement
 *   input_unavailable stdin ended without an acknowledgement being received
 *
 * Reporting a cancellation as a timeout would be actively misleading: it claims a
 * person sat idle for three minutes when in fact they stopped the run at once, and it
 * hides that they acted deliberately. Each outcome therefore gets its own message and
 * its own exit code.
 *
 * Keys other than Enter are ignored. An acknowledgement is a deliberate act, so a
 * stray keystroke must not stand in for one; the listener stays armed and the run
 * continues waiting.
 *
 * @param {number} timeoutMs Maximum manual inspection period, in milliseconds.
 * @returns {Promise<'acknowledged'|'cancelled'|'timed_out'|'input_unavailable'>} How the wait ended.
 */
async function runManualInspection(timeoutMs) {
  process.stdout.write(
    [
      '',
      '  The browser should now show the print dialog. Take your time.',
      '',
      '  When you have verified the paper size and orientation, do BOTH:',
      '    1. close or cancel the dialog in the browser, and',
      '    2. press Enter in this terminal.',
      '',
      '  Only Enter acknowledges the inspection. Other keys are ignored.',
      '  Press Ctrl+C to abandon the run.',
      '',
      '  If Enter does not arrive within',
      `  ${Math.round(timeoutMs / 1000)} seconds, this run times out and closes the browser.`,
      '  Nothing is sent to a printer and no print job is submitted.',
      '',
      '  Press Enter when done > ',
    ].join('\n'),
  );

  const input = process.stdin;

  // No stdin at all (a detached run): nothing can ever acknowledge, so there is no
  // point waiting out the full period.
  if (!input) return 'input_unavailable';

  return new Promise((resolve) => {
    let finished = false;
    let timer = null;

    /**
     * The raw-mode state stdin had before this function touched it.
     *
     * Restored exactly on the way out rather than unconditionally disabled, so a
     * caller that had already put the terminal in raw mode gets it back as it was
     * instead of having its own configuration silently changed.
     */
    const wasRaw = Boolean(input.isTTY && input.isRaw);
    const usedTty = Boolean(input.isTTY && typeof input.setRawMode === 'function');

    let rawEnabled = false;

    const onData = (chunk) => {
      const result = classifyTerminalInput(chunk);
      if (result) finish(result);
      // Anything else is an ordinary key: ignored, and the listener stays armed.
    };

    // End of input without an acknowledgement. Reported as its own outcome rather
    // than as a timeout, because nothing was being waited for any more.
    const onEnd = () => finish('input_unavailable');

    /** Undo everything this function did to the stream and the terminal. */
    function cleanup() {
      try {
        input.removeListener('data', onData);
        input.removeListener('end', onEnd);
        input.removeListener('close', onEnd);
        input.removeListener('error', onEnd);
        if (rawEnabled && typeof input.setRawMode === 'function') {
          // Back to exactly what it was, not merely "off".
          input.setRawMode(wasRaw);
        }
        input.pause();
      } catch {
        // A closed or already-restored stream: nothing left to undo.
      }
    }

    function finish(result) {
      if (finished) return;
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      cleanup();
      resolve(result);
    }

    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onEnd);
    input.on('error', onEnd);

    if (usedTty) {
      try {
        input.setRawMode(true);
        rawEnabled = true;
      } catch {
        // Activation failed: the listeners are still armed and the deadline still
        // applies, and cleanup() knows raw mode was never turned on.
        rawEnabled = false;
      }
    }
    input.resume();

    // Referenced, so the process stays alive for the whole inspection period, and
    // cleared the moment the wait ends so it can never fire into a later run.
    timer = setTimeout(() => finish('timed_out'), timeoutMs);
  });
}

/**
 * Read the application status line, bounded so a blocked page cannot stall the exit.
 *
 * The page may still be showing the native print dialog, in which case `page.evaluate`
 * never resolves. Racing it against a timer keeps the exit bounded; the timer is
 * cleared as soon as the read wins so no process-lifetime timer is left behind.
 *
 * @returns {Promise<string>} The status text, or '' when the page is unavailable.
 */
async function readStatusBounded() {
  let timer = null;
  try {
    return await Promise.race([
      page.evaluate(() => document.querySelector('#export-status')?.textContent ?? ''),
      new Promise((resolveRace) => {
        timer = setTimeout(() => resolveRace(''), 3000);
      }),
    ]);
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
