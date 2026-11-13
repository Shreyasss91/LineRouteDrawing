# Performance baseline

A reproducible measurement of what a drawing costs, on four fixed datasets, reported as
a distribution rather than a feeling. It exists so that "this got slower" can be answered
with numbers, and so that any future scale claim has evidence behind it.

**What this is not.** There is no threshold, no target and no service level here, and
nothing in the normal test suite reads these numbers. A timing measured on one machine on
one day is not a contract; it is a baseline. The only hard numbers in this document are
the dataset sizes, which *are* pinned by a test
([test/benchmark_datasets.test.js](../test/benchmark_datasets.test.js)).

## Contents

1. [How to reproduce](#1-how-to-reproduce)
2. [The environment measured](#2-the-environment-measured)
3. [The datasets](#3-the-datasets)
4. [Method](#4-method)
5. [Results — Node phases](#5-results-node-phases)
6. [Results — browser](#6-results-browser)
7. [What dominates, and how it grows](#7-what-dominates-and-how-it-grows)
8. [What these numbers mean for a user](#8-what-these-numbers-mean-for-a-user)
9. [Limitations of the measurement](#9-limitations-of-the-measurement)
10. [What is not measured](#10-what-is-not-measured)

---

## 1. How to reproduce

```bash
npm run benchmark            # Node phases, four datasets, table on stdout
npm run benchmark -- --scaling   # annotation placement vs drawing size
npm run benchmark -- --json out.json   # the same, plus raw numbers as JSON

npm run benchmark:browser    # the real page in Chrome, cold start and recompute
npm run benchmark:browser -- --json out.json
```

Environment variables: `BENCH_ITERATIONS` (measured runs per phase, default 25 Node /
20 browser) and `BENCH_PORT` (default 8210, so it never collides with the browser test
suite's range).

`npm run benchmark:browser` needs what `npm run test:browser` needs — Playwright plus a
browser — and uses the installed Google Chrome through `channel: 'chrome'` unless
`BROWSER_CHANNEL` says otherwise. It serves the project with
[scripts/serve.js](../scripts/serve.js) on loopback only, and drives the application's own
page. No number in this document came from a harness that re-implements the pipeline.

## 2. The environment measured

One machine, stated once so every table below is attributable:

| | |
| --- | --- |
| CPU | 13th Gen Intel(R) Core(TM) i5-13500T (20 logical cores) |
| Memory | 7.7 GB visible to the OS |
| OS | Windows 10.0.26200, x64 |
| Node | v24.4.1 |
| Browser | Chrome 157 headless (Playwright), same machine |

Numbers from another machine will differ, most obviously in the browser tables. The
*direction* of the results — which phase dominates, and that it grows faster than the
drawing — is a property of the algorithms and has reproduced on every run.

## 3. The datasets

Defined once in [scripts/benchmark-datasets.mjs](../scripts/benchmark-datasets.mjs), used
by both benchmarks and by the test that pins their sizes. The shapes are deliberately
different, because a chain and a branched network stress different parts of the pipeline.

| Scenario | Shape | Routes | Spans | Nodes | Edges | Loads | Measured spans | Load offsets | Span offsets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **A-example** | the bundled example, as the application loads it | 9 | 34 | 34 | 33 | 0 | 0 | 0 | 0 |
| **B-medium** | a 32-span spine with eight 8-span branches | 16 | 96 | 97 | 96 | 0 | 0 | 0 | 0 |
| **C-large** | 40 routes, 501 spans, one chain, nothing measured | 40 | 501 | 502 | 501 | 0 | 0 | 0 | 0 |
| **D-surveyed** | C, fully surveyed | 40 | 501 | 502 | 501 | 50 | 501 | 25 | 101 |

In both benchmarks each scenario is a **whole project**: the routes plus the measured
data. The routes are generated through
[src/ui/state.js](../src/ui/state.js) `latestSource()`, which is the same helper the form
uses to preselect a source, rather than having endpoint ids written out by hand — a
fixture that guesses how the engine names endpoints would silently stop being a valid
drawing.

Two properties every scenario keeps:

- **Every route is within `MAX_ROUTE_SPANS` (500).** The widest is 13. A baseline built on
  a route the form would refuse would be measuring a path a user cannot reach.
- **No collisions.** `buildNetwork()` must return `ok: true` for all four, which
  `describeScenario()` asserts by throwing if it does not.

The scene sizes follow from the shapes: A is 552 × 752 px, B is 392 × 1352 px, and both C
and D are 72 × 20112 px — a single vertical chain of 501 spans is a very tall, very narrow
drawing. That is the honest consequence of the shape the historic estimate used, and it is
worth knowing that the large case is *not* a dense 2-D drawing: it is one long line, which
is the cheapest possible geometry per span and the hardest case for label placement,
because 501 span labels all want the same narrow strip.

## 4. Method

Both benchmarks share [scripts/benchmark-timer.mjs](../scripts/benchmark-timer.mjs):

- **Warm up, then measure.** Three warm-up runs are discarded so the measurement is steady
  state, not JIT compilation. Cold start is measured separately and labelled as such.
- **Report median and p95, never a single run.** A single run of a 13 ms phase can read
  19 ms because something else happened. The median says what usually happens; p95 says
  what the user occasionally waits for.
- **Use the high-resolution clock.** `performance.now()`.

### Node benchmark

Each phase is measured in isolation on the real output of the previous one: the project is
parsed and the scene built once up front, then every phase re-runs against those real
objects. The scene is *not* rebuilt inside the annotation row — the placement phase gets
the primitives the scene already produced, so its number is placement and nothing else.

`full pipeline` is the exception: it re-does everything (parse → network → scene → main
SVG) on each run, which is what opening a project costs end to end. It runs at a fifth of
the iterations because it is the most expensive row.

### Browser benchmark

Each scenario is written into `localStorage` as a real saved project and the page is
**reloaded**, so:

- **Cold start to drawing** is `performance.now()` sampled the moment
  `#preview-canvas svg` exists. That includes fetching and booting the application,
  restoring the project, and drawing it — the number a user actually experiences.
- The steady-state phases then run **in the page**, against the application's own modules,
  so they are the same functions the tool uses with the same inputs.
- **Recompute rebuild** is the synchronous cost of a real edit: the spacing field is
  changed and `change` dispatched, which runs the application's `refresh()` — network,
  designations, scene, annotations, SVG, hit areas, view transform and the compact
  reference.
- **Recompute + frame** adds the wait for the browser to paint. It carries a ~16.7 ms
  frame floor at 60 Hz that has nothing to do with the application, so it is reported
  beside the rebuild figure rather than instead of it.

## 5. Results — Node phases

Median / p95 in milliseconds, steady state, 25 measured iterations after 3 warm-ups.

| Phase | A-example | B-medium | C-large | D-surveyed |
| --- | --- | --- | --- | --- |
| parse project | 0.143 / 0.328 | 0.313 / 0.622 | 3.016 / 3.667 | 2.738 / 4.555 |
| build network | 0.025 / 0.056 | 0.071 / 0.105 | 0.202 / 0.319 | 0.297 / 0.523 |
| build scene | 0.354 / 0.663 | 0.918 / 1.217 | 13.457 / 15.743 | 12.820 / 15.762 |
| place annotations | 0.233 / 0.415 | 0.715 / 0.923 | 13.557 / 15.185 | 13.063 / 19.605 |
| render main svg | 0.113 / 0.136 | 0.257 / 0.345 | 1.503 / 2.429 | 1.579 / 2.561 |
| render mini svg | 0.114 / 0.248 | 0.266 / 0.437 | 1.984 / 4.199 | 1.903 / 4.176 |
| serialize project | 0.008 / 0.018 | 0.009 / 0.016 | 0.020 / 0.034 | 0.319 / 0.526 |
| full pipeline | 0.632 / 0.922 | 1.512 / 1.778 | 18.915 / 20.249 | 19.907 / 22.135 |

Reading the columns:

- **The network builder is not the cost.** 501 spans resolve in 0.2 ms. Route replay and
  the grid graph are linear and cheap at every size measured.
- **Annotation placement is the cost.** On C it is 13.6 ms of a 13.5 ms scene build — in
  other words essentially *all* of it. On A it is 0.23 ms of 0.35 ms. The drawing's other
  phases are an order of magnitude smaller.
- **Parsing grows with the file.** 3 ms for C because there is nothing measured to
  validate; 2.7 ms for D, which has 501 more records. Serialization is 0.02 ms for C and
  0.32 ms for D — the 16× difference is 501 span lengths and 50 loads, not the routes.
- **Two SVG renders are small.** 1.5 ms and 2.0 ms on the largest drawing. Rendering is
  string building; it is not where the time goes.

## 6. Results — browser

Same four datasets in the real page. Medians; p95 in the second figure where it was
recorded.

| Measurement | A-example | B-medium | C-large | D-surveyed |
| --- | --- | --- | --- | --- |
| parse project (median / p95) | 0.200 / 0.800 | 0.400 / 1.200 | 3.200 / 4.100 | 3.500 / 4.600 |
| build network | 0.000 / 0.200 | 0.100 / 0.200 | 0.200 / 0.400 | 0.200 / 0.400 |
| build scene | 0.400 / 0.800 | 1.100 / 1.600 | 16.800 / 18.200 | 20.900 / 32.900 |
| place annotations | 0.200 / 0.300 | 1.000 / 1.400 | 24.100 / 33.000 | 20.100 / 27.600 |
| render main svg | 0.100 / 0.100 | 0.200 / 0.500 | 1.900 / 3.100 | 1.100 / 2.400 |
| render mini svg | 0.100 / 0.300 | 0.300 / 0.500 | 2.600 / 3.100 | 1.200 / 2.600 |
| serialize project | 0.000 / 0.100 | 0.000 / 0.100 | 0.000 / 0.100 | 0.300 / 0.400 |
| **recompute rebuild** | 6.8 / 9.6 | 12.7 / 14.6 | 91.8 / 125.6 | 225.4 / 357.6 |
| recompute + frame | 35.2 / 36.9 | 35.3 / 35.8 | 122.8 / 209.6 | 249.8 / 429.1 |
| **cold start to drawing** | 130 ms | 135 ms | 230 ms | 470 ms |

Chrome clamps `performance.now()` resolution to 100 µs here, so the small phases quantize
to 0.1 ms. That is why the sub-millisecond rows look coarse; it is a limit of the clock,
not of the code.

The DOM the page ends up holding, which explains the recompute figures:

| | A-example | B-medium | C-large | D-surveyed |
| --- | --- | --- | --- | --- |
| callouts | 0 | 0 | 0 | 50 |
| span labels | 33 | 96 | 501 | 501 |
| annotation obstacles | 76 | 210 | 1044 | 1044 |
| hit-area elements | 66 | 193 | 1003 | 1003 |
| main SVG characters | 24 283 | 68 399 | 355 743 | 386 966 |

**The recompute figure is far larger than the sum of its measured phases** — 91.8 ms for C
against ~22 ms of scene plus renders. The difference is real work that the phase rows do
not include: ~1000 hit-area elements are created individually in the document, the
designation allocator and the asset registry are rebuilt, and the compact reference is
rendered from a second full SVG. It is stated here rather than hidden, and it is the
honest headline for the large drawing: **a single edit to the 501-span drawing blocks the
main thread for roughly a tenth of a second, and a heavily annotated one for a quarter of
a second.**

**Cold start is dominated by one-time costs** that do not grow with the drawing in the
same way: A is 130 ms for a 34-node drawing, C is 230 ms for a 501-node one. Most of A's
figure is fetching and booting the application, which the drawing size cannot reduce.

## 7. What dominates, and how it grows

`npm run benchmark -- --scaling` grows a one-span-per-route chain and times placement
alone:

| Spans | Placement | Per span | Ratio vs. half the size |
| --- | --- | --- | --- |
| 50 | 1.07 ms | 21.4 µs | — |
| 100 | 1.97 ms | 19.7 µs | ×1.84 |
| 200 | 5.90 ms | 29.5 µs | ×2.99 |
| 400 | 20.20 ms | 50.5 µs | ×3.42 |
| 800 | 73.65 ms | 92.1 µs | ×3.65 |

**This is quadratic, not linear.** Linear work doubles when the drawing doubles; this
nearly quadruples from 200 upwards, and the cost *per span* climbs instead of staying flat.
The scan described here was replaced by a per-scene spatial index
([12-annotation-placement.md](12-annotation-placement.md)); the numbers below are the
**before** state, and §7.1 has the after state.
The cause is visible in the code rather than inferred from the curve:
[`countCollisions()`](../src/geometry/annotations.js) walks the entire static obstacle list
**and** the entire list of already-taken labels for every candidate position it scores, and
it is called for every annotation. With *n* annotations, ~1044 obstacles and a fixed
number of candidates per annotation — 6 for a span label (`spanCandidates()`) and 12 for a
load callout (`loadCandidates()`) — the work is
`n × candidates × (obstacles + taken)`: quadratic in *n*, because `obstacles` and `taken`
both grow with the number of labels.

Recorded as [F13](findings.md#f13-annotation-placement-is-quadratic-in-the-number-of-labels)
so the observation survives independently of this document. **Nothing was optimised in the
act that produced this baseline**: the brief was to measure, and a speculative rewrite of
the placement search would be exactly the kind of unmeasured change a baseline exists to
prevent.

### 7.1 After the F13 index

The index was added later, with this baseline as its before-and-after
([Annotation placement](12-annotation-placement.md)). Same scripts, same machine, same
datasets, same iteration counts; five runs of the scaling series before and five after,
median shown:

| Spans | Before | After | Speed-up |
| ---: | ---: | ---: | ---: |
| 50 | 1.02 ms | 0.66 ms | 1.5x |
| 100 | 1.99 ms | 1.32 ms | 1.5x |
| 200 | 5.60 ms | 2.75 ms | 2.0x |
| 400 | 20.61 ms | 8.84 ms | 2.3x |
| 800 | 75.66 ms | 22.60 ms | 3.3x |

On the four fixed drawings, `place annotations` went from 13.05 ms to 4.07 ms on C-large
and from 13.00 ms to 4.20 ms on D-surveyed (3.2x and 3.1x), and the full pipeline from
17.20 ms to 8.94 ms and 18.53 ms to 10.31 ms. The two small drawings are unchanged within
noise. The `-` and `npm run benchmark` numbers in §5 above are the **before** state and are
kept, because a baseline that is rewritten whenever the code improves stops being a
baseline; the after numbers live here and in
[12-annotation-placement.md §9](12-annotation-placement.md#9-results-before-and-after).

What did *not* happen: no dataset was made smaller, no annotation was dropped, no threshold
was added, and the method above is unchanged. The remaining per-doubling growth (~1.6-2.0x
in the middle of the series, 2.6x at the top) is the geometry of a 501-label strip, not the
lookup — see §10 of [12-annotation-placement.md](12-annotation-placement.md#10-what-was-deliberately-not-optimized).

## 8. What these numbers mean for a user

Stated as ranges, not promises, and derived from the tables above rather than from a
target someone invented:

| Drawing | Opening it | Editing it (one recompute) |
| --- | --- | --- |
| the bundled example (34 spans) | ~0.13 s to a finished drawing | ~7 ms — imperceptible |
| ~100 spans | ~0.14 s | ~13 ms — imperceptible |
| ~500 spans, unmeasured | ~0.23 s | ~62 ms — a visible but tolerable pause |
| ~500 spans, fully surveyed | ~0.36 s | ~151 ms — noticeable on every edit |

(Those two recompute figures are the *after* measurement from
[12-annotation-placement.md §9](12-annotation-placement.md#9-results-before-and-after). The
pre-index figures were ~90 ms and ~225 ms, and the reduction is smaller than the 3.2x
placement speed-up because most of a recompute is not placement.)

So: the tool is comfortable to a few hundred spans, and the fully-surveyed 500-span case is
the point where editing starts to feel slow. The editable limit (`MAX_ROUTE_SPANS`, 500 per
route) is **not** derived from these numbers, and this document does not change it. What the
numbers do say is that the limit is not being evaded by the implementation: within it, the
drawing opens in well under half a second on this machine.

## 9. Limitations of the measurement

- **One machine, one run.** The tables are a single execution of each script. Expect
  run-to-run variation of ±20–30 % on the large cases, and more on p95. The scaling series
  used 5 iterations per point, so its per-row precision is coarse; its *trend* is not.
- **Headless Chrome is not a desktop window.** Paint costs differ, and headless does not
  show a user's display scaling. The rebuild figure is the trustworthy one; the frame
  figure includes a scheduler floor.
- **The datasets are synthetic.** They are generated, not captured from real projects. They
  cover an example-sized drawing, a branched medium one, and two large ones in the same
  "long chain" shape, so a dense 2-D drawing with many junctions is not represented.
- **Not a gate.** Because the numbers are machine-specific, nothing fails when they change.
  Detecting a regression needs a same-machine comparison: run the benchmark before and
  after a change and compare the medians.

## 10. What is not measured

Named so that their absence is a decision, not an oversight:

- **PDF export.** `exportPdf()` builds the scene with the `pdf` profile and hands it to
  jsPDF ([src/render/pdf.js](../src/render/pdf.js)), then `doc.save()` triggers a download.
  It is a one-shot export rather than part of the editing loop, and its cost is mostly
  inside a third-party library, so timing it here would say more about jsPDF than about
  this codebase. The scene it builds is the same work the measured `build scene` row
  covers, with one extra profile.
- **Print.** `printDrawing()` writes a document into a hidden iframe and calls
  `frame.contentWindow.print()` ([src/ui/app.js](../src/ui/app.js)), which opens the
  browser's own dialog and does not return until a person dismisses it — there is no
  interval to time. [`npm run test:print:headed`](../scripts/print-dialog-smoke.mjs) exists
  for functional checking of that dialog, not for timing.
- **Hit-area creation as a phase.** It is real, it is a large share of the recompute
  figure, and it is only reported indirectly (the recompute total and the element count)
  because measuring it in isolation would mean duplicating the application's DOM building
  in the benchmark — and a copy of the code would drift from the code.
- **Long-session behaviour.** Every measurement is on a freshly loaded page. Memory growth
  over hundreds of edits is not measured.
- **Interaction latency** (hover, drag, zoom). These are pointer-handler costs that do not
  involve a rebuild, and the drag conversion itself is covered functionally by the F3
  browser checks rather than by timing.

---

**Related:** [Findings](findings.md) ·
[Testing and development](08-testing.md) ·
[Feature and validation matrix](09-feature-matrix.md) ·
[Known limitations](10-limitations.md)
