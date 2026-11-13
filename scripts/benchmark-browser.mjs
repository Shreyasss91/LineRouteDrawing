/**
 * Browser-side performance baseline for the drawing pipeline.
 *
 * Complements `npm run benchmark`: the Node measurement covers everything that is
 * DOM-free, and this one covers what only a browser can show - how long the real
 * application takes to put a drawing on screen, and what a recompute costs after a
 * real edit. It drives the actual page (the same one a user opens) rather than a
 * harness copy of it, so the numbers include the work the application really does.
 *
 * Run:
 *   npm run benchmark:browser
 *   npm run benchmark:browser -- --json out.json
 *
 * Requirements are the same as `npm run test:browser`: Playwright plus a browser.
 * By default it uses the installed Google Chrome via `channel: 'chrome'`; set
 * BROWSER_CHANNEL to override.
 *
 * What this is NOT: a threshold or a service level. Nothing in the test suite reads
 * these numbers. See documentation/11-performance-baseline.md.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scenarios, describeScenario, widestRoute, MAX_ROUTE_SPANS } from './benchmark-datasets.mjs';
import { serializeProjectJson } from '../src/ui/project.js';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = Number(process.env.BENCH_PORT ?? 8210);
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 20);
const STORAGE_KEY = 'line-route-drawing:v3:project';

/** Load Playwright the same way the browser test suite does. */
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return require('playwright');
  }
}

/** Wait until the server answers, so the first navigation is not a retry. */
async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`the benchmark server did not start on ${url}`);
}

/**
 * The in-page measurement.
 *
 * Runs inside the real page, using the application's own modules. Every phase is
 * measured after a warm-up and reported as median/p95 by the shared timer, so the
 * two benchmarks describe their numbers the same way.
 */
async function measureInPage(page, iterations) {
  return page.evaluate(async (runs) => {
    const { timeIt } = await import('./scripts/benchmark-timer.mjs');
    const { buildNetwork } = await import('./src/geometry/network.js');
    const { buildAssetRegistry } = await import('./src/geometry/assets.js');
    const { buildScene } = await import('./src/geometry/scene.js');
    const { buildAnnotationLayer } = await import('./src/geometry/annotation_layer.js');
    const { renderSceneToSvg } = await import('./src/render/svg.js');
    const { composeMiniPreview, fitViewBox, buildDesignationOverlay } = await import(
      './src/ui/mini_preview.js'
    );
    const { parseProjectJson, serializeProjectJson, toProjectPayload } = await import(
      './src/ui/project.js'
    );

    // The scenario the page is currently showing, reconstructed from the saved document
    // so the benchmark measures the same drawing the application just drew.
    const raw = localStorage.getItem('line-route-drawing:v3:project');
    const parsed = parseProjectJson(raw);
    const project = parsed.project;
    const data = {
      loads: project.loads,
      spanLengths: project.spanLengths,
      loadPlacements: project.loadPlacements,
      spanPlacements: project.spanPlacements,
    };

    const network = buildNetwork(project.routes);
    const registry = buildAssetRegistry(network);
    const scene = buildScene(network, 'preview', { spanLength: project.spanLength }, data);

    const options = { iterations: runs };
    return {
      'parse project': timeIt(() => parseProjectJson(raw), options),
      'build network': timeIt(() => buildNetwork(project.routes), options),
      'build scene': timeIt(
        () => buildScene(network, 'preview', { spanLength: project.spanLength }, data),
        options,
      ),
      // Same primitives, same profile object the scene resolved, so the placement cost
      // is isolated instead of being hidden inside the scene build.
      'place annotations': timeIt(
        () =>
          buildAnnotationLayer({
            network,
            profile: scene.profile,
            config: scene.config,
            lines: scene.lines,
            poles: scene.poles,
            tc: scene.tc,
            fpb: scene.fpb,
            labels: scene.labels,
            labelSlots: scene.labelSlots,
            width: scene.width,
            height: scene.height,
            padding: scene.padding,
            data,
          }),
        options,
      ),
      'render main svg': timeIt(() => renderSceneToSvg(scene, { standalone: false }), options),
      'render mini svg': timeIt(
        () =>
          composeMiniPreview({
            sceneSvg: renderSceneToSvg(scene, { standalone: false }),
            viewBox: fitViewBox(scene),
            // The overlay is empty in the benchmark: what is being measured is the second
            // render of the drawing plus the splicing, not the designation text, which the
            // application computes from the panel's measured size.
            overlay: buildDesignationOverlay({
              nodes: [],
              positions: new Map(),
              config: scene.config,
              escapeText: (text) => String(text),
            }),
            ring: '',
          }),
        options,
      ),
      'serialize project': timeIt(() => serializeProjectJson(toProjectPayload(project)), options),
      counts: {
        nodes: network.graph.nodes.size,
        edges: network.graph.edges.size,
        assets: [...registry.allNodeAssets()].length,
        callouts: scene.annotations?.callouts?.length ?? 0,
        spanLabels: scene.annotations?.spans?.length ?? 0,
        obstacles: scene.annotations?.obstacles?.length ?? 0,
      },
      hitAreas: document.querySelectorAll('#hit-areas > *').length,
      svgBytes: document.querySelector('#preview-canvas svg')?.outerHTML.length ?? 0,
    };
  }, iterations);
}

