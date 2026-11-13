# Known limitations

Honest, specific statements of what this tool cannot do, with the reason and — where
one exists — the workaround. Nothing here is a bug report; genuine defects found while
writing this documentation are in [findings.md](findings.md).

## Contents

1. [A branch can only start from a named point](#1-a-branch-can-only-start-from-a-named-point)
2. [Designation confirmations depend on the drawing's orientation](#2-designation-confirmations-depend-on-the-drawings-orientation)
3. [The drawing is not to scale](#3-the-drawing-is-not-to-scale)
4. [Loads are never summed or converted](#4-loads-are-never-summed-or-converted)
5. [Only four page layouts, one sheet](#5-only-four-page-layouts-one-sheet)
6. [No server, no accounts, no collaboration](#6-no-server-no-accounts-no-collaboration)
7. [Validation status by area](#7-validation-status-by-area)
8. [Accessibility and input limits](#8-accessibility-and-input-limits)
9. [Data interchange limits](#9-data-interchange-limits)
10. [Form and model disagree in two places](#10-form-and-model-disagree-in-two-places)

---

## 1. A branch can only start from a named point

**What.** A route's **From** must be the Origin or an existing *destination* (an
alphabetical point, a TC, an FPB). There is no way to say "branch east from `A2`",
even though `A2` is a drawn pole with a designation.

**Why.** `buildNetwork` resolves `from` through an endpoint registry
(`registry.resolve()` in [src/geometry/network.js](../src/geometry/network.js)), and
`availableSources()` in [src/ui/state.js](../src/ui/state.js) offers only what that
registry holds. Intermediate poles are not endpoints; they are `mid:<routeId>:<k>` asset
ids with no endpoint record. The model has never had "branch from an arbitrary pole".

**Consequence.** Every junction the tool can create is either (a) a crossing of two
perpendicular spans, or (b) a named point. A tee off the middle of a run cannot be
drawn.

**Workaround.** Split the run into two routes at the branch point and make that point
the destination of the first (e.g. give it a TC or an endpoint), then branch from it.
That adds a visible endpoint to the drawing, which changes the sheet.

**Status.** Unsupported by design. Adding it would be a model change, not a UI change.

## 2. Designation confirmations depend on the drawing's orientation

**What.** A TC's apex points *back along the arriving cable*, and that direction comes
from the route that first created the point (`createdByDirection`). A point that no
route arrives at — the **Origin declared as a TC or FPB** — has no incoming direction
and falls back to `DEFAULT_MARKER_DIRECTION = 'south'`, i.e. the apex points up the
sheet.

**Why.** A marker with no arrival has no "incoming cable" to align to. A fixed default
is the only deterministic choice.

**Consequence.** Change the first route's direction and an Origin-TC's triangle is
still drawn the same way. For a TC in the middle of a chain the apex correctly follows
the arriving route.

**Status.** By design.

## 3. The drawing is not to scale

**What.** Every span is drawn at exactly the same pixel length
(`state.spanLength`, default 40). A measured span of 12 m and a span of 90 m look
identical on the sheet.

**Why.** The drawing is a **topological and structural** drawing: it answers "what
connects to what, in what order, with what on it", not "how long is this in metres".
Making it metric would require a single scale for the whole network, and a real
installation's spans vary enough that either the drawing overflows the sheet or some
spans become unreadable specks.

**Consequence.** Measured lengths are shown as **labels**. A reader must read the label;
they cannot measure the sheet. This is also why the TC is anchored so the leaving span
stays a full configured span — so that a reader *counting* poles is never misled.

**Status.** By design. Documented in
[Route and geometry §2](04-route-and-geometry.md#2-span-to-distance-mapping).

## 4. Loads are never summed or converted

**What.** There is no total kVA, no per-branch subtotal, no unit conversion between
kVA, kW, kVAr and HP. Three loads on one pole appear as three lines in one callout.

**Why.** A total would require assuming a power factor and a simultaneity/diversity
factor. Converting HP to kVA needs an efficiency and a power factor. The tool refuses
to invent those numbers, because a plausible-looking total that is wrong is worse than
no total.

**Consequence.** Balancing or sizing from the drawing requires the reader to add the
callouts themselves.

**Status.** By design; see the comment in
[src/data/schedules.js](../src/data/schedules.js).

## 5. Only four page layouts, one sheet

**What.** A4 landscape, A4 portrait, A3 landscape, Letter landscape. The drawing is
always scaled to fit **one** sheet. There is no custom paper size, no A5/A2/A1/A0, no
plotter roll, and no way to split a large network across several sheets.

**Why.** Four layouts is what the output requirement specified, and one-sheet fitting
is what makes the print path correctable — see the `c39eca9` regression in
[Rendering §6.1](07-rendering-and-export.md#61-c39eca9-the-print-fit-ignored-the-sheet-height).
Multipage tiling is a substantially different problem (sheet overlap, match marks,
sheet indexing).

**Consequence.** A very large network is scaled down to fit, so its text gets small.
At some size the drawing stops being readable, and the tool does not warn about this —
it only guarantees that it fits.

**Workaround.** Use A3 landscape for large drawings. There is no other lever.

**Status.** By design.

## 6. No server, no accounts, no collaboration

**What.** There is no backend. The project lives in this browser's `localStorage` and
in files you download. There is no sharing, no revision history, no multi-user editing,
no audit trail.

**Why.** The tool is designed to run offline from the local filesystem with no
network access at all — which is a requirement in a substation, a basement or a
restricted office machine.

**Consequence.** Two people cannot work on one drawing at once, and a lost laptop loses
whatever was not saved as a file. There is also **no undo**: the only way back from a
wrong edit is to fix it by hand or reload a saved file.

**Status.** By design. Given the absence of undo, **Save project** before risky edits.

## 7. Validation status by area

This is the single most important limitation section. What follows is what has and has
not been demonstrated.

### Verified automatically

- The whole domain layer: **485 Node tests across 30 files**, all passing on the
  current working tree.
- The application in a real browser: **298 checks in 14 sections**, all passing,
  including one-page print fit for **all four layouts** and the TC geometry on the
  printed sheet.

### Verified manually

- **Letter landscape** in the real Chrome print dialog.
- **Physical printer output** — carried out by the user, outside this repository. It is
  not reproducible here and there is no artefact of it in the repo.

### Incomplete validation

| Area | What was not done | Risk |
| --- | --- | --- |
| **A4 portrait and A3 landscape printing** | Never opened in a real print dialog; automated fit check only | Low — the fit arithmetic is identical across layouts and tested; but paper selection has not been seen with a human eye |
| **A label under the completeness notice cannot be dragged** | The in-drawing notice is hit-testable and is drawn above the callouts, so a press on it pans the viewport instead of moving the label ([F12](findings.md#f12-the-in-drawing-notice-overlay-intercepts-pointer-events-over-the-annotations-beneath-it)) | Low–Medium — only while a survey is incomplete; measuring the spans removes the notice |
| **Editing a route in place** | `startEdit()` / "Save changes" has no automated test | Medium — a common operation guarded only by hand testing |
| **Row delete button** | The engine path is tested (`route_identity.test.js` 7) but not the button | Low |
| **Firefox and Safari** | Never run | Medium — no browser-specific code, but untested |
| **Touch devices / pinch zoom** | Pointer events are used; pinch-to-zoom is not implemented | Medium on tablets |
| **Locale decimal input** | `<input type="number">` treats `,` differently per browser | Low |
| **Large drawings** | No performance baseline; no test beyond the example's 34 nodes | Medium — annotation placement is a search, and its cost at hundreds of nodes is unknown |
| **Keyboard-only operation** | Forms are native HTML but never tested without a pointer | Medium |

### Not validated at all

- Any mobile or tablet layout (the UI assumes a desktop viewport).
- Screen readers against the drawing.
- Any paper other than the four layouts.
- Printing from Firefox or Safari.

## 8. Accessibility and input limits

**What.**

- The preview canvas is an SVG with no text alternative. A screen reader cannot read
  the drawing.
- Zoom, pan and pole/span selection require a pointer. There is no keyboard path to
  selecting a pole in the drawing.
- The **schedules** are the accessible record: they are real HTML tables with columns,
  so the loads and lengths are reachable by keyboard and assistive technology, and the
  drawing is a presentation of the same data.
- There is no dark mode, no high-contrast variant, no theme, and no font-size control
  beyond browser zoom.
- The interface is **English only**. The span separator is a literal en dash (`U+2013`)
  and an unmeasured length is a literal em dash (`—`).

**Status.** By design for the current scope.

## 9. Data interchange limits

| Limitation | Detail |
| --- | --- |
| CSV/TSV only | No `.xlsx`, no JSON import for schedules, no ODS |
| No CAD/GIS formats | No DXF, DWG, KML, GeoJSON, Shapefile |
| CSV export includes load-less nodes | The node-load file lists **every eligible node**, with blank `loadId`/`value`/`unit` for those without a load; it is an inventory, not a list of loads. A reader who expects only rows with numbers will be surprised |
| CSV columns are fixed | Seven columns for spans, six for loads; there is no column mapping |
| Import is all-or-nothing | A single malformed row refuses the entire file — there is no partial import and no per-row skip |
| One project per browser | A second project replaces the first in `localStorage`; keeping several means keeping several files |
| Clipboard fallback | On `file://` the async clipboard API is unavailable, so the tool falls back to `document.execCommand('copy')`; if even that fails the status line tells you to use **Export CSV** |

## 10. Form and model disagree in two places

Two limits exist **only in the form**, and a project file can legitimately exceed
them. This is a deliberate asymmetry, but it has consequences.

| Limit | Form | Engine / file format | Consequence |
| --- | --- | --- | --- |
| Spans per route | 500 max ("Use 500 spans or fewer for one route.") | Any integer > 0 | A hand-edited project file can contain a 10 000-span route, and it will be drawn. The form will refuse to create one, and editing that row is awkward |
| Span spacing | Clamped to 12…120 px on `change`, and the input's `min` is set at boot to `requiredSpanLength()` (35) | Any positive finite number | A file with spacing 8 opens, shows the tight-spacing warning and disables export. A file with spacing 400 opens and exports fine |

Both are safe (the engine and the loaders validate independently) but they mean **the
file format is the more capable interface**. Documented rather than harmonised, because
changing either side would be a behaviour change, not a documentation fix.

## 11. Smaller limits worth knowing

| Limit | Detail |
| --- | --- |
| No junction symbol | `showJunctionMarkers` is `false` in all four profiles; a crossing is drawn as an ordinary pole. Junctions exist in the model and are used for hit targets and annotation obstacles |
| No label editing | You cannot rename a pole by hand in the UI. Designations are allocated and never user-edited — the only way to change one is to load a project file whose `nodeDesignations` table carries a different name, and the file is validated so two points cannot share one |
| No route reordering | Rows are evaluated in entry order. You cannot drag a row to a new position; re-enter it |
| Undo | None |
| The example is the only fill-in aid | Beyond default lengths and a CSV import, there is no bulk route entry |
| Annotation dragging is per-record | There is no way to select several callouts and move them together, and no reset-to-automatic |
| Export switches are per project | `exportLoads`/`exportLengths` are saved with the project and travel with the file, so a colleague opening your file exports the same sheet you intended |
| The completeness notice is preview-only | It is never exported, so a PDF does not say that some spans are unmeasured |
