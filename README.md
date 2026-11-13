# Line Route Drawing Generator

A browser tool that turns sequential route instructions into an electrical
line-route drawing. You enter routes (from where, which direction, how many
spans, whether the destination is a TC point), and the drawing is generated
immediately. The same drawing can be downloaded as vector PDF, saved as an SVG
for Word or PowerPoint, or printed.

It runs entirely in the browser: no backend, no database, no network access at
runtime, no build step.

## Documentation

The full documentation set lives in [`documentation/`](documentation/README.md):

| Document | Covers |
| --- | --- |
| [Overview and quick start](documentation/01-overview.md) | What the tool is, how to run it, the stack, a glossary |
| [User guide](documentation/02-user-guide.md) | Every control, with what it does and what it refuses |
| [Technical architecture](documentation/03-architecture.md) | Layers, module responsibilities, contracts, dependency rules |
| [Route and geometry model](documentation/04-route-and-geometry.md) | Coordinates, the canonical graph, marker and clipping geometry |
| [Persistence and project format](documentation/05-persistence.md) | The exact JSON field reference, migrations, refusal codes, recovery |
| [Identity and network data](documentation/06-identity-and-data.md) | Asset ids, designations, loads, span lengths, reconciliation |
| [Rendering and export](documentation/07-rendering-and-export.md) | Profiles, the four page layouts, fit-to-sheet, the `c39eca9` regression |
| [Testing and development](documentation/08-testing.md) | Commands, the 478 Node tests and 266 browser checks, conventions |
| [Feature and validation matrix](documentation/09-feature-matrix.md) | Every capability with its verification status |
| [Known limitations](documentation/10-limitations.md) | What it cannot do, and what has not been validated |
| [Findings](documentation/findings.md) | Defects and gaps recorded but deliberately not fixed |
| [Changelog](CHANGELOG.md) | Every change, however small, with the commit that carried it |

This README is the short version and remains the quickest way in.

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
5. Record what the drawing carries in **Network data** (see below).
6. **Download PDF**, **Download SVG for Office**, or **Print drawing**.

### Recording loads and span lengths

**Network data** holds two schedules. Neither of them changes the drawing's shape:
a load sits on a pole that is already there, and a span length is a measurement of
a cable that is already drawn.

- **Node loads** - one row per electrical load. Choose a **Point**, a **Value** and a
  **Unit** (kVA, kW, kVAr or HP), then **Add load**. A pole or feeder pillar can carry
  several loads; they are drawn as a single callout with one line each and a leader
  arrow that points at the pole. They are never converted or added together, because
  a kVA and an HP are not addable, and a tool that quietly sums them produces a
  number that is wrong in a way nobody checks.
- **Span lengths** - one row per physical span, in metres. Type a length, or enter a
  **Default length** and press **Apply to unmeasured spans**, which fills only the
  blanks and never overwrites a length you typed. An unmeasured span is drawn with a
  dash instead of a number, as `— m`; it is not treated as zero and is never guessed
  from the drawing's spacing. A span with no label at all would make a finished sheet
  indistinguishable from an unsurveyed one, so the placeholder is deliberate. The
  spacing is a layout choice, the length is a survey, and they are stored apart so
  changing one cannot move the other. The preview also carries a
  measurement-completeness notice, which is never exported.

Both schedules can be moved to and from a spreadsheet. **Copy as spreadsheet** puts
the table on the clipboard as a tab-separated block with its header row, ready to
paste into Excel. **Export CSV** writes the same data as a file. **Import CSV or
paste** accepts either and shows you what would change *before* anything is: how
many records would be added, updated and removed, and any rows that refer to
something the drawing no longer has. You then choose between **Replace the
schedule** (the file is the whole truth) and **Update matching IDs** (the file is a
change list). A file with a bad line is refused whole, with that line named.

Pointing at the drawing selects the matching row, and pointing at a row highlights
the drawing, so "which pole" is answered by clicking it. Every point in the
dropdown reads `C (dst:route-6)`, showing both the label you recognise and the id
the record is stored against.

A callout or a span length label can be dragged to a clearer spot. The nudge is
remembered, survives a reload, and follows its pole if the drawing is re-laid-out,
because it is stored as an offset keyed by the asset's id rather than as a screen
position. Dragging moves the annotation, never the load: the record stays on its
pole.

### When the drawing changes

Adding a branch leaves every recorded load and length exactly where it was. Deleting
one does not: the records that were attached to the removed poles become
**unresolved**. They are kept, not discarded and not moved onto some other pole,
and a bar tells you how many. **Review** jumps to the first one; a load can be
**Reassigned** to a point that still exists, keeping its id and value; **Discard
them** removes them after a confirmation. Nothing you recorded disappears without
you seeing it happen.

