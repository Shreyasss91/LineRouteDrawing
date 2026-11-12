# Testing and development guide

## Contents

1. [Requirements](#1-requirements)
2. [Commands](#2-commands)
3. [The Node suite: 468 tests in 30 files](#3-the-node-suite-468-tests-in-30-files)
4. [The browser suite: 221 checks in 12 sections](#4-the-browser-suite-221-checks-in-12-sections)
5. [The headed print smoke test](#5-the-headed-print-smoke-test)
6. [Test strategy: what is tested and why](#6-test-strategy-what-is-tested-and-why)
7. [Writing a new test](#7-writing-a-new-test)
8. [Changing a tunable](#8-changing-a-tunable)
9. [Working on the code: rules that keep the architecture intact](#9-working-on-the-code-rules-that-keep-the-architecture-intact)
10. [Manual validation](#10-manual-validation)
11. [Troubleshooting](#11-troubleshooting)

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
| `npm test` | `node --test "test/*.test.js"` | **468 tests, 468 pass, 0 fail** |
| `npm run test:browser` | `node scripts/test-browser.mjs` — starts `scripts/serve.js`, drives Chromium, asserts, exits | **221/221 checks pass** |
| `npm run test:print:headed` | `node scripts/print-dialog-smoke.mjs` — opens a real print dialog | manual, needs an interactive terminal |
| `npm run serve` | static server for manual use | serve locally, then open the printed URL |

Verified on this working tree: `npm test` → `tests 468, pass 468, fail 0`; the suite
takes about 1.2 s.

`npm run test:browser` requires the Playwright browser binaries. `test-browser.mjs`
resolves Playwright at runtime (`loadPlaywright()`) and fails with a message naming the
install command if it is absent, rather than a stack trace.

The browser suite writes its downloads and diagnostics into a temp directory; nothing
it produces is committed.

## 3. The Node suite: 468 tests in 30 files

The whole domain layer is DOM-free, so it is tested directly under Node. Files and
their test counts:

| File | Tests | What it pins |
| --- | --- | --- |
| `annotations.test.js` | 37 | Candidate positions, text measurement, leader/arrowhead geometry, collision avoidance, callout content, span-label placement, manual offsets |
| `assets.test.js` | 15 | Asset id forms, alias resolution, first-writer-wins, registry round trips, spans ↔ edges |
| `clearance.test.js` | 9 | Derived marker extents, `requiredSpanLength()` = 35, `requiredClearanceDistance()` = 33, the FPB-box-reaches-a-neighbour failure mode |
| `designations.test.js` | 23 | `Origin:1` vs `A1` vs `TC:1`, per-source counters, branching continuation, never-reissued names, span en dash, reload agreement |
| `export_visibility.test.js` | 11 | Exports hide `Origin`/letters, the switch overrides, the notice never exported, FPB text always drawn |
| `fpb.test.js` | 18 | Box sizing from its label, centring, the `FPB` text, the X suppressed |
| `fpb_clip.test.js` | 13 | Clipping against the rectangle: miss, wholly inside, splitting, endpoint preservation, visible contact |
| `geometry.test.js` | 22 | Directions, spans → edges/poles, sequencing, forward references, shared endpoints, overlap, junctions, branches, the example topology |
| `integration.test.js` | 10 | Route list → network → scene → SVG end to end; the example drawing's counts |
| `load_eligibility.test.js` | 10 | A load on a TC point refused by `addLoad()` and by the parser (`INELIGIBLE_LOAD_TARGET`); input not mutated; aliased spellings caught; orphans still kept; eligible points still accepted |
| `migration.test.js` | 20 | v1→v2, v2→v3, defaults, warnings, no invented measurements |
| `mini_preview.test.js` | 11 | Fitted viewBox, designation overlay, empty state, scaling of label text |
| `origin_label.test.js` | 13 | The `Origin` word's placement, per-marker-kind behaviour, profile gating |
| `page_format.test.js` | 9 | `cssFormatName`/`cssOrientationName`, `cssPageSize` per layout, `RangeError` for unknown values |
| `pdf_geometry.test.js` | 11 | The single page transform, primitive placement, triangle/rect coordinates, one scale for both axes |
| `pdf_layouts.test.js` | 12 | All four layouts: page size, orientation, fit, `RangeError` for unknown ids and impossible margins |
| `print_fit.test.js` | 13 | `fitSceneToPrintSheet`: aspect preserved, binding axis, box arithmetic, every layout, `RangeError` cases |
| `print_input.test.js` | 11 | `classifyTerminalInput` and the interactive-input helpers |
| `print_tty_state.test.js` | 21 | Terminal/`--layout` argument handling for the headed smoke test |
| `project.test.js` | 22 | Serialise/parse round trip, every refusal code, `sameAuthoredProject`, warnings |
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

## 4. The browser suite: 221 checks in 12 sections

`npm run test:browser` starts a static server and drives Chromium against the real
`index.html`. It asserts on the **rendered DOM and SVG**, not on internals.

| # | Section | What it proves |
| --- | --- | --- |
| 1 | Point designations | Names are drawn; the map is stable across two reloads; a new branch does not renumber existing poles; names survive a reload |
| 2 | Span designations, TC and FPB naming | One row per physical span; span names; TC keeps a `TC`-style name; FPB is drawn as a box; no X on a marker |
| 3 | Loads, lengths and the incompleteness notice | Three loads on one point; the notice appears while spans are unmeasured; the default length fills only unmeasured spans and never overwrites |
| 4 | Selection and the reference drawing | Row → drawing highlight, drawing → row highlight, the reference panel mirrors the selection |
| 5 | Editing an existing route | Opening the edit form switches it to save mode; a direction change saves with the route's **id preserved** in both the table and the saved file; a load on the shared endpoint stays resolved and still drawn; neighbouring routes are untouched; designations are carried; the state survives a reload |
| 6 | Manual annotation placement | Drag a callout; the position survives a reload; a click is not a drag |
| 7 | Spreadsheet and CSV workflow | TSV copy has the designation header; a valid import is staged before applying; cancel applies nothing; an invalid import is refused whole and changes nothing |
| 8 | Export visibility | Both switches start on; each combination changes the exports; the preview is unaffected |
| 9 | PDF output | The PDF is produced, is a real PDF, and contains the expected vector work |
| 10 | Print output, every page layout | For all four layouts: the SVG is sized **explicitly in mm**, fits the printable box, keeps the scene aspect, and the `@page` size is the chosen paper — i.e. **one sheet** |
| 11 | TC marker geometry | The printed leaving span equals the configured spacing; no line inside the triangle; the triangle's outline matches across profiles |
| 12 | Console | No console errors or unhandled rejections during the whole run |

The route-edit section is the automated guard for the edit path that was previously
untested in the DOM ([findings F2](findings.md#f2-an-edited-route-is-now-covered-by-a-browser-test)).

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

## 6. Test strategy: what is tested and why

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
   `src/geometry/` or `src/data/` needs one. This is why 468 tests run in ~1.2 s.

## 7. Writing a new test

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

## 8. Changing a tunable

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

## 9. Working on the code: rules that keep the architecture intact

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

## 10. Manual validation

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

## 11. Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| `npm run test:browser` fails immediately naming Playwright | Browser binaries missing | `npx playwright install chromium` |
| `Cannot find module` on `import './x.js'` | Extension omitted | Every relative import needs `.js` |
| The app loads but the buttons do nothing | `vendor/jspdf` failed to load, or a module threw during `boot()` | Check the console; the PDF button needs `window.jspdf.jsPDF` |
| A test asserts a size and fails after a tunable change | An absolute number is pinned | Prefer a property assertion; only update the number if the change is intended |
| The print smoke test exits without a dialog | No interactive terminal (expected on CI) | It reports this rather than hanging; use the automated print section instead |
| `localStorage` unavailable, notice shown | Private window / site data blocked | Expected; the tool keeps working and says to use Save project |
