# Line Route Drawing Generator

A browser tool that turns sequential route instructions into an electrical
line-route drawing. You enter routes (from where, which direction, how many
spans, whether the destination is a TC point), and the drawing is generated
immediately. The same drawing can be downloaded as vector PDF, saved as an SVG
for Word or PowerPoint, or printed.

It runs entirely in the browser: no backend, no database, no network access at
runtime, no build step.

## Running it

Serve the folder over HTTP on loopback and open the address:

```sh
node scripts/serve.js          # http://127.0.0.1:8080/
node scripts/serve.js 3000     # or pick a port
```

Opening `index.html` directly from disk is not recommended, because browsers
refuse ES module imports from `file://` URLs.

Any static file server works equally well. There is nothing to compile.

## Using it

0. Set **The starting point is a** to choose how the Origin itself is drawn:
   **Pole** (default), **TC point** or **FPB point**. This is a property of the
   drawing, not of a route, so it applies to every output at once.
1. Choose **From**, **Direction**, **Spans** and whether the destination is a
   **TC point** or an **FPB point**, then **Add route**.
2. Select a row and press **Edit** to change it; **Delete** removes it. Every
   later route is re-evaluated immediately.
3. **Load example** reproduces the reference drawing described below.
4. Use the preview controls to zoom, pan, fit the drawing to the screen or
   reset the view. **Span spacing** changes the length of every span at once and
   never changes the topology.
5. **Download PDF**, **Download SVG for Office**, or **Print drawing**.

### How names appear

- The starting point is **Origin**. It is drawn as a pole (an X) unless you set
  it to be a TC point or an FPB, in which case it shows that symbol and no X.
- Endpoints get the letters **A, B, C, ...** in the order they are created, so a
  new branch is named in the drawing the moment it is added. A label never moves
  when an endpoint is reused.
- A **TC** point is a special point drawn as a triangle, at a size clearly
  larger than an X pole marker so the two never read alike. It never takes a
  letter. One TC point is called `TC`; several are `TC1`, `TC2`, and so on.
- An **FPB** (feeder pillar box) is drawn as a rectangle sized to its own label
  with `FPB` written inside it. It never takes a letter either. One FPB is called
  `FPB`; several are `FPB1`, `FPB2`, and so on. A destination cannot be a TC
  point and an FPB at the same time.
- Neither a TC point nor an FPB ever gets a crossing marker on top of its own
  symbol: the triangle or the box takes that place, while every other pole keeps
  its X.

### What each output shows

| Element | Preview | PDF | SVG | Print |
| --- | --- | --- | --- | --- |
| Origin text | yes | no | no | no |
| Alphabetic labels | yes | no | no | no |
| Route lines | yes | yes | yes | yes |
| X symbols | yes | yes | yes | yes |
| TC triangles | yes | yes | yes | yes |
| FPB boxes with label | yes | yes | yes | yes |

Printing uses exactly the PDF rules. Exports hide text only; the drawing itself
is never modified, so the preview stays complete.

### Example configuration

The bundled example matches the reference drawing:

| # | From | Direction | Spans | Marker |
| --- | --- | --- | --- | --- |
| 1 | Origin | South | 1 | No |
| 2 | A | East | 4 | No |
| 3 | B | South | 3 | TC |
| 4 | TC | South | 3 | No |
| 5 | C | East | 1 | No |
| 6 | C | South | 2 | No |
| 7 | D | West | 3 | No |
| 8 | D | East | 7 | No |
| 9 | D | South | 10 | No |

The `From` field preselects the most recently created endpoint, so a chain of
routes can be entered without re-selecting the previous destination each time.

The example is stored as data in `src/config.js` and is loaded by the
**Load example** button; it is not built into the geometry engine.

## Rules the tool enforces

- Routes are processed **in the order entered**. A route may only start from
  the Origin or from an endpoint created by an earlier route. A reference to
  something that does not exist yet is reported, not silently reordered.
- If an earlier route changes or is deleted, every later route is re-evaluated.
  Affected rows are marked and explained; they are kept so the entered data is
  not lost.
- Spans must be a whole number greater than zero. Directions must be North,
  South, East or West.
- Export is refused while any route is invalid.
- Shared endpoints, partially or fully overlapping routes, and routes that meet
  at the same point are merged into one drawing. A point is drawn once, with a
  single X symbol, however many routes pass through it.

## Project layout

```
index.html              the interface
styles/app.css          styling, including the print stylesheet
src/config.js           directions, render profiles, page layouts, dimensions
src/geometry/           the network model: no DOM, fully testable
  direction.js          direction vectors and coordinate helpers
  graph.js              canonical nodes and merged unit edges
  network.js            sequential instruction processing and validation
  scene.js              builds the normalized render scene
src/render/svg.js       scene to SVG
src/render/pdf.js       scene to vector PDF (jsPDF operations)
src/ui/                 state, example resolution and the DOM controller
vendor/jspdf/           jsPDF 4.2.1, MIT, vendored locally
scripts/serve.js        loopback static server
scripts/verify-browser.mjs  Playwright workflow check (development aid)
test/                   automated tests
```

Every output draws from one place: `buildScene()` turns the canonical network
into lines, X symbols, TC triangles and (for the preview only) labels. The SVG
and PDF renderers only translate that scene into output syntax. Neither
calculates a coordinate, a pole or a junction of its own.

## Tests

```sh
npm test
```

Uses Node's built-in test runner; no dependencies to install. The suite covers
cardinal directions, span and pole counts, alphabetical labelling, TC
identification and naming, endpoint reuse, shared-node merging, partial and
complete overlap, intersections, multiple branches, label visibility per
profile, TC retention in every profile, the full example topology, sequential
dependency errors, and deterministic recalculation after an edit.

The browser workflow (preview, editing, all three outputs) is checked with
`scripts/verify-browser.mjs`, which needs Playwright available at run time. It
is a development aid and is not part of the application.

## Dependencies and licenses

Only one third-party file is included: **jsPDF 4.2.1**, MIT licence, at
`vendor/jspdf/`. See `vendor/README.md` for the exact version, the licence text
and the upgrade procedure. Everything else is written for this project and uses
only browser and Node built-ins.

## Known limitations

- One drawing is exported at a time; there is no multi-sheet or paginated
  output. Very large networks are scaled down to fit a single page.
- The SVG is plain vector primitives so Word and PowerPoint accept it as an
  editable drawing, but import behaviour was not verified inside Office itself.
  Office may convert imported graphics into a group of shapes, which is normal
  for SVG import and is not claimed to be shape-by-route editable.
- Labels are suppressed entirely in exports rather than moved off-canvas, so an
  exported drawing carries no text at all.
- No persistence: reloading the page starts again from the example.