### Keeping a project

Your work is remembered in this browser automatically, after every change, so
closing the tab and coming back later resumes the same drawing on the same
computer. **Save project** writes it to a `.json` file you can keep, copy to
another machine or email; **Load project** opens one. Nothing is uploaded
anywhere: the file is the only thing that leaves the browser.

A project file records only what you typed: the route rows, the Origin symbol,
the span spacing and the page layout. The drawing itself is rebuilt from those
when the file is opened, so an edited file cannot smuggle in a wrong picture.

Loading is all-or-nothing. A file that is damaged, is not a project file, or was
written by a newer version of this tool is refused with a message saying which,
and the drawing on screen is left exactly as it was. It asks before replacing
anything that would actually change - including a saved project that has no route
rows but a different Origin symbol, spacing or page layout - and stays silent when
the file is the same as what is already open. **Clear all** is remembered too, so
a reload after clearing stays empty rather than bringing the old drawing back.

A route keeps the identity it was saved with. That is what makes selecting,
editing and deleting behave on a reopened project exactly as they did before it
was saved.

#### When the remembered project cannot be read

If the copy in this browser is damaged, or was written by a newer version of the
tool, it is **not** replaced. A bar appears saying the saved drawing is still
there and unchanged, and that automatic saving is paused. You can keep working on
what is on screen and **Save project** still downloads it, so nothing is trapped.
Nothing is written to the browser while this bar is showing.

The saved copy is only discarded when you say so. Both buttons on the bar ask for
confirmation first, because discarding cannot be undone: one starts again from the
example, the other from a blank drawing. Once you have chosen, automatic saving
resumes and the next reload restores whatever you decided on.

### How names appear

- The starting point is **Origin**. It is drawn as a pole (an X) unless you set
  it to be a TC point or an FPB, in which case it shows that symbol and no X.
  The **From** list names it after the symbol you chose, as `Origin (Pole)`,
  `Origin (TC point)` or `Origin (FPB point)`, so it is never mistaken for a TC
  or FPB further along the route.
- Endpoints get the letters **A, B, C, ...** in the order they are created, so a
  new branch is named in the drawing the moment it is added. A label never moves
  when an endpoint is reused.
- A **TC** point is a special point drawn as a triangle, at a size clearly
  larger than an X pole marker so the two never read alike. Route lines stop at
  the edge of the triangle and resume past it, so the inside of the symbol is
  left empty rather than being crossed by the line. It never takes a
  letter. One TC point is called `TC`; several are `TC1`, `TC2`, and so on.
- An **FPB** (feeder pillar box) is drawn as a rectangle sized to its own label
  with `FPB` written inside it. Like the TC triangle, route lines stop at the
  rectangle's edge and resume on the other side, so nothing is drawn inside the
  box. It never takes a letter either. One FPB is called
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
| Load callouts with leader and arrow | yes | yes | yes | yes |
| Span length labels | yes | yes | yes | yes |

Span length labels appear in every output, but each obeys the **Include span
lengths** switch in the Output panel; load callouts obey **Include node loads**.
Both switches default to on. When one is off it affects only the exports: the
preview and the drawing reference panel keep showing everything you entered.

An unmeasured span's label reads `— m`, so an available switch never turns a missing
measurement into a finished-looking drawing.

Printing uses exactly the PDF rules. Exports hide the *drawing's own* text - the
Origin name and the alphabetical labels - and keep everything that is a fact about
the installation: the FPB label, the load callouts and the span lengths. The
drawing itself is never modified, so the preview stays complete.

**The printed sheet uses the page layout you chose.** A drawing set to A3 or Letter
is printed on A3 or Letter, in the orientation that layout declares, and the
drawing is scaled to that paper. Each layout carries its own CSS page size, so the
sheet and the drawing cannot disagree about what paper they are for.

All three outputs are rendered from one annotated scene, so a callout points at the
same pole and reads the same numbers on screen, in the PDF and in the SVG. The PDF
stays fully vector: leaders are stroked lines, arrowheads filled triangles and every
annotation a real text run.

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
- **A load is never converted or summed.** kVA, kW, kVAr and HP are recorded as
  typed, one record each, and drawn one line each. There is no unit conversion and no
  total.
- **A span length never moves the drawing.** Changing a measured length changes a
  label, not a coordinate. No length is ever derived from the drawing's spacing.
- **Recorded data is never lost silently.** A record whose pole or span was removed
  is kept as unresolved and reported, not discarded and never moved onto a different
  physical point.