/**
 * Time one recompute cycle in the real application.
 *
 * A recompute is what happens after any edit: the network, the scene, the annotations,
 * the SVG, the hit areas, the view transform and the compact reference are all rebuilt.
 * It is triggered here through the spacing control, which is a real user action.
 *
 * Two figures are reported, because they answer different questions:
 *
 *   - **rebuild** - the synchronous work the dispatch causes. This is the part the
 *     developer controls.
 *   - **rebuild + frame** - the same, plus the wait for the browser to paint. This is
 *     closer to what a user waits for, but it carries a 16.7 ms frame floor on a 60 Hz
 *     display that has nothing to do with the application, so it is reported beside the
 *     rebuild figure rather than instead of it.
 */
async function measureRecompute(page, runs) {
  return page.evaluate(async (count) => {
    const input = document.querySelector('#field-spacing');
    const summarize = (samples) => {
      samples.sort((a, b) => a - b);
      const at = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
      return {
        median: at(0.5),
        p95: at(0.95),
        min: samples[0],
        max: samples[samples.length - 1],
        iterations: samples.length,
      };
    };

    const setSpacing = (value) => {
      input.value = String(value);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // Warm up on the same control, so the measured runs do not pay for first use.
    for (let i = 0; i < 3; i += 1) {
      setSpacing(i % 2 === 0 ? 41 : 40);
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    }

    const rebuild = [];
    const painted = [];
    for (let i = 0; i < count; i += 1) {
      const value = i % 2 === 0 ? 41 : 40;
      input.value = String(value);
      const start = performance.now();
      input.dispatchEvent(new Event('change', { bubbles: true }));
      rebuild.push(performance.now() - start);
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      painted.push(performance.now() - start);
    }
    return { rebuild: summarize(rebuild), painted: summarize(painted) };
  }, runs);
}

function environment() {
  const cpus = os.cpus();
  return {
    runtime: 'browser',
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: cpus.length ? cpus[0].model.trim() : 'unknown',
    cpuCount: cpus.length,
    totalMemoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    iterations: ITERATIONS,
  };
}

async function main() {
  const jsonIndex = process.argv.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : null;

  const playwright = await loadPlaywright();
  const server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
  });

  let browser;
  try {
    await waitForServer(BASE);
    browser = await playwright.chromium.launch({
      channel: process.env.BROWSER_CHANNEL || 'chrome',
    });
    const page = await browser.newPage();

    const browserInfo = await (async () => {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      return page.evaluate(() => ({
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
        deviceMemoryGb: navigator.deviceMemory ?? null,
      }));
    })();

    const report = {
      environment: { ...environment(), ...browserInfo },
      generatedAt: new Date().toISOString(),
      scenarios: [],
    };

    for (const scenario of scenarios()) {
      const doc = serializeProjectJson(scenario.project, {
        savedAt: new Date('2026-01-01T00:00:00Z'),
      });

      await page.evaluate(
        ({ key, text }) => {
          localStorage.clear();
          localStorage.setItem(key, text);
        },
        { key: STORAGE_KEY, text: doc },
      );

      // Cold start: from the navigation to the first complete drawing on screen. This
      // includes booting the application and restoring the project, which no steady
      // state phase measures.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#preview-canvas svg', { timeout: 60000 });
      const readyAt = await page.evaluate(() => performance.now());
      await page.waitForTimeout(150);

      const phases = await measureInPage(page, ITERATIONS);
      const recompute = await measureRecompute(page, Math.max(5, Math.round(ITERATIONS / 2)));

      report.scenarios.push({
        name: scenario.name,
        description: scenario.description,
        counts: describeScenario(scenario.project),
        widestRoute: widestRoute(scenario.project),
        dom: {
          callouts: phases.counts.callouts,
          spanLabels: phases.counts.spanLabels,
          obstacles: phases.counts.obstacles,
          hitAreas: phases.hitAreas,
          svgBytes: phases.svgBytes,
        },
        initialReadyMs: Number(readyAt.toFixed(3)),
        phases: {
          'parse project': phases['parse project'],
          'build network': phases['build network'],
          'build scene': phases['build scene'],
          'place annotations': phases['place annotations'],
          'render main svg': phases['render main svg'],
          'render mini svg': phases['render mini svg'],
          'serialize project': phases['serialize project'],
        },
        recompute,
      });
    }

    console.log('Performance baseline (browser) - median / p95 in ms');
    console.log(`${ITERATIONS} measured iterations per phase after 3 warm-up runs\n`);
    console.log(`  Chrome ${report.environment.userAgent}`);
    console.log(
      `  ${report.environment.cpu}, ${report.environment.cpuCount} cores, ` +
        `${report.environment.totalMemoryGb} GB, Node ${report.environment.nodeVersion} ` +
        `on ${report.environment.platform}\n`,
    );

    const labels = [
      'parse project',
      'build network',
      'build scene',
      'place annotations',
      'render main svg',
      'render mini svg',
      'serialize project',
    ];
    const width = Math.max(...labels.map((l) => l.length)) + 2;
    const nameWidth = 22;
    console.log(`${''.padEnd(width)}${report.scenarios.map((s) => s.name.padEnd(nameWidth)).join('')}`);
    for (const label of labels) {
      const cells = report.scenarios.map((s) =>
        `${s.phases[label].median.toFixed(3)} / ${s.phases[label].p95.toFixed(3)}`.padEnd(nameWidth),
      );
      console.log(`${label.padEnd(width)}${cells.join('')}`);
    }
    const rebuildCells = report.scenarios.map((s) =>
      `${s.recompute.rebuild.median.toFixed(2)} / ${s.recompute.rebuild.p95.toFixed(2)}`.padEnd(nameWidth),
    );
    console.log(`${'recompute rebuild'.padEnd(width)}${rebuildCells.join('')}`);
    const paintedCells = report.scenarios.map((s) =>
      `${s.recompute.painted.median.toFixed(2)} / ${s.recompute.painted.p95.toFixed(2)}`.padEnd(nameWidth),
    );
    console.log(`${'recompute + frame'.padEnd(width)}${paintedCells.join('')}`);
    const readyCells = report.scenarios.map((s) => `${s.initialReadyMs.toFixed(1)}`.padEnd(nameWidth));
    console.log(`${'cold start to drawing'.padEnd(width)}${readyCells.join('')}`);

    console.log('');
    for (const scenario of report.scenarios) {
      const c = scenario.counts;
      console.log(
        `${scenario.name}: ${c.routes} routes, ${c.spans} spans, ${c.nodes} nodes, ` +
          `${c.loads} loads, ${c.measuredSpans} measured spans; ` +
          `${scenario.dom.callouts} callouts, ${scenario.dom.spanLabels} span labels, ` +
          `${scenario.dom.obstacles} obstacles, ${scenario.dom.hitAreas} hit areas, ` +
          `${scenario.dom.svgBytes} svg chars`,
      );
    }
    console.log('');
    console.log(
      `Every route is within MAX_ROUTE_SPANS (${MAX_ROUTE_SPANS}); widest is ` +
        `${Math.max(...report.scenarios.map((s) => s.widestRoute))}.`,
    );

    if (jsonPath) {
      writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`\nWrote ${jsonPath}`);
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
