/**
 * Node-side performance baseline for the drawing pipeline.
 *
 * Measures the phases that have nothing to do with the DOM - parsing, the network,
 * the scene, annotation placement, the two SVG renderers, serialization - on four
 * fixed drawings. The browser-only parts (mounting, hit areas, the recompute cycle
 * after a real edit) are measured by `npm run benchmark:browser`, because they cannot
 * be observed without a document.
 *
 * Run:
 *   npm run benchmark                 the table, on this machine
 *   npm run benchmark -- --json out.json   also write the raw numbers
 *
 * What this is NOT: a threshold, a target or a service level. There is no pass/fail
 * here and nothing in the normal test suite depends on these numbers. It is a
 * reproducible measurement so that "is this slower than before" can be answered with
 * data instead of an impression. See documentation/11-performance-baseline.md.
 */

import { writeFileSync } from 'node:fs';
import os from 'node:os';

import {
  scenarios,
  describeScenario,
  widestRoute,
  scalingChainRoutes,
  MAX_ROUTE_SPANS,
} from './benchmark-datasets.mjs';
import { timeIt, table } from './benchmark-timer.mjs';
import { buildNetwork } from '../src/geometry/network.js';
import { buildScene } from '../src/geometry/scene.js';
import { buildAnnotationLayer } from '../src/geometry/annotation_layer.js';
import { renderSceneToSvg } from '../src/render/svg.js';
import { composeMiniPreview, fitViewBox } from '../src/ui/mini_preview.js';
import {
  parseProjectJson,
  serializeProjectJson,
  toProjectPayload,
} from '../src/ui/project.js';

const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 25);

/** The project as the application would write it, once. */
function projectText(project) {
  return serializeProjectJson(project, { savedAt: new Date('2026-01-01T00:00:00Z') });
}

/** Environment facts, so a number can be attributed to a machine. */
function environment() {
  const cpus = os.cpus();
  return {
    runtime: 'node',
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: cpus.length ? cpus[0].model.trim() : 'unknown',
    cpuCount: cpus.length,
    totalMemoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    iterations: ITERATIONS,
  };
}

/** Measure one scenario, phase by phase. */
function measure(project) {
  const text = projectText(project);
  const parsed = parseProjectJson(text);

  // The scene is built once up front: every later phase runs on its real output rather
  // than on a stand-in, and the phases stay independent of each other's timings.
  const network = buildNetwork(project.routes);
  const scene = buildScene(network, 'preview', { spanLength: project.spanLength }, {
    loads: project.loads,
    spanLengths: project.spanLengths,
    loadPlacements: project.loadPlacements,
    spanPlacements: project.spanPlacements,
  });

  return {
    // Project parsing: text -> validated, migrated project. This is what "opening a
    // project" costs before any geometry happens.
    'parse project': timeIt(() => parseProjectJson(text), { iterations: ITERATIONS }),
    // Routes -> graph, endpoints, coordinates.
    'build network': timeIt(() => buildNetwork(project.routes), { iterations: ITERATIONS }),
    // Graph -> drawable primitives, which includes the annotation layer internally.
    'build scene': timeIt(
      () =>
        buildScene(network, 'preview', { spanLength: project.spanLength }, {
          loads: project.loads,
          spanLengths: project.spanLengths,
          loadPlacements: project.loadPlacements,
          spanPlacements: project.spanPlacements,
        }),
      { iterations: ITERATIONS },
    ),
    // Annotation placement on its own, re-run against the same primitives the scene
    // already produced. This is the phase suspected of being superlinear, so it gets a
    // row of its own instead of being buried inside "build scene".
    'place annotations': timeIt(
      () =>
        buildAnnotationLayer({
          network,
          // The RESOLVED profile from the scene, not the name: `buildAnnotationLayer`
          // reads `profile.showAnnotations`, and a bare string would make it return an
          // empty layer without doing any work - which would have measured nothing while
          // reporting a very impressive 0.000 ms.
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
          data: {
            loads: project.loads,
            spanLengths: project.spanLengths,
            loadPlacements: project.loadPlacements,
            spanPlacements: project.spanPlacements,
          },
        }),
      { iterations: ITERATIONS },
    ),
    // The main drawing SVG: markup generation, no DOM.
    'render main svg': timeIt(() => renderSceneToSvg(scene, { standalone: false }), {
      iterations: ITERATIONS,
    }),
    // The compact reference copy, which is a second render of the same scene.
    'render mini svg': timeIt(
      () =>
        composeMiniPreview({
          sceneSvg: renderSceneToSvg(scene, { standalone: false }),
          viewBox: fitViewBox(scene),
          overlay: '',
          ring: '',
        }),
      { iterations: ITERATIONS },
    ),
    // Writing the file back out.
    'serialize project': timeIt(() => serializeProjectJson(toProjectPayload(project)), {
      iterations: ITERATIONS,
    }),
    // Everything a full open costs in Node, end to end.
    'full pipeline': timeIt(() => {
      const reopened = parseProjectJson(text);
      const built = buildScene(
        buildNetwork(reopened.project.routes),
        'preview',
        { spanLength: reopened.project.spanLength },
        {
          loads: reopened.project.loads,
          spanLengths: reopened.project.spanLengths,
          loadPlacements: reopened.project.loadPlacements,
          spanPlacements: reopened.project.spanPlacements,
        },
      );
      return renderSceneToSvg(built, { standalone: false });
    }, { iterations: Math.max(5, Math.round(ITERATIONS / 5)) }),
    _scene: { width: Math.round(scene.width), height: Math.round(scene.height), parsed: parsed.ok },
  };
}

