# Project overview and quick start

This is the entry point for the detailed documentation set. The root
[`README.md`](../README.md) is the short version for someone who just wants to
run the tool; this directory is the reference for someone who has to operate,
debug, extend or safely change it.

## Contents

1. [What the application does](#what-the-application-does)
2. [Intended users and use cases](#intended-users-and-use-cases)
3. [Supported environment](#supported-environment)
4. [Technology stack](#technology-stack)
5. [Offline architecture and external dependencies](#offline-architecture-and-external-dependencies)
6. [Installation and startup](#installation-and-startup)
7. [Running the tests](#running-the-tests)
8. [Main features at a glance](#main-features-at-a-glance)
9. [Implementation status](#implementation-status)
10. [Documentation map](#documentation-map)
11. [Glossary](#glossary)

---

## What the application does

`line_route_drawing_generator` is a single-page browser application that turns a
list of sequential route instructions into an electrical line-route drawing, and
then exports that drawing as a vector PDF, as an SVG for Word/PowerPoint, or as a
printed sheet.

A *route instruction* is one row: a starting point, a cardinal direction, a whole
number of spans, and whether the destination is an ordinary pole, a **TC** point
(test point, drawn as a triangle) or an **FPB** (feeder pillar box, drawn as a
labelled rectangle).

On top of the drawing shape the application records two independent surveys:

- **Node loads** — how much load sits on a given pole, in kVA, kW, kVAr or HP.
- **Span lengths** — the measured length of the cable on a given physical span,
  in metres.

Neither survey changes the drawing's geometry. Loads are drawn as leader-arrow
callouts next to their pole; span lengths are drawn as labels beside their span.

Everything is derived from the authored rows. There is no stored copy of the
drawing itself — see [Persistence and project format](05-persistence.md) for why
that matters.

## Intended users and use cases

The tool is written for people who lay out an electricity distribution network on
paper: engineers and technicians producing a line-route drawing for an estimate or
an action plan, who currently draw it by hand.

Primary use cases:

- Reproduce an existing hand-drawn line-route sketch as a clean, editable drawing.
- Build a new route from the Origin outwards, branch by branch, and check it as
  it grows.
- Survey the installation: record a load on each pole and a length on each span,
  keeping the drawing unchanged while doing so.
- Produce a deliverable: a vector PDF, an SVG placed into a Word or PowerPoint
  document, or a printed sheet.

## Supported environment

- **Browser:** a current Chrome/Chromium, Edge or Firefox that supports ES
  modules, `<script type="module">`, SVG and `localStorage`. The application is
  exercised in the automated suite through Google Chrome (`channel: 'chrome'`).
- **Local server:** any static file server over HTTP on loopback. The repository
  ships `scripts/serve.js`, which is dependency-free.
- **Node.js:** `>=20` (`package.json` → `engines.node`), used for the local server
  and for the test suites. Node 24 is what the suites were last run against.
- **No build step.** The files the server sends are the files in the repository.

There is no OS-specific behaviour in the application. The only Windows-specific
detail is the test command syntax in [Testing and development](08-testing.md).

## Technology stack

| Layer | Technology | Where |
| --- | --- | --- |
| Markup / shell | Hand-written HTML | [index.html](../index.html) |
| Styling | Hand-written CSS | [styles/app.css](../styles/app.css) |
| Application logic | Native ES modules, no framework | `src/**/*.js` |
| Vector PDF | jsPDF 4.2.1, vendored | `vendor/jspdf/jspdf.umd.cjs` |
| SVG | Generated strings (`path`, `line`, `polygon`, `rect`, `text`) | [src/render/svg.js](../src/render/svg.js) |
| Persistence | `localStorage` + downloadable JSON files | [src/ui/storage.js](../src/ui/storage.js), [src/ui/project.js](../src/ui/project.js) |
| Unit / integration tests | Node's built-in test runner (`node --test`) | `test/*.test.js` |
| Browser tests | Playwright (dev dependency only) | `scripts/test-browser.mjs` |

## Offline architecture and external dependencies

The application makes **no network requests at runtime**. There is no CDN, no
analytics, no backend and no database. Concretely:

- The only third-party code is jsPDF, committed under `vendor/jspdf/`, loaded by a
  plain `<script>` tag in `index.html` and exposed as `window.jspdf.jsPDF`.
  Its provenance, licence and upgrade procedure are recorded in
  [vendor/README.md](../vendor/README.md).
- All fonts referenced are system font families
  (`Helvetica, Arial, sans-serif`, from `DEFAULT_CONFIG.fontFamily`).
- The route geometry, the schedules, the CSV/TSV transfer and the annotations are
  all first-party modules using only browser and Node built-ins.
- Playwright is a **development** dependency. The application never imports it;
  only `scripts/test-browser.mjs`, `scripts/print-dialog-smoke.mjs` and the
  ad-hoc `scripts/verify-browser.mjs` do.

Because ES module imports do not work from `file://` in every browser, the tool
must be served over HTTP on loopback — that is the primary reason the small server
exists. It is also needed for the clipboard's async API: on `file://` the browser
denies it, and the tool falls back to `document.execCommand('copy')` (see
[Known limitations §9](10-limitations.md#9-data-interchange-limits)).

## Installation and startup

There is nothing to install to run the application.

```sh
node scripts/serve.js          # http://127.0.0.1:8080/
node scripts/serve.js 3000     # or pick a port
```

`scripts/serve.js` serves the repository root, refuses path traversal outside it,
and binds to loopback. Open the printed address in a browser.

For the test suites only, install Playwright once (it is not needed to use the
tool):

```sh
npm install --no-save playwright
```

### How to access the application locally

Open `http://127.0.0.1:8080/` (or the port you chose) in a browser. First run
shows the bundled example drawing; later runs restore whatever this browser last
had open (see [Persistence and project format](05-persistence.md)).

## Running the tests

```sh
npm test                    # 526 Node tests, no dependencies required
npm run test:browser        # 340 browser checks; needs Playwright + Chrome
npm run test:print:headed   # manual print-dialog check; needs a real terminal
```

Detailed instructions, per-file commands, environment variables and failure
interpretation are in [Testing and development](08-testing.md).

## Main features at a glance

- **Sequential route entry** with a strict dependency rule: a route may only start
  from the Origin or from an endpoint created by an *earlier* route.
- **Origin symbol selection** — the starting point can itself be drawn as a pole,
  a TC point or an FPB.
- **Identity and naming** — stable internal ids for every pole and span, plus
  readable point designations (`A`, `A1`, `Origin:2`, `TC:1`, `FPB1:2`) and span
  display names (`A1–A2`).
- **TC and FPB markers** that replace the X symbol at their node, with the route
  lines trimmed so no conductor is drawn inside the symbol.
- **Merge behaviour** — shared endpoints, partial and complete overlap, and
  intersecting routes produce one canonical graph with one symbol per point.
- **Network data** — a load schedule and a span-length schedule, both keyed by
  immutable asset id, with CSV export, TSV copy, and a staged CSV/TSV import that
  is reviewed before it is applied.
- **Draggable annotations**, stored as offsets keyed by asset id so they follow
  their pole across a re-layout and a reload.
- **Automatic browser persistence**, versioned project files, schema migration,
  all-or-nothing import, and a recovery mode that never overwrites an unreadable
  saved project.
- **Three exports from one scene** — vector PDF (four page layouts), SVG, and a
  browser print sheet sized to exactly one page per layout — with independent
  inclusion switches for node loads and span lengths.

## Implementation status

The feature-by-feature status, with the evidence behind each claim, is kept in one
place: [Feature and validation matrix](09-feature-matrix.md). Read that page before
quoting any capability; it distinguishes *verified by an automated test*, *verified
manually*, and *implemented but not validated*.

Confirmed limitations, and why each exists, are in
[Known limitations](10-limitations.md).

## Documentation map

| Document | What it covers |
| --- | --- |
| [02-user-guide.md](02-user-guide.md) | Every actual control, action, validation and result. |
| [03-architecture.md](03-architecture.md) | Entry points, module boundaries, state ownership, end-to-end data flow, the shared scene. |
| [04-route-and-geometry.md](04-route-and-geometry.md) | The coordinate system, graph construction, marker geometry, clipping, worked examples. |
| [05-persistence.md](05-persistence.md) | Authored vs derived state, `localStorage`, the project file schema, migration, recovery. |
| [06-identity-and-data.md](06-identity-and-data.md) | Asset ids, point designations, span names, loads, lengths, annotation offsets. |
| [07-rendering-and-export.md](07-rendering-and-export.md) | PDF, SVG and print, `PAGE_LAYOUTS`, the fit-to-page algorithms, the `c39eca9` regression. |
| [08-testing.md](08-testing.md) | Commands, test architecture, fixtures, browser suite, headed print smoke. |
| [09-feature-matrix.md](09-feature-matrix.md) | Consolidated capability / status / evidence matrix. |
| [10-limitations.md](10-limitations.md) | Confirmed limitations and extension boundaries. |
| [11-performance-baseline.md](11-performance-baseline.md) | What a drawing costs on four fixed datasets, how it was measured, and how to re-measure it. |
| [findings.md](findings.md) | Discrepancies found during documentation, recorded as observations. |

## Glossary

Terms used consistently throughout this documentation set.

| Term | Meaning |
| --- | --- |
| **Route instruction** / **route row** | One authored record: `{id, from, direction, spans, tc, fpb}`. |
| **Span** | One unit edge between two adjacent grid points. Also the physical cable between two poles. |
| **Pole** | A point on the drawing, drawn as an X unless a marker replaces it. |
| **Origin** | The fixed starting point, at grid coordinate `(0,0)`, with internal id `origin`. |
| **Endpoint** | A named point: the Origin, an alphabetical endpoint (`A`, `B`, …), a TC point or an FPB. |
| **TC** | Test point. Drawn as a triangle; never consumes a letter; never takes a load. |
| **FPB** | Feeder pillar box. Drawn as a rectangle with `FPB` inside; never consumes a letter. |
| **Intermediate pole** | A pole created *between* a route's start and its destination. |
| **Asset id** | The immutable internal identity of a node or a span (`origin`, `dst:route-3`, `mid:route-2:0`, `dst:route-1~mid:route-2:0` for a span). |
| **Designation** | The human-readable name of a point (`A`, `A1`, `Origin:2`, `TC:1`). |
| **Span designation** | The human-readable name of a span, formed from its two ends with an en dash (`A1–A2`). |
| **Scene** | The renderer-agnostic pixel-space description of the drawing produced by `buildScene()`. |
| **Render profile** | A named visibility configuration (`preview`, `pdf`, `svg`, `print`) from `RENDER_PROFILES`. |
| **Authored state** | What the user typed: routes, Origin symbol, spacing, layout, schedules, annotations, export switches. |
| **Derived state** | Everything computed from authored state: the graph, coordinates, asset registry, scenes. |
| **Unresolved record** | A load or length whose asset no longer exists in the drawing. Kept, reported, never moved. |
| **Page layout** | One entry of `PAGE_LAYOUTS`: paper format, orientation, point size and CSS `@page` size. |