- **Span spacing has a minimum, 35 px by default.** Below it the symbols stop
  fitting between the points they mark: an FPB box is wider than the gap, so it
  swallows the neighbouring pole and can erase a whole span, and the shortest
  visible piece of line becomes too small to read. The limit is not a guess and
  not a separate setting; it is measured from the same marker shapes the
  renderers draw, so it moves with them if their size ever changes. The TC
  triangle is the one shape that adapts: it is fitted into the room actually
  available behind its point, shrinking just enough to keep a readable piece of
  cable when a marker sits immediately upstream, so it is measured by the size it
  can never shrink below rather than its full height. When the
  spacing is too tight, a warning names the shortest safe spacing and the three
  export buttons are disabled. The drawing stays visible and the number you
  typed is kept, so you can see the effect and decide; nothing is changed for
  you, and the topology never changes with spacing.
- **The exported PDF draws every symbol at page scale, through one transform.**
  The triangle, the pole crosses and the cable are all placed by the same rule,
  so the symbol always sits exactly on the point it marks and a conductor never
  appears to run through it. This is checked by reading the vector paths out of
  the downloaded file, not by trusting the drawing that produced it: the earlier
  version of this code passed every check that looked at the model while the
  finished sheet still had a cable stroke inside the triangle.

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
src/render/print.js     fit a scene onto one printed sheet, aspect preserved
src/ui/                 state, example resolution and the DOM controller
vendor/jspdf/           jsPDF 4.2.1, MIT, vendored locally
scripts/serve.js        loopback static server
scripts/test-browser.mjs    committed browser suite (npm run test:browser)

scripts/print-dialog-smoke.mjs  headed print-dialog check (npm run test:print:headed)
scripts/verify-browser.mjs  older ad-hoc Playwright probe
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

Uses Node's built-in test runner; no dependencies to install. **478 tests across 30
files** cover cardinal directions, span and pole counts, alphabetical labelling, TC
identification and naming, endpoint reuse, shared-node merging, partial and complete
overlap, intersections, multiple branches, label visibility per profile, TC retention
in every profile, the full example topology, sequential dependency errors, and
deterministic recalculation after an edit.

The measured data has its own coverage: stable asset identity across edits and
removals, one span id per physical edge however many routes walk it, load records
that stay separate and keep their units, span lengths that never touch the spacing,
CSV and TSV round trips including the awkward cases (a quoted comma, an apostrophe,
CRLF, a repeated id, an unknown asset), the version 1 to version 2 migration,
annotation placement and its collision avoidance, and reconciliation after a
topology change.

### Browser suite

```sh
npm run test:browser
```

`scripts/test-browser.mjs` drives the real application in a real browser and
asserts on what a user would actually see and download: the point designations
before and after a reload, branch numbering, span ids, the load callouts, the
incompleteness notice, dragging an annotation and reloading, the CSV import being
staged rather than applied, all four export switch combinations, the content
of the downloaded SVG and PDF, the print sheet fitting **one page on every one of
the four layouts**, and the TC geometry on the printed sheet. **266 checks in 14
sections.**

It needs two things that the application itself does not:

- **Node 20 or newer.**
- **Playwright**, installed once: `npm install --no-save playwright`. The suite uses
  the installed Google Chrome through `channel: 'chrome'`, so no browser download is
  needed. Set `BROWSER_CHANNEL=chromium` to use a Playwright-managed browser instead,
  `HEADED=1` to watch it run, or `PLAYWRIGHT_PATH` to point at an installation kept
  outside this project.

The harness starts its own static server on a free port, clears browser storage
before each scenario, and exits non-zero if any check fails. It is a development
aid; the application itself never depends on Playwright.

### Print dialog smoke test

```sh
npm run test:print:headed
npm run test:print:headed -- --layout a4_portrait
```

The browser suite checks the print sheet by reading the document it builds, with
`window.print()` replaced so no dialog opens. That cannot show what the browser
resolves a paper size to in its own dialog. This command covers that one step. It
opens a visible browser, loads the example, selects the layout and presses the real
Print drawing button without replacing anything, so the browser's own dialog appears.
It defaults to A3 landscape, the layout most likely to have been printed onto A4 by
mistake.

Nothing is sent to a printer and no print job is confirmed. The dialog must be
dismissed by hand, and what it displayed is judged by eye against the instructions
printed when it opens. Physical printer behaviour - margins, driver scaling, "fit to
page" - is decided by the printer driver and needs a real sheet, so it stays a manual
check rather than an automated one. This is why the command is separate: a native
dialog blocks whoever opens it, and the automated suite must never block.

It must be run in an interactive terminal. A pipe or a redirected file cannot
acknowledge the inspection, because a newline arriving that way is not a person, and
accepting one would let a script report a pass for an inspection nobody performed. Run
without a terminal it reports `INPUT UNAVAILABLE` and exits 1 straight away rather
than waiting out the inspection period. Only Enter acknowledges; other keys are
ignored, and Ctrl+C cancels (exit 130).