/**
 * How annotation placement scales with the number of annotations.
 *
 * The four fixed drawings say what a drawing costs; they do not say how that cost
 * grows. This measured doubling series answers the second question: a chain is grown
 * from 50 to 800 spans and the placement phase is timed at each size. Linear work would
 * double with each step; the ratios printed beside each row say what actually happened.
 *
 * Reported because it is the evidence behind the scale conclusion in
 * documentation/11-performance-baseline.md, and it should be re-derivable rather than
 * taken on trust.
 */
function scaling() {
  const emptyData = { loads: [], spanLengths: {}, loadPlacements: {}, spanPlacements: {} };
  console.log('Annotation placement vs drawing size (Node, median of 5 after 2 warm-up runs)');
  console.log('');
  console.log('  spans   placement   per span   ratio vs half');
  let previous = null;
  const rows = [];
  for (const size of [50, 100, 200, 400, 800]) {
    const routes = scalingChainRoutes(size);
    const network = buildNetwork(routes);
    const scene = buildScene(network, 'preview', { spanLength: 40 }, emptyData);
    const result = timeIt(
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
          data: emptyData,
        }),
      { warmup: 2, iterations: 5 },
    );
    const ratio = previous ? result.median / previous : null;
    console.log(
      `  ${String(size).padEnd(7)} ${result.median.toFixed(2).padStart(7)} ms  ` +
        `${((result.median / size) * 1000).toFixed(1).padStart(7)} us  ` +
        `${ratio ? `x${ratio.toFixed(2)}` : '-'}`,
    );
    rows.push({ spans: size, median: result.median, ratio });
    previous = result.median;
  }
  return rows;
}

function main() {
  if (process.argv.includes('--scaling')) {
    scaling();
    return;
  }

  const jsonIndex = process.argv.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : null;

  const rows = [];
  const report = { environment: environment(), generatedAt: new Date().toISOString(), scenarios: [] };

  for (const scenario of scenarios()) {
    const counts = describeScenario(scenario.project);
    const results = measure(scenario.project);
    const meta = results._scene;
    delete results._scene;
    rows.push({ name: scenario.name, results });
    report.scenarios.push({
      name: scenario.name,
      description: scenario.description,
      counts,
      widestRoute: widestRoute(scenario.project),
      scene: meta,
      phases: results,
    });
  }

  const labels = [
    'parse project',
    'build network',
    'build scene',
    'place annotations',
    'render main svg',
    'render mini svg',
    'serialize project',
    'full pipeline',
  ];

  console.log('Performance baseline (Node) - median / p95 in ms, steady state');
  console.log(`${ITERATIONS} measured iterations per phase after 3 warm-up runs\n`);
  const env = report.environment;
  console.log(`  Node ${env.nodeVersion} on ${env.platform} (${env.arch})`);
  console.log(`  ${env.cpu}, ${env.cpuCount} cores, ${env.totalMemoryGb} GB\n`);

  for (const scenario of report.scenarios) {
    const c = scenario.counts;
    console.log(
      `${scenario.name}: ${c.routes} routes, ${c.spans} spans, ${c.nodes} nodes, ` +
        `${c.edges} edges, ${c.loads} loads, ${c.measuredSpans} measured spans; ` +
        `scene ${scenario.scene.width}x${scenario.scene.height}px`,
    );
  }
  console.log('');
  console.log(table(labels, rows));
  console.log('');
  console.log(
    `Every route is within MAX_ROUTE_SPANS (${MAX_ROUTE_SPANS}); widest is ` +
      `${Math.max(...report.scenarios.map((s) => s.widestRoute))}.`,
  );

  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nWrote ${jsonPath}`);
  }
}

main();
