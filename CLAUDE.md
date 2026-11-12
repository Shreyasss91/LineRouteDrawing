# CLAUDE.md

Guidance for AI agents and developers working in this repository. Everything here is
checked against the code in this tree. When this file and the code disagree, the code
wins — and this file should be corrected.

## What this project is

An **offline browser tool** that converts sequential electrical route instructions
("from this point, go South for 3 spans, end at a TC point") into a line-route drawing,
exported as vector PDF, editable SVG, or a printed sheet.

- No backend, no database, **no network access at runtime**, no build step, no bundler.
- `index.html` loads ES modules directly; the only third-party code is jsPDF, vendored
  at `vendor/jspdf/`.
- Single-page app, one framework-free controller.

Read [`documentation/README.md`](documentation/README.md) first for the full picture.
The documents that matter most when changing code:

| Document | Why you need it |
| --- | --- |
| [03-architecture](documentation/03-architecture.md) | module responsibilities and the dependency rules |
| [04-route-and-geometry](documentation/04-route-and-geometry.md) | coordinates, the graph, marker geometry |
| [05-persistence](documentation/05-persistence.md) | the exact project file schema and refusal codes |
| [06-identity-and-data](documentation/06-identity-and-data.md) | asset ids vs designations — the most common source of bugs |
| [08-testing](documentation/08-testing.md) | how to run and add tests |
| [10-limitations](documentation/10-limitations.md) | what is genuinely unsupported |

## Commands

```sh
node scripts/serve.js          # run the app: http://127.0.0.1:8080/
node scripts/serve.js 3000     # or pick a port

npm test                       # 458 Node tests, no dependencies needed (~1.2s)
npm run test:browser           # 198 browser checks (needs Playwright + Chrome)
npm run test:print:headed      # manual print-dialog check; needs a real terminal
```

Requirements: **Node >= 20**, `"type": "module"` (every relative import needs the
`.js` extension). Playwright is a dev dependency only
(`npm install --no-save playwright`); the browser suite uses installed Google Chrome
via `channel: 'chrome'`, or `BROWSER_CHANNEL=chromium`.

**Always run `npm test` before saying work is done.** If you touched rendering, export,
layout or the browser UI, also run `npm run test:browser`.

## Repository layout

```
index.html            the whole UI shell (script tags + all DOM the controller touches)
styles/app.css        styling, including the print stylesheet
src/config.js         DIRECTIONS, RENDER_PROFILES, PAGE_LAYOUTS, DEFAULT_CONFIG, EXAMPLE_ROUTES
src/geometry/         the domain: NO DOM, fully unit-testable
src/data/             schedules and CSV/TSV transfer: NO DOM
src/render/           scene -> SVG / PDF / print fit: NO DOM
src/ui/               state, controller, schedules panel, persistence
scripts/              serve.js, test-browser.mjs, print-dialog-smoke.mjs
test/                 29 node:test files
vendor/jspdf/         jsPDF 4.2.1 (MIT), vendored and pinned
documentation/        the documentation set
```

## Architecture rules — these are load-bearing

Violating these breaks the single-source-of-truth design and the test suite's ability to
run without a browser. They currently hold; keep them holding.

1. **No DOM below the UI layer.** `src/geometry/**`, `src/data/**` and `src/render/**`
   must not touch `document`, `window`, `localStorage`, or import from `src/ui/**`.
2. **No network geometry in a renderer.** `render/pdf.js` and `render/svg.js` turn scene
   primitives into output syntax. If you find yourself computing a coordinate there, the
   value belongs in `buildScene()`.
3. **One transform per export.** `tx`/`ty` in `render/pdf.js`, `fitSceneToPage()` (points)
   and `fitSceneToPrintSheet()` (millimetres) are the only places a scale is applied.
   Never scale twice — that was the defect in commit `e48b67c`.
4. **The scene is the contract.** Add a field to the scene rather than teaching each
   renderer to derive it.
5. **Never mutate a frozen profile.** Wrap it: `{...profile, showNodeLoads: false}`.
   That is how the two export switches are applied.
6. **Ids come from the registry.** Do not hand-build an asset id outside
   `src/geometry/assets.js`. Never use a designation as a key.
7. **A measured length never moves the drawing.** `applyMeasuredChange()` must never
   touch `state.routes`. Spacing is a layout choice; a length is a survey.
8. **An invalid row is never dropped.** Errors are data; the authored route list is
   authoritative and order is semantic.
9. **Refuse the whole file, never half-apply.** Any new project field must be validated
   before anything is applied, and needs a refusal code if it can be wrong.
10. **Never reissue a designation.** New names come from `allocateDesignations()` seeded
    with the stored table, so a deleted pole's name is never reused.