Two things in the dialog are separate, and the script reports the first of them as
automated evidence rather than leaving both to the person:

1. **The paper.** The print document declares it (`@page{size:A4 landscape}` and so on,
   derived from `PAGE_LAYOUTS`), and the script prints what it declared alongside the
   drawing's size on the sheet. **Chrome may keep its own previously selected paper
   instead of honouring that declaration.** When the dialog shows a different size,
   that is Chrome's remembered setting and not a fault in the drawing: choose the
   paper in the dialog and check again. The application cannot force the paper
   dropdown, and does not claim to.

2. **The number of pages.** This is the part the application is responsible for. The
   drawing is sized to fit inside the paper minus its margin, at one scale for both
   axes, so it fills the sheet without ever exceeding it. Two or more sheets is a
   defect.

The drawing is 536 units wide by 736 tall, which is taller than it is wide. The print
stylesheet once sized it with `width:100%;height:auto`, which scales to the content
width and derives the height from the aspect ratio without consulting the sheet height.
On every landscape layout that made the drawing 1.8 to 2.0 times taller than the
printable area, and the browser split it across two pages. Only A4 portrait fitted, and
only because its printable area is taller than it is wide, which is why the fault
looked layout-specific. `src/render/print.js` now computes an explicit size using the
same rule as `fitSceneToPage` in the PDF renderer, and `test/print_fit.test.js` pins it
for every configured layout.

One limitation is recorded rather than solved. The lifecycle tests in
`test/print_tty_state.test.js` drive the real `waitForManualAcknowledgement` through a
fake stream that imitates a terminal's contract - the `isTTY` flag, `isRaw`,
`setRawMode` and the event methods. That is not a pseudo-terminal: it has no kernel
line discipline, and it cannot show what Enter actually sends or whether the operating
system restores terminal settings after the process exits. A pseudo-terminal is not
obtainable in every environment (Windows has no `pty` module, and `winpty` needs a
console this build cannot allocate), so the interactive path itself is verified by
running this command in a real terminal, which is what it is for.

## Dependencies and licenses

Only one third-party file is included: **jsPDF 4.2.1**, MIT licence, at
`vendor/jspdf/`. See `vendor/README.md` for the exact version, the licence text
and the upgrade procedure. Everything else is written for this project and uses
only browser and Node built-ins.

## Known limitations

The detailed list, with what has and has not been validated, is in
[documentation/10-limitations.md](documentation/10-limitations.md). In brief:

- One drawing is exported at a time; there is no multi-sheet or paginated
  output. Very large networks are scaled down to fit a single page, so the text gets
  small; there is no warning before it stops being readable.
- **A branch can only start from the Origin or a route destination.** Branching from
  an intermediate pole (say `A2`) is not expressible; split the run at the branch
  point instead.
- **The drawing is not to scale.** Every span is drawn at the same length, so a
  measured length is a label you read, never a distance you measure from the sheet.
- **There is no undo**, and rows cannot be reordered. Save project before risky edits.
- No custom paper size: A4 landscape, A4 portrait, A3 landscape, Letter landscape only.
- A4 portrait and A3 landscape have been verified by the automated fit check only;
  **Letter landscape** was checked by hand in the real Chrome print dialog, and
  physical printing was validated by the user outside this repository.
- Firefox, Safari, touch devices and mobile layouts have **not** been tested.
- The SVG is plain vector primitives so Word and PowerPoint accept it as an
  editable drawing, but import behaviour was not verified inside Office itself.
  Office may convert imported graphics into a group of shapes, which is normal
  for SVG import and is not claimed to be shape-by-route editable.
- The drawing's own labels are suppressed entirely in exports rather than moved
  off-canvas. Load callouts and span lengths are content, not labels, and are kept,
  subject to the two export switches. The measurement-completeness notice is a
  working aid and is never exported.
- A load cannot be attached to a TC point. The rule is enforced at three guarded
  boundaries: `addLoad()` fails closed (refusing when no resolver is supplied, when the
  point does not resolve, or when it cannot carry a load), the project parser refuses the
  file with `INELIGIBLE_LOAD_TARGET`, and the schedule import planner refuses the row
  before a plan exists. Targets are resolved through the asset registry, so an aliased
  spelling is judged by what it resolves to.
- Moving a load to a different point, or resolving an unresolved record, is done from
  the schedule rather than by dragging. Dragging a callout or a span label nudges the
  annotation, not the load: the record stays on its pole.
- The remembered project lives in one browser on one computer. Clearing the
  browser's site data removes it, which is why **Save project** exists.
- If the remembered project cannot be read, this build cannot repair it. It keeps
  it, pauses saving and explains the situation, but recovering the drawing itself
  needs the version of the tool that wrote it.
