# Testing and development guide

## Contents

1. [Requirements](#1-requirements)
2. [Commands](#2-commands)
3. [The Node suite: 581 tests in 36 files](#3-the-node-suite-581-tests-in-36-files)
4. [The browser suite: 355 checks in 17 sections](#4-the-browser-suite-355-checks-in-17-sections)
5. [The headed print smoke test](#5-the-headed-print-smoke-test)
6. [Annotation placement: the exact-output contract](#6-annotation-placement-the-exact-output-contract)
7. [Test strategy: what is tested and why](#7-test-strategy-what-is-tested-and-why)
8. [Writing a new test](#8-writing-a-new-test)
9. [Changing a tunable](#9-changing-a-tunable)
10. [Working on the code: rules that keep the architecture intact](#10-working-on-the-code-rules-that-keep-the-architecture-intact)
11. [Manual validation](#11-manual-validation)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Requirements

| Requirement | Detail |
| --- | --- |
| Node.js | `>= 20` (`package.json` `engines`). The suite uses the built-in `node --test`, `node:assert`, `node:fs` and the `--experimental`-free ESM support |
| Module type | `"type": "module"` — every `.js` is ESM; `import ... from './x.js'` with the extension |
| Browser | Any modern browser for the app itself. Chromium only for the automated browser suite |
| Playwright | `devDependency`, `^1.48.0`. Browsers are installed separately (`npx playwright install chromium`) |
| Build step | **None.** No bundler, no transpiler, no TypeScript. `index.html` loads the modules directly |
| Runtime dependency | none but the vendored jsPDF at `vendor/jspdf/jspdf.umd.cjs` |

## 2. Commands

| Command | What it does | Expected result |
| --- | --- | --- |
| `npm test` | `node --test "test/*.test.js"` | **581 tests, 581 pass, 0 fail** |
| `npm run test:browser` | `node scripts/test-browser.mjs` — starts `scripts/serve.js`, drives Chromium, asserts, exits | **355/355 checks pass** |
| `npm run benchmark` | `node scripts/benchmark.mjs` — times the DOM-free phases on four fixed drawings | a table of medians and p95; **no pass/fail** |
| `npm run benchmark:browser` | `node scripts/benchmark-browser.mjs` — drives the real page in Chrome | cold start and recompute timings; needs Playwright like the browser suite |
| `npm run test:print:headed` | `node scripts/print-dialog-smoke.mjs` — opens a real print dialog | manual, needs an interactive terminal |
| `npm run serve` | static server for manual use | serve locally, then open the printed URL |

Verified on this working tree: `npm test` → `tests 581, pass 581, fail 0`; the suite
takes about 2.5 s.

`npm run test:browser` requires the Playwright browser binaries. `test-browser.mjs`
resolves Playwright at runtime (`loadPlaywright()`) and fails with a message naming the
install command if it is absent, rather than a stack trace.

The browser suite writes its downloads and diagnostics into a temp directory; nothing
it produces is committed.

## 3. The Node suite: 581 tests in 36 files

The whole domain layer is DOM-free, so it is tested directly under Node. Files and
their test counts:

| File | Tests | What it pins |
| --- | --- | --- |
| `annotations.test.js` | 37 | Candidate positions, text measurement, leader/arrowhead geometry, collision avoidance, callout content, span-label placement, manual offsets |
| `benchmark_datasets.test.js` | 10 | The performance baseline's four datasets: the exact route/span/node/edge/load/measured-span counts the documentation quotes; every route within `MAX_ROUTE_SPANS`; every scenario building without errors; the chain really chaining (each `from` an endpoint that exists at that step) and totalling 501 spans; the medium dataset branching rather than being a shorter chain; the annotated dataset referring only to asset ids that are really drawn; every dataset being a complete openable project; and the scaling series being one span per route. **Counts only — no timing is asserted**, because a duration depends on the machine | Asset id forms, alias resolution, first-writer-wins, registry round trips, spans ↔ edges |
| `schema_fields.test.js` | 14 | Unknown-field policy: the original `project.somethingNew` reproduction; unknown envelope, `metadata`, route (`spanns`), load and placement fields with their exact paths; dynamic asset-id maps accepting canonical ids, coordinate spellings and unknown ids; a v1/v2 document judged against its own contract while a v1 file carrying a v3 field is refused; a future version still refused for the version reason; all-or-nothing; the serializer's output accepted at all three versions; and the storage layer preserving the unreadable text |
| `constraints.test.js` | 19 | The route and spacing policy: 500 accepted and 501 refused, an over-limit stored count grandfathered - **kept or reduced, never grown**, with every boundary of that rule as a table and a step-by-step walk from 648 down to 500 - clamping at both ends of the field, stored spacing below/above/inside the range described and never corrected, the verdict following an injected clearance requirement, and out-of-range projects (501 spans, 9 px, 300 px) opening unchanged through the parser, a save/reload and a v1 migration |
| `collision_semantics.test.js` | 12 | The clash rule itself, pinned before anything is optimized: disjoint, partly overlapping and wholly contained boxes; edges that touch exactly (no clash at zero margin, a clash at any positive margin); a gap of exactly the clearance versus one thousandth less; a clash counted per obstacle entry so a duplicated obstacle counts twice, and a bare box treated like a wrapper; accepted annotations counted alongside static ones; the frame penalty stacking with a real clash; negative coordinates; zero-height boxes, where the inclusive-edge rule means a flat box overlaps nothing at zero clearance; overlap area as a ranking aid only; and the oracle naming the entries it counted |
| `placement_characterization.test.js` | 24 | The exact-output contract for annotation placement, over the four performance-baseline drawings: the full capture (identity, chosen candidate, centre, collision count, manual flag, leader and arrowhead) compared byte for byte against fixtures recorded **from the unoptimized implementation**; the same for the three export profiles by digest; the exhaustive oracle re-deriving every recorded collision count, so the oracle cannot drift from production geometry unnoticed; record integrity (unique identities, complete columns); the annotated drawing's 50 callouts, 501 span labels, 25 manual load offsets and 101 manual span offsets; byte-identical repeat captures; and the notice present in the preview and absent from the exports. **No timing is asserted** |
| `clearance.test.js` | 9 | Derived marker extents, `requiredSpanLength()` = 35, `requiredClearanceDistance()` = 33, the FPB-box-reaches-a-neighbour failure mode |
| `designations.test.js` | 23 | `Origin:1` vs `A1` vs `TC:1`, per-source counters, branching continuation, never-reissued names, span en dash, reload agreement |
| `export_visibility.test.js` | 11 | Exports hide `Origin`/letters, the switch overrides, the notice never exported, FPB text always drawn |
| `fpb.test.js` | 18 | Box sizing from its label, centring, the `FPB` text, the X suppressed |
| `fpb_clip.test.js` | 13 | Clipping against the rectangle: miss, wholly inside, splitting, endpoint preservation, visible contact |
| `geometry.test.js` | 22 | Directions, spans → edges/poles, sequencing, forward references, shared endpoints, overlap, junctions, branches, the example topology |
| `integration.test.js` | 10 | Route list → network → scene → SVG end to end; the example drawing's counts |
| `load_eligibility.test.js` | 20 | A load on a TC point refused at all four guarded boundaries — creation, move, import and file; `addLoad()` and `reassignLoad()` both fail closed without a resolver or with an unresolvable target, and a rejected move leaves the input untouched; the import planner refuses without both `lookupNode` and `isEligible`; aliased spellings caught at model, reassign, parser and import planner; eligible re-targets keep id, value and unit; orphans still kept; eligible creates still accepted |
| `migration.test.js` | 20 | v1→v2, v2→v3, defaults, warnings, no invented measurements |
| `mini_preview.test.js` | 11 | Fitted viewBox, designation overlay, empty state, scaling of label text |
| `origin_label.test.js` | 13 | The `Origin` word's placement, per-marker-kind behaviour, profile gating |
| `page_format.test.js` | 9 | `cssFormatName`/`cssOrientationName`, `cssPageSize` per layout, `RangeError` for unknown values |
| `pdf_geometry.test.js` | 11 | The single page transform, primitive placement, triangle/rect coordinates, one scale for both axes |
| `pdf_layouts.test.js` | 12 | All four layouts: page size, orientation, fit, `RangeError` for unknown ids and impossible margins |
| `print_fit.test.js` | 13 | `fitSceneToPrintSheet`: aspect preserved, binding axis, box arithmetic, every layout, `RangeError` cases |
| `print_input.test.js` | 11 | `classifyTerminalInput` and the interactive-input helpers |
| `print_tty_state.test.js` | 21 | Terminal/`--layout` argument handling for the headed smoke test |
| `project.test.js` | 29 | Serialise/parse round trip, every refusal code, `sameAuthoredProject`, warnings, and load-id canonicalisation (tests 23–29: alias normalised, canonical preserved, unresolved kept verbatim, input immutability, save/reload, TC eligibility still enforced) |
| `spatial_index.test.js` | 17 | The broad phase of [F13](findings.md#f13-annotation-placement-is-quadratic-in-the-number-of-labels): the grid's count against the exhaustive oracle on every real drawing (every placed position plus 300 generated boxes each, with the frame penalty accounted for separately); boxes spanning many cells found from every cell they touch; an obstacle exactly on a cell boundary found from both sides; negative coordinates and boxes straddling the origin; a duplicated obstacle still counting twice; the same question asked repeatedly giving the same answer (the per-query stamp); an index being local to one pass; counts being independent of the cell size, so no tuning constant leaks into placement; a deterministic 400-obstacle unaligned sweep at four cell sizes; `RangeError` for a bad clearance or cell size; the counting helper applying the frame penalty; and the layer's obstacle set being non-trivial |
| `reconcile.test.js` | 7 | Unresolved records: found, never reattached, never silently moved |
| `recovery.test.js` | 10 | Damaged stored text is preserved, session usable, both discard paths confirmed |
| `render.test.js` | 12 | SVG structure, escaping, draw order, standalone vs inline, background |
| `replacement.test.js` | 15 | Editing and deleting rows; later rows kept and marked invalid |
| `route_identity.test.js` | 11 | Route ids, stability of mid/dst ids across edits, no stealing |
| `schedule_io.test.js` | 31 | CSV/TSV parse and format, delimiter detection, staged plans, replace vs update, refusal codes |
| `schedules.test.js` | 26 | Load and length validation, units, no totals, `isLoadEligible()` (TC excluded), default-length utility |
| `storage.test.js` | 12 | `none`/`ok`/`invalid`/`unavailable`, quota handling, the versioned key |
| `tc_anchor.test.js` | 12 | Base-midpoint anchoring, full leaving span, adaptive shrink only, per-direction apex |
| `tc_clip.test.js` | 7 | Clipping against the triangle: miss, wholly inside, splitting, contact |

Run one file:

```bash
node --test test/geometry.test.js
```

## 4. The browser suite: 355 checks in 17 sections

`npm run test:browser` starts a static server and drives Chromium against the real
`index.html`. It asserts on the **rendered DOM and SVG**, not on internals.

| # | Section | What it proves |
| --- | --- | --- |
| 1 | Point designations | Names are drawn; the map is stable across two reloads; a new branch does not renumber existing poles; names survive a reload |
| 2 | Span designations, TC and FPB naming | One row per physical span; span names; TC keeps a `TC`-style name; FPB is drawn as a box; no X on a marker |
| 3 | Loads, lengths and the incompleteness notice | Three loads on one point; the notice appears while spans are unmeasured; the default length fills only unmeasured spans and never overwrites |
| 4 | Selection and the reference drawing | Row → drawing highlight, drawing → row highlight, the reference panel mirrors the selection |
| 5 | Editing an existing route | Opening the edit form switches it to save mode; a direction change saves with the route's **id preserved** in both the table and the saved file; the load on the edited route's **destination** keeps its derived id (`dst:<routeId>`) even though the point moves, stays resolved, and its callout is redrawn on the moved point; both unrelated route records are byte-identical in the saved project; designations are carried; the direction, load target, value and unit survive a reload |
| 6 | Changing a destination to a TC point | Ticking TC on an edit whose destination carries a load is **refused** with a message naming the load. Includes a **shared junction**: two routes ending at the same coordinate, where only the earlier route's id is a registered asset, so the destination is resolved by its end coordinate — the load is still found and the edit refused, while a load-free shared destination can still become a TC point; the route, the load, its id/value/unit and the edit-in-progress are all preserved; the saved project is still **openable by the parser** and reloads with no recovery banner; a destination with no load can still be made TC, and after removing the load the same transition succeeds |
| 7 | Changing a destination to a TC point (aliased load) | A load stored under a **coordinate alias** (`0,-2`) instead of the canonical id: the alias is proven to resolve to the destination through the registry, the parser **canonicalises** it at the validation boundary, no orphan warning is raised, the schedule panel shows `dst:route-1 pole` unmarked, the callout `callout:dst:route-1` is drawn with `25 kVA`, the edit is refused, the route stays a pole, the canonical id is what a save writes and it survives a reload |
| 8 | Manual annotation placement | Drags a real callout with real pointer events at **three different zooms** - fit, zoomed in twice, zoomed out three times - and for each one checks the whole contract: the stored scene delta equals `pointer delta ÷ zoom`, the plate's SVG `x`/`y` moves by the same amount, and the label moves on screen by exactly the pointer delta. The two non-fit drags apply conversion factors whose ratio equals the ratio of their zooms (measured 3.052 against 3.052), so a raw-pixel implementation cannot pass. Also: zooming and panning leave the stored offset untouched; a genuine reload keeps the scene position and the offset while re-fitting the zoom; re-zooming after that reload still does not move it; dragging changes no route, load, node or span-length data; a click is not recorded as a drag; an annotation with no offset is still placed automatically; and a callout that carries a manual offset keeps it when a second load appears. Two of these are guards against passing for the wrong reason: the saved `loadPlacements` are snapshotted immediately **before and after** the stage pan and must be byte-identical, and the "a click is not a drag" check aims through the same `findGrabPoint` search the drags use and asserts the element at that point belongs to the expected annotation, so a click that landed on something else could not pass |
| 9 | The incomplete-measurement notice does not block labels | Parks a real callout under the notice band with a real drag, then proves the notice no longer takes the press. Covers: the notice is drawn and has `pointer-events: none`; the label really does lie inside the band and the element under its centre belongs to the callout; a drag there stores `pointer ÷ zoom`, the label follows the pointer and the viewport does not move; callout id and load id/target/value/unit are unchanged; the placement survives a reload and the notice is redrawn; an empty part of the band still pans the viewport; and measuring every span removes the notice without disturbing the offset ([F12](findings.md#f12-the-in-drawing-notice-overlay-intercepted-pointer-events-over-the-annotations-beneath-it)) |
| 10 | Spreadsheet and CSV workflow | TSV copy has the designation header; a valid import is staged before applying; cancel applies nothing; an invalid import is refused whole and changes nothing |
| 11 | Export visibility | Both switches start on; each combination changes the exports; the preview is unaffected |
| 12 | PDF output | The PDF is produced, is a real PDF, and contains the expected vector work |
| 13 | Print output, every page layout | For all four layouts: the SVG is sized **explicitly in mm**, fits the printable box, keeps the scene aspect, and the `@page` size is the chosen paper — i.e. **one sheet** |
| 14 | TC marker geometry | The printed leaving span equals the configured spacing; no line inside the triangle; the triangle's outline matches across profiles |
| 15 | Route and spacing limits | The form refuses a 501st span with the message naming 500 and adds no route, while exactly 500 is accepted and drawn. A project this build would not have let anyone author - a 501-span route at 9 px spacing - opens with no recovery banner, keeps both values byte-for-byte, names the over-long route in `#route-warning`, explains the tight spacing in `#spacing-warning` and withholds export; that route is then edited (direction East) **without shortening it**, and the saved file still holds 501 spans. **Progressive reduction** is driven on a 648-span project through the real form: it opens at 648 with the corrected warning, its direction changes with the count kept, 648 → 600 is accepted and survives a reload, 600 → 550 is accepted, 551 is refused with a message naming 550 and the saved route stays at 550, a *new* 501-span route is still refused, and 500 is accepted with the warning gone and 500 → 501 refused again; the route id, direction and its `dst:route-1` load are checked at every step. Typing 8 gives 12 and typing 400 gives 120; a 300 px project opens, is explained and still exports, because wide spacing draws correctly. A project within range shows neither warning ([F1](findings.md#f1-the-form-and-the-project-parser-disagreed-on-documented-limits)) |
| 16 | Unknown project fields are refused, not trimmed | An unknown field stops the project opening; the recovery bar names `document.project.somethingNew`; the seeded route is not applied to the drawing; the stored text is byte-identical afterwards; and the same project without that field opens normally ([F5](findings.md#f5-unknown-keys-in-a-project-file-were-ignored-silently)) |
| 17 | Console | No console errors or unhandled rejections during the whole run |

The route-edit section is the automated guard for the edit path that was previously
untested in the DOM ([findings F2](findings.md#f2-an-edited-route-is-now-covered-by-a-browser-test)).
It is the densest section at 32 checks, because it is the only place the suite asserts
that a point's **identity** survives an edit: the load is attached to the edited route's
destination, whose asset id is derived from the route id, and the callout's bounding box
is compared before and after so the load is proven to follow the moved point.

The print section is the automated guard for the `c39eca9` regression
([Rendering §6.1](07-rendering-and-export.md#61-c39eca9-the-print-fit-ignored-the-sheet-height)).
It captures the print document by stubbing `iframe.contentWindow.print`, so no dialog
opens and the check is repeatable in CI.

## 5. The headed print smoke test

```bash
npm run test:print:headed              # default layout
node scripts/print-dialog-smoke.mjs --layout letter_landscape
```

This opens a **real** browser print dialog for the chosen layout so a human can confirm
what the automated suite cannot: that the sheet is one page, the paper is right and the
drawing is legible. It needs an interactive terminal — when there is no TTY, or stdin
is not a terminal, it detects that (`classifyTerminalInput`, `print_tty_state.test.js`)
and reports that the check is manual rather than hanging.

**Environment variables and outcomes.** `PRINT_WAIT_MS` sets the inspection period
(default `180000`, i.e. 180 s). The script resolves to exactly one of four outcomes,
and only the first is a pass:

| Outcome | Meaning | Exit code |
| --- | --- | --- |
| `acknowledged` | a person pressed **Enter** on a real terminal | 0 |
| `cancelled` | **Ctrl+C** — a deliberate stop, not a timeout | 130 |
| `timed_out` | the period expired with no acknowledgement | non-zero |
| `input_unavailable` | stdin is not an interactive terminal (or setRawMode is missing) | 1, immediately |

A pipe cannot acknowledge the check: `printf '\n' | npm run test:print:headed`
returns `input_unavailable` rather than a false pass. Only Enter counts; any other
keystroke is ignored and the wait continues. These rules were each added as a fix
(commits `13bde6b`, `701813f`, `debe214`) because the earlier versions acknowledged on
any key, reported Ctrl+C as a timeout, and let a redirected newline pass as a human.

This is the path used for the **manual Chrome print-dialog validation of Letter
landscape**, and the user carried out physical-printer validation separately. See
[Known limitations](10-limitations.md#7-validation-status-by-area).

## 6. Annotation placement: the exact-output contract

Annotation placement is the one part of the drawing that is *chosen* rather than computed:
each label takes the first candidate position that hits nothing, and the least-bad one when
every candidate hits something. That makes it sensitive to the smallest change in the
collision check — an obstacle that a faster search misses does not throw, it simply moves a
label to the next candidate, and from then on the same project exports a different sheet.

Finding [F13](findings.md#f13-annotation-placement-is-quadratic-in-the-number-of-labels)
is a performance defect in that check, so it is fixed under a contract rather than a hope:

> For all four performance-baseline drawings, every automatically placed annotation keeps
> its identity, its chosen candidate, its exact centre, its collision count and its manual
> flag. Byte for byte. A faster algorithm that moves one label is rejected.

Three things make that checkable:

**The capture.** `test/support/placement_capture.mjs` builds each drawing through the real
pipeline (`buildNetwork` → `buildScene`) and serializes every placement record as one
pipe-separated line: kind, id, asset id, centre x and y, side, candidate index, collision
count, manual flag, font size, text lines, span endpoints and measured flag, the leader
endpoints, and the arrowhead's tip and three points. The column order is written into each
fixture's header, so a diff can be read without the source. The format is positional
because a 501-span drawing is otherwise a quarter of a megabyte.

**The fixtures.** `test/fixtures/placement/<dataset>.txt` holds those captures for
`A-example`, `B-medium`, `C-large` and `D-surveyed`
([11-performance-baseline.md §3](11-performance-baseline.md#3-the-datasets)). They were
generated by running the capture against the **unoptimized** code, which is what makes them
a contract instead of a snapshot. The export profiles use a different page frame, so their
placements differ from the preview's by design; rather than store four captures per drawing
they are pinned by a sha256 digest per drawing in
`test/fixtures/placement/export-digests.json`, checked for `pdf`, `svg` and `print`.

**The oracle.** `test/support/exhaustive_collisions.mjs` keeps the pre-optimization scan —
every obstacle, every already-placed annotation, then the frame test — and nothing under
`src/` imports it. It imports production's `boxAround` and `annotateCollides` rather than
copying them, so only the loop is duplicated, and
`placement_characterization.test.js` replays every captured collision count through it. If
the oracle's geometry ever drifted from production, the replay fails instead of quietly
agreeing.

Regenerating a fixture is a deliberate act, and it is only legitimate when the *policy*
changed on purpose:

```bash
node -e "import('./test/support/placement_capture.mjs').then(async (c) => {
  const fs = await import('node:fs');
  const { scenarios } = await import('./scripts/benchmark-datasets.mjs');
  for (const s of scenarios()) {
    fs.writeFileSync('test/fixtures/placement/' + s.name + '.txt', c.captureProject(s.project));
  }
});"
```

A diff in those files is a diff in what the tool draws. It is never a fixture to "update"
to make a build green.

**The fix itself** then replaced the scan with a per-scene uniform grid
([12-annotation-placement.md](12-annotation-placement.md)) and was accepted only because
every one of those fixtures still matched: `test/spatial_index.test.js` compares the grid's
count with the oracle over the real obstacle sets and over adversarial geometry (multi-cell
boxes, cell boundaries, negative coordinates, degenerate boxes, duplicated obstacles, an
unaligned sweep), and asserts that the answer does not depend on the cell size. Two
deliberately wrong broad phases were applied and reverted — a query cell range shrunk by one
cell (both equivalence tests fail on all four drawings) and obstacles deduplicated on insert
(the duplicate-count test fails) — so the suite is known to be able to see this class of
defect rather than merely passing.

## 7. Test strategy: what is tested and why

The suite is organised around **contracts**, not around files:

1. **Pure functions get exact assertions.** `buildNetwork`, `buildScene`,
   `fitSceneToPrintSheet`, `serializeProject` and the CSV parser are all
   deterministic functions of their arguments, so tests assert on values, not on
   "looks right".
2. **Every refusal code has a test that produces it.** The project validator's 20
   codes and the importer's 7 codes are each reachable in the suite, so a code cannot
   be dead or unreachable.
3. **Regressions are pinned by the rule they broke.** `tc_anchor.test.js` exists
   because of `dca41d5`; `print_fit.test.js` and the browser print section exist
   because of `c39eca9`.
4. **The pairing between exports and the preview is tested as a property, not a
   snapshot.** Tests compare *derived* values (the leaving span equals the configured
   spacing; the visible pieces still meet the marker) so they stay valid when sizes
   change.
5. **End-to-end counts are asserted.** `integration.test.js` and
   `geometry.test.js` pin the example drawing at 34 nodes / 33 edges / the endpoint
   set, so a change in the walk shows up immediately.
6. **DOM-free by construction.** Nothing in `test/` loads a browser; nothing in
   `src/geometry/` or `src/data/` needs one. This is why 581 tests run in ~2.5 s.

### Performance is measured, not guarded

There is a seventh rule with a deliberate exception: **timings are never asserted.** The
two benchmark commands produce numbers
([11-performance-baseline.md](11-performance-baseline.md)), and no test fails when those
numbers change, because a duration depends on the machine — a threshold would fail on a
slower laptop while the code was fine, and a generous one would never catch anything.

What *is* asserted is the input to the measurement: `benchmark_datasets.test.js` pins the
dataset sizes and the properties that make them legitimate drawings. If the sizes drift,
the documentation's numbers become unattributable and the test says so; if the code gets
slower, only a same-machine before/after comparison will show it, which is what the
benchmark is for.

## 8. Writing a new test

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNetwork } from '../src/geometry/network.js';

test('a descriptive sentence stating the property', () => {
  const network = buildNetwork([
    { id: 'route-1', from: 'origin', direction: 'south', spans: 2 },
  ]);
  assert.equal(network.ok, true);
  assert.equal(network.graph.edges.size, 2);
});
```

Conventions used throughout the suite:

- A test name is a **sentence about behaviour**, not a method name — "a span walked
  twice keeps one id and one length", not "testAddEdge2".
- Prefer a value assertion to a snapshot. Where a snapshot-like check is unavoidable,
  assert a **property** of the output (counts, ratios, containment).
- A test that guards a fixed defect names the defect in its title or a comment, so a
  future developer knows why it may not be deleted.
- Tests are grouped in blocks with a lettered prefix (`A.`, `B.`, …) when one file
  covers several sub-properties, which makes a failure name the area.

There is no test file for the UI beyond the browser suite: `app.js` and
`network_panel.js` have no unit tests because they are DOM-bound. Anything in them
worth a unit test should be extracted into a DOM-free module instead (as
`clearance.js`, `print.js`, `schedule_io.js` and `project.js` were).

## 9. Changing a tunable

Every drawing dimension lives in `DEFAULT_CONFIG` in
[src/config.js](../src/config.js). Because `requiredSpanLength()` is *derived* from
the same values, changing a marker size automatically moves the spacing floor.

Checklist when changing one:

1. Edit `DEFAULT_CONFIG` (or a `PAGE_LAYOUTS` entry) — nowhere else.
2. Re-read `requiredSpanLength()`: the printed minimum changes. `clearance.test.js`
   asserts the number and the derivation; update the assertion **only** if the new
   value is intended.
3. If a browser check asserts a size in mm, it will fail by design — the check is
   *"the drawing fits the printable box"*, so it should keep passing; a check that
   pins an absolute number must be justified.
4. Run `npm test` (fast) and then `npm run test:browser`.

Do not add a second copy of a size in a renderer. If a renderer needs a dimension, it
reads `scene.config.*`; if a geometry module needs one, it takes `configOverrides` and
calls `createConfig()`.

## 10. Working on the code: rules that keep the architecture intact

These are the invariants the test suite and the module boundaries depend on
([Architecture §8](03-architecture.md#8-dependency-rules)):

1. **No DOM below the UI layer.** `src/geometry/**` and `src/data/**` must not import
   `src/ui/**`, `src/render/**`, or touch `document`/`window`/storage.
2. **No network geometry in a renderer.** A renderer turns scene primitives into
   output syntax. If you find yourself computing a coordinate in `pdf.js`, the value
   belongs in the scene.
3. **One transform per export.** `tx`/`ty` in the PDF and the two `fit*` functions are
   the only place a scale is applied, each for its own output. Never scale twice.
4. **The scene is the contract.** Add a field to the scene rather than teaching each
   renderer to derive it.
5. **Never mutate a frozen profile.** Wrap it (`{...profile, showNodeLoads: …}`).
6. **Ids come from the registry.** Do not build an asset id by hand outside
   `assets.js`; do not treat a designation as a key.
7. **A length never moves the drawing.** `applyMeasuredChange` must never touch
   `state.routes`.
8. **An invalid row is never dropped.** Errors are data; the authored list is
   authoritative.
9. **Refuse the whole file, not half of it.** Any new project field must be validated
   before anything is applied, and get a new refusal code if it can be wrong.
10. **Never reissue a name.** A new designation must come from the allocator fed with
    the stored table.

### Before you commit

A commit is only ready when the documents it affects are already correct **in the same
commit**, and when [CHANGELOG.md](../CHANGELOG.md) has an entry. Both rules are stated in
full in [CLAUDE.md](../CLAUDE.md#related-documents-must-be-updated-before-the-commit).

The short version:

1. Run `npm test` and `npm run test:browser`, and use the counts they print. Test counts
   and browser-section numbers live in several files at once and drift silently.
2. If you added a browser section, **remap every later section number** — the feature
   matrix cites them by number.
3. If you retitled a heading, fix any anchor links to it (the slug changes with the heading text).
4. Add the changelog entry, naming the commit. Every change counts, including a comment,
   a typo, a renamed test or a documentation-only edit.

## 11. Manual validation

Automated coverage has limits. These are checked by hand and the result recorded here:

| Check | Status |
| --- | --- |
| Automated one-page print fit, all four layouts | **Validated** — `test-browser.mjs` |
| Letter landscape in the real Chrome print dialog | **Validated manually** |
| Physical printer output | **Validated by the user** (external) |
| A4 portrait, A3 landscape in a real print dialog | **Not validated manually** — automated only |
| Firefox, Safari, mobile browsers | **Not validated** |
| Very large drawings (hundreds of routes) | **Not validated** — no performance baseline |
| Screen readers / keyboard-only operation of the preview canvas | **Not validated** |

## 12. Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| `npm run test:browser` fails immediately naming Playwright | Browser binaries missing | `npx playwright install chromium` |
| `Cannot find module` on `import './x.js'` | Extension omitted | Every relative import needs `.js` |
| The app loads but the buttons do nothing | `vendor/jspdf` failed to load, or a module threw during `boot()` | Check the console; the PDF button needs `window.jspdf.jsPDF` |
| A test asserts a size and fails after a tunable change | An absolute number is pinned | Prefer a property assertion; only update the number if the change is intended |
| The print smoke test exits without a dialog | No interactive terminal (expected on CI) | It reports this rather than hanging; use the automated print section instead |
| `localStorage` unavailable, notice shown | Private window / site data blocked | Expected; the tool keeps working and says to use Save project |