11. **Every tunable dimension lives in `src/config.js`.** A renderer reads
    `scene.config.*`; a geometry module takes `configOverrides` and calls `createConfig()`.
    No second copy of a marker size anywhere.

## Key facts you must not get wrong

| Fact | Value |
| --- | --- |
| Coordinate convention | Origin `(0,0)`; **North +Y, South −Y, East +X, West −X** |
| Pixel mapping | Y is **flipped** (`y_px = (bbox.maxY − y)·spanLength + padding`) |
| Directions | exactly four, keys `north`/`south`/`east`/`west` (lowercase) |
| Default span spacing | `40` px; UI clamp 12…120 |
| Minimum workable spacing | **35 px**, derived by `requiredSpanLength()` — never hardcode it |
| Symbols-overlap limit | **33 px**, `requiredClearanceDistance()` |
| Page layouts | `a4_landscape` (default), `a4_portrait`, `a3_landscape`, `letter_landscape` |
| Print margin | `MARGIN_MM = 10`; PDF margin `pdfMarginPt = 28` |
| Project format | `line-route-drawing-project`, `schemaVersion: 3`, supported 1–3 |
| `originMarker` values | **`plain` / `tc` / `fpb`** (not `pole`) |
| Storage key | `line-route-drawing:v3:project` |
| Load units | `kVA` (default), `kW`, `kVAr`, `HP` — never summed, never converted |
| TC / FPB eligibility | A TC point is **not** load-eligible (`isLoadEligible()`), enforced by the UI pickers and CSV export — **not** by `addLoad()` or the project parser (see F10) |
| Span separator | en dash `U+2013` (`A1–A2`); unmeasured label is `— m` |

### The two identity systems are different things

- **Asset id** = immutable identity (`origin`, `dst:route-3`, `mid:route-2:0`,
  `a~b` for spans). This is what records are stored against.
- **Designation** = human-readable name (`A`, `A1`, `Origin:2`, `TC:1`). This is display
  and schedule text only.

Node numbering is `Origin:1` / `A1` / `TC:1` — the **colon** distinguishes a pole
(`TC:1`) from the point (`TC`). TC/FPB numbering keys on **destination count**
(`tcCount` / `fpbCount`), not on drawn symbols, so an FPB Origin plus one FPB
destination draws two boxes both labelled `FPB`.

## Testing conventions

- A test name is a **sentence about behaviour**, not a method name.
- Prefer value assertions to snapshots. Where a snapshot-like check is unavoidable,
  assert a **property** (counts, ratios, containment).
- A test guarding a fixed defect should name the defect, so a future reader knows why it
  cannot be deleted (e.g. `test/tc_anchor.test.js` for `dca41d5`,
  the print section for `c39eca9`).
- Anything in `app.js` or `network_panel.js` worth unit-testing should be **extracted**
  into a DOM-free module first — that is how `clearance.js`, `print.js`,
  `schedule_io.js` and `project.js` came to exist and be testable.
- Every refusal code (`project.js`, `schedule_io.js`) must be reachable from a test.

## Things that are deliberately the way they are — do not "fix" them

- **The TC triangle is anchored on its downstream base midpoint**, extending backwards
  over the arriving cable, so the leaving span stays a full configured span
  (`dca41d5`). Do not centre it on the node.
- **The drawing is not to scale.** Every span is drawn the same length; lengths are
  labels, never distances. This is the design, not a bug.
- **Loads are never summed or converted** — that would require inventing a power factor.
- **A branch can only start from a named point**, not from an intermediate pole.
- **The completeness notice is preview-only** and never appears on an export.
- **Exports hide the drawing's own text** (`Origin`, letters) but keep FPB text, loads
  and span lengths (subject to the two switches).
- **Designations are authored data**, persisted and never re-derived on load.
- **`width:100%` is forbidden for the print SVG.** The print SVG gets an explicit
  millimetre size from `fitSceneToPrintSheet()`; `width:100%` ignores sheet height and
  split the drawing across two pages (`c39eca9`).

## Workflow

- Branch from `main`; do not rewrite or amend published history.
- Write a detailed commit message: **what changed, why it was needed, how it works, and
  the validation evidence** (actual test counts, commands run).
- Do not commit `artifacts/`, `temp/` or `node_modules/` — they are gitignored; keep them
  that way.
- Do not say something is fixed until you have run the test that proves it, and state
  plainly what you checked and what you did not.

## Known gaps

See [documentation/findings.md](documentation/findings.md). The ones most likely to bite:

- **Editing an existing route row has no automated test** (`startEdit()` path) — a
  regression there would be caught only by hand.
- Drag-at-zoom is implemented but unverified.
- A4 portrait and A3 landscape have only automated print verification; Letter landscape
  was validated by hand in Chrome.
- Firefox, Safari, touch and mobile are untested.
- No performance baseline beyond the example's 34 nodes.
