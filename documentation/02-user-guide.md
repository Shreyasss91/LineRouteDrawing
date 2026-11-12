# User guide

Every control described here exists in [index.html](../index.html) and is wired in
[src/ui/app.js](../src/ui/app.js) or [src/ui/network_panel.js](../src/ui/network_panel.js).
Control ids are given as `#id` so you can find them in the markup.

## Contents

1. [Layout of the screen](#layout-of-the-screen)
2. [Origin configuration](#1-origin-configuration)
3. [Creating routes](#2-creating-routes)
4. [Editing, selecting and deleting routes](#3-editing-selecting-and-deleting-routes)
5. [Route dependencies and validation](#4-route-dependencies-and-validation)
6. [Branches, shared nodes and overlap](#5-branches-shared-nodes-and-overlap)
7. [TC and FPB markers](#6-tc-and-fpb-markers)
8. [Point designations and naming](#7-point-designations-and-naming)
9. [Node loads](#8-node-loads)
10. [Span lengths and the default-length utility](#9-span-lengths-and-the-default-length-utility)
11. [Selection synchronisation](#10-selection-synchronisation)
12. [CSV export, TSV copy and staged import](#11-csv-export-tsv-copy-and-staged-import)
13. [Moving annotations](#12-moving-annotations)
14. [The drawing reference panel and the full preview](#13-the-drawing-reference-panel-and-the-full-preview)
15. [Span spacing and clearance](#14-span-spacing-and-clearance)
16. [Saving and loading a project](#15-saving-and-loading-a-project)
17. [Recovery when the remembered project cannot be read](#16-recovery-when-the-remembered-project-cannot-be-read)
18. [Exports](#17-exports)

---

## Layout of the screen

Four stacked sections, in this order:

| Section | Heading | Controls |
| --- | --- | --- |
| `.panel-routes` | Route instructions | Origin symbol, the route form, the route table, Save/Load project |
| `.panel-network` | Network data | Node loads / Span lengths tabs, import staging, unresolved bar, drawing reference |
| `.panel-preview` | Drawing preview | Zoom, Fit to screen, Reset view, Span spacing, the canvas |
| `.panel-output` | Output | Page layout, the two export switches, Download PDF / Download SVG / Print |

The preview and the Network data section both draw the same scene; the preview is
the working view, the Network data panel holds a small always-current reference copy
next to the schedules.

---

## 1. Origin configuration

Control: `#field-origin-marker`, `<select>` with **Pole** (default), **TC point**,
**FPB point**.

This is a property of the whole drawing, not of an individual route. Changing it
rebuilds the drawing immediately and is persisted.

What it does:

- The Origin keeps internal id `origin` and grid coordinate `(0, 0)` for every
  choice. Nothing you have already entered refers to a different point.
- **Pole** draws the Origin as an X.
- **TC point** draws a triangle at the Origin and no X, and the Origin behaves as a
  TC point does: a route may still start from it, but a load cannot be placed on
  it (see §8).
- **FPB point** draws the box at the Origin and no X.
- The **From** dropdown names the Origin after the chosen symbol:
  `Origin (Pole)`, `Origin (TC point)` or `Origin (FPB point)`
  (`ORIGIN_MARKER_LABEL` in [src/ui/state.js](../src/ui/state.js)). The id stays
  `origin`, so changing the symbol never invalidates a row.

## 2. Creating routes

Form: `#route-form` with `#field-from`, `#field-direction`, `#field-spans`,
`#field-tc`, `#field-fpb`, submit button `#btn-save-route` ("Add route"),
`#btn-cancel-edit`.

### From

A dropdown of the points available **at the position the new row will occupy**.
The list is produced by replaying the routes that already exist at that position
through the real engine (`availableSources()` → `buildNetwork()` on the prefix), so
it can never offer a point the engine would reject.

When the table is not being edited, the dropdown preselects **the destination of
the most recently created successful route** (`latestSource()`), so a chain of
routes can be entered without reselecting the previous destination. With no routes
yet, the Origin is preselected.

A row being edited keeps its own `from` even if editing another field.

### Direction

`#field-direction`: North, South, East, West. Stored lowercase (`north`, …).

### Spans

`#field-spans`: a whole number. Validation, in this order
(`readForm()` in [src/ui/app.js](../src/ui/app.js)):

| Input | Result |
| --- | --- |
| empty or not a number | "Enter a whole number of spans greater than zero." |
| a decimal | "Spans must be a whole number (no decimals)." |
| `<= 0` | "Spans must be greater than zero." |
| `> 500` | "Use 500 spans or fewer for one route." |

The 500 limit is a **form-level** limit only; the engine has no such cap
(`test/geometry.test.js` and the project parser accept any positive integer).

### TC point / FPB point

Two independent checkboxes, `#field-tc` and `#field-fpb`. They describe the
destination of this route. Ticking both is refused by the form ("A destination is
either a TC point or a feeder pillar box (FPB), not both.") and, independently, by
the engine (`ERROR_CODES.INVALID_MARKER`) and the project parser.

### What Add route does

`handleSubmit()` appends a new row with a fresh id (`createRoute()` →
`route-N`), clears the form, recomputes everything, re-fits the view and persists
the project.

## 3. Editing, selecting and deleting routes

The route table (`#route-rows`) has one row per instruction with columns
`# | From | Direction | Spans | Marker | Status | actions`.

- Clicking any part of a row, or its **Edit** button, loads it into the form
  (`startEdit()`). The submit button becomes "Save changes" and **Cancel edit**
  (`#btn-cancel-edit`) appears.
- **Save changes** replaces the row in place, keeping its id. Every later route is
  re-evaluated by the normal rebuild.
- **Delete** removes the row (`state.routes.splice`) and rebuilds. Later rows that
  depended on it are **kept** and marked invalid, not silently dropped.
- **Status** is `Valid` or `Invalid`; invalid rows get `.is-invalid` styling and the
  reason appears in `#error-list`.
- The **From** cell shows the source's dropdown label, or `not available` when the
  reference cannot be resolved (`describeSource()`).

Two toolbar buttons: **Load example** (`#btn-load-example`) replaces the route list
with `EXAMPLE_ROUTES` from [src/config.js](../src/config.js), resolved to internal
ids by [src/ui/example.js](../src/ui/example.js); **Clear all** (`#btn-clear`)
empties the route list. Both persist immediately — a reload after **Clear all**
shows an empty drawing rather than resurrecting the old one.

## 4. Route dependencies and validation

The engine's rules (`buildNetwork()` in [src/geometry/network.js](../src/geometry/network.js)),
in the order they are applied to each row:

| Code | When | Message shown |
| --- | --- | --- |
| `unknown-source` | `from` is empty | "No starting point selected. Choose the Origin or an endpoint created above." |
| `unknown-source` | `from` has not been created yet | "the starting point "X" has not been created yet. Choose the Origin or an endpoint created by an earlier route." |
| `unknown-source` | the earlier row it referred to failed | "its starting point cannot exist because route N did not resolve." |
| `invalid-direction` | direction not North/South/East/West | ""X" is not a direction. Use North, South, East or West." |
| `invalid-spans` | not an integer, or `<= 0` | "Spans must be a whole number greater than zero." / "(no decimals)." / "greater than zero." |
| `invalid-marker` | both `tc` and `fpB` | "A destination is either a TC point or a feeder pillar box (FPB), not both." |
| `zero-length` | a step would not move | "a span cannot have zero length." (not reachable from the UI, which only offers unit cardinal steps) |

Consequences that matter operationally:

- **Order is authoritative.** A forward reference is reported, never reordered.
- **A failed row creates no destination**, so every later row that used it also
  fails, with a message naming the original cause.
- **Invalid rows are never dropped.** Editing or deleting an earlier row cannot
  lose data you typed.
- **Export is refused while any route is invalid** (`isExportable()`): the three
  output buttons are disabled and their tooltip says "Fix the route errors before
  exporting."

## 5. Branches, shared nodes and overlap

Branches, junctions, shared endpoints, partial overlap and complete overlap are all
handled by the canonical graph, not by special-casing in the UI
([Route and geometry model](04-route-and-geometry.md)). From a user's point of
view:

- Fixing a source to a point created by an earlier row is a **branch**.
- Reaching a coordinate that already carries an endpoint **reuses** that point; it
  does not create a second pole, and the endpoint keeps its existing name.
- A route that walks over edges already drawn draws nothing twice: one physical
  edge is one line and one span record.
- A route crossing another perpendicularly creates a shared node (a junction) at
  the crossing coordinate.
- Re-requesting an existing coordinate as a TC upgrades it to a TC; re-requesting it
  as an FPB upgrades it to an FPB. A point that was already a plain lettered endpoint
  keeps that letter for later reuse.

## 6. TC and FPB markers

- **TC** — triangle. Anchored with its **base midpoint on the node** and its apex
  pointing back along the cable that arrives; the leaving span therefore keeps its
  whole configured length. Sized larger than an X pole marker. Never takes an
  alphabetical letter. Named `TC` when it is the only TC *destination*, `TC1`, `TC2`, …
  otherwise.
- **FPB** — rectangle sized to its own label with `FPB` written inside. Centred on
  the node. Never takes a letter. Named `FPB` when it is the only FPB *destination*,
  `FPB1`, `FPB2`, … otherwise. (An Origin drawn as an FPB does not count towards that
  number, so an FPB Origin plus one FPB destination draws two boxes both labelled `FPB`.)
- Both **replace** the X at their node: no marker ever receives two symbols.
- Route lines are **trimmed against both shapes** in the scene, so no conductor is
  drawn inside the symbol and the line still visually meets it
  (`clipSegmentOutsidePolygon()` in [src/geometry/markers.js](../src/geometry/markers.js)).
- TC triangle size adapts downward: it is capped to a fraction of one span
  (`tcMaxSpanFraction`) and shrunk further when a marker sits immediately upstream,
  so a readable piece of cable always remains. It is never enlarged.
- A destination cannot be both a TC and an FPB.

## 7. Point designations and naming

Every drawn pole has a readable designation; every span has a display name formed
from its two ends. The full rules, including how the numbering continues across
branches and reloads, are in
[Identity, designations and network data](06-identity-and-data.md).

Summary of what you will see:

| Source | Its intermediate poles are named |
| --- | --- |
| Origin | `Origin:1`, `Origin:2`, … |
| `A`, `B`, `AB` (letters) | `A1`, `A2`, … (no colon) |
| `TC` / `TC1` | `TC:1` / `TC1:1`, … |
| `FPB` / `FPB2` | `FPB:1` / `FPB2:1`, … |

Spans read `A1–A2`, `Origin–Origin:1`, `A2–B` (en dash, `U+2013`).

Numbering is **per source point**, continues across branches from that point, and is
**never reissued**: a name that belonged to a deleted pole is not handed to a new one.

## 8. Node loads

Section: Network data → **Node loads** tab (`#tab-loads`).

Form: `#field-load-node` (Point), `#field-load-value`, `#field-load-unit`
(kVA / kW / kVAr / HP), `#btn-add-load`.

- **Eligible points:** `pole`, `fpb`, `origin` (`LOAD_ELIGIBLE_TYPES` / `isLoadEligible()`
  in [src/data/schedules.js](../src/data/schedules.js)). A **TC point is not eligible**.
- This is enforced at both boundaries: `addLoad()` refuses a TC target when given a
  `lookupNode` resolver (which the panel supplies), and the project parser refuses a
  file that carries one with the code `INELIGIBLE_LOAD_TARGET`. The schedule importer
  refuses such a row too. All three resolve the target through the asset registry, so
  an aliased coordinate spelling cannot slip past.
- `test/load_eligibility.test.js` pins both refusals; `test/schedules.test.js` test 15
  and `test/annotations.test.js` test 27 pin the eligibility predicate itself.
- **Value:** must be a finite number `> 0`. Zero is refused rather than treated as
  empty.
- **Default unit:** `kVA` (`DEFAULT_LOAD_UNIT`).
- **Never summed, never converted.** Several records on one pole produce one callout
  with one line each (`loadCalloutLines()`); there is no total and no unit
  conversion.
- The point picker shows `designation (internal id)`, e.g. `C (dst:route-6)`.

The table columns: Point, Internal node ID, Type, Load ID, Value (an editable number
input — editing it keeps the record's identity), Unit, actions.

- **Remove** deletes that one record.
- **Reassign** appears only on an unresolved row: it prompts with a numbered list of
  eligible points and moves the record, keeping its id and value
  (`reassignLoad()`).
- A record whose point no longer exists is shown in the table as
  `— (missing)` with `is-unresolved` styling.

## 9. Span lengths and the default-length utility

Section: Network data → **Span lengths** tab (`#tab-spans`).

- One row per **unique physical span**. The row shows the span designation, the
  internal span id, its two ends, an editable length in metres and a status
  (`measured` / `not measured` / `not in drawing`).
- Typing a length records it (`{spanLengths: next}` through `applyMeasuredChange`).
  Clearing the field removes the measurement, returning the span to
  *unmeasured* — explicitly, not as zero.
- Validation: a finite number `> 0`. Anything else is refused with "A span length
  must be a number greater than zero. Leave it blank if unmeasured." and the old
  value is restored.
- **A span length never moves the drawing.** It changes a label, never a
  coordinate.
- An unmeasured span is still labelled, with a dash: `— m`.

**Default length utility:** `#field-default-length` + `#btn-apply-default`
("Apply to unmeasured spans"). It fills **only** spans with no measurement
(`applyDefaultLength()`), reports how many were filled and how many were left alone,
and never overwrites a length you typed.

Rows whose span no longer exists are listed at the bottom marked
`— (not in drawing)`, so a length you typed stays visible.

## 10. Selection synchronisation

Three-way linking, all keyed on asset id:

- **Clicking a pole or a span in the preview** selects the matching schedule row
  (`selectNode()` / `selectSpan()`), switches to the right tab and scrolls the row
  into view.
- **Clicking a schedule row** highlights the thing in the preview (a dashed blue
  ring for a node, a translucent blue band for a span) *and* in the drawing reference
  panel (an amber ring / band).
- **The reference panel** rings whatever is currently selected in the schedules.

The preview's hit targets are invisible overlay shapes added after rendering
(`addHitAreas()`): a circle of radius `max(7, spanLength × 0.28)` per pole, a
rectangle per FPB, and a band of width `max(8, spanLength × 0.35)` per span, with
poles drawn on top so a pole wins the click over the span beneath it.

## 11. CSV export, TSV copy and staged import

Each schedule tab has three buttons: **Copy as spreadsheet** (`*-tsv`),
**Export CSV** (`*-csv`), **Import CSV or paste** (`*-import`).

### Export

| Schedule | File | Columns |
| --- | --- | --- |
| Node loads | `node_loads.csv` (`NODE_LOAD_FILE`) | `nodeId, pointDesignation, nodeType, loadId, value, unit` |
| Span lengths | `span_lengths.csv` (`SPAN_LENGTH_FILE`) | `spanId, spanDesignation, fromNodeId, toNodeId, fromDesignation, toDesignation, lengthM` |

Notes that matter when reading the files:

- The node-load export contains **every eligible node**, including ones with no load.
  A node with no load gets one row with blank `loadId`, `value` and `unit`, so the
  file is a complete inventory.
- The span export contains one row per **unique physical span**, not per route step.
- `from`/`to` follow the orientation the span was **first drawn** in.
- **Copy as spreadsheet** puts the same data, with the header row, on the clipboard
  as tab-separated text. If the async clipboard is unavailable (for example on
  `file://`), it falls back to a hidden textarea + `document.execCommand('copy')`;
  if that also fails the status line says to use Export CSV.

### Import

`askForText()` asks first through a native `confirm`: **OK** → choose a `.csv` file;
**Cancel** → paste a block in a `prompt`. The delimiter is detected from the first
line (`detectDelimiter()`), so a pasted tab block and a downloaded comma file both
work without telling the tool which it has.

The text is then **parsed and validated in full**, and a plan is staged in
`#import-staging`:

- `#import-heading` — "Replace the loads with this file?" or "Update loads from this
  file?" depending on the chosen mode.
- `#import-summary` — the counts from `describePlan()`: added / updated / removed /
  unchanged, plus how many rows refer to something this drawing no longer has.
- `#import-details` — one line per unresolved row.
- Two radio buttons (`input[name="import-mode"]`):
  **Replace the schedule** (the file is the whole truth) and
  **Update matching IDs only** (the file is a change list). Switching the radio
  re-stages the plan so the counts reflect the mode.
- **Apply** (`#btn-import-apply`) and **Cancel** (`#btn-import-cancel`).

A file with any bad line is **refused whole**: `#import-heading` says "That import
was not accepted", every problem is listed with its line number, Apply is disabled,
and not one record has changed. Refusal codes are `IMPORT_ERRORS`
(`empty`, `missing-headers`, `field-count`, `duplicate-id`, `bad-value`, `bad-unit`,
`bad-node-type`).

`bad-node-type` / `bad-unit` appear inline as per-line problems; a row naming a node
or span the drawing does not have is **not** a failure — it is reported as unresolved
and kept.

Nothing is applied until Apply is pressed, and Apply re-parses with the currently
selected mode.

## 12. Moving annotations

- Press and drag a **load callout** or a **span length label** in the preview.
- The drag is stored as an offset (`{dx, dy, candidateIndex}`) keyed by asset id in
  `state.loadPlacements` / `state.spanPlacements`, not as a screen position.
- Pointer travel is divided by the current zoom, so a zoomed-out drag does not move
  twice as far as the cursor did.
- Because it is an offset from the automatic placement, the annotation **follows its
  pole** when the drawing is re-laid-out, survives a reload, and is saved into the
  project file.
- A drag of less than half a pixel is not recorded, so a plain click does not create
  a zero offset.
- The stored `candidateIndex` is the candidate position the label was actually on,
  so the first drag moves it from where it was drawn rather than from candidate 0.
- **Dragging moves the annotation, never the load.** The record stays on its pole.

## 13. The drawing reference panel and the full preview

**Drawing reference** (`#mini-preview`, beside the schedules): the same scene,
rendered by the same SVG renderer, inside a fitted `viewBox` so the whole drawing is
always visible, plus an overlay of every point designation. It is a *reference*, not
a second editor: it cannot pan, zoom or be edited. **Open the full drawing**
(`#btn-open-full-preview`) scrolls the main preview into view.

Designation text in the panel is scaled up by however far the drawing is shrunk, so
names stay readable; the overlay is only built for a non-empty drawing.

**Full preview** (`#preview-canvas` inside `#preview-stage`):

| Control | Behaviour |
| --- | --- |
| `#btn-zoom-in` / `#btn-zoom-out` | ×1.25 / ÷1.25 around the stage centre |
| mouse wheel | ×1.12 per notch, around the cursor |
| drag on empty stage | pan |
| `#btn-fit` | scale so the whole drawing fits with a 0.94 breathing factor |
| `#btn-reset` | zoom 1, translate 0 |
| window resize | re-fit (when there is a drawing) |

Zoom is clamped to `MIN_ZOOM = 0.15` … `MAX_ZOOM = 6`.

## 14. Span spacing and clearance

Control: `#field-spacing`, a whole number of **pixels** per span. Default `40`
(`DEFAULT_CONFIG.spanLength` in [src/config.js](../src/config.js)). Typing a value
clamps it to `MIN_SPACING = 12` … `MAX_SPACING = 120` on commit.

The input's `min` attribute is not a constant: at boot `app.js` sets it to
`requiredSpanLength()`, which is **35** with the shipped configuration (the static
`min="39"` in the markup is replaced). So the number that matters is the derived
clearance requirement, described next.

Spacing is a **layout choice**: it changes every span's length at once and never
changes the topology.

- `#field-spacing`'s `min` attribute and the clearance check come from
  `requiredSpanLength()` in [src/geometry/clearance.js](../src/geometry/clearance.js),
  computed from the marker sizes the renderers actually draw. With the shipped
  configuration it is **35 px**.
- Below the requirement, `#spacing-warning` appears naming the shortest safe spacing,
  and the three export buttons are disabled. The drawing stays visible and your typed
  value is kept — nothing is changed for you.

## 15. Saving and loading a project

Buttons `#btn-save-project`, `#btn-load-project` (+ hidden `#field-project-file`).

- **Save project** downloads `line-route-project.json` (`projectFileName()`). The file
  contains only what you authored — routes with their ids, Origin symbol, spacing, page
  layout, loads, span lengths, annotation offsets, point designations and the two
  export switches. The drawing itself is **not** stored; it is rebuilt on load.
- **Load project** opens a file picker. Nothing is applied until the whole file has
  been validated and the routes rebuilt through the real engine.
- **Confirmation** is asked only when opening the file would actually change what you
  have (`sameAuthoredProject()`), which compares every authored field including route
  ids and row order, numerically normalising `40` and `"40"`, and normalising booleans.
  Two identical projects open silently.
- Refusals leave the current drawing untouched and explain why. Codes:
  `EMPTY_FILE`, `INVALID_JSON`, `NOT_A_PROJECT`, `WRONG_FORMAT`, `BAD_VERSION`,
  `FUTURE_VERSION`, `UNSUPPORTED_VERSION`, `MISSING_PROJECT`, `MISSING_ROUTES`,
  `BAD_ORIGIN_MARKER`, `BAD_SPAN_LENGTH`, `BAD_LAYOUT`, `INVALID_ROUTES`,
  `INVALID_DEPENDENCIES`, `BAD_LOADS`, `BAD_SPAN_LENGTHS`, `INVALID_MEASUREMENTS`,
  `BAD_PLACEMENTS`, `BAD_DESIGNATIONS`, `DUPLICATE_DESIGNATION`.
- A file **saved by a newer version** is refused with a message naming both versions.
- After a successful load, the project is persisted and becomes what a reload restores.

The exact format, migrations and recovery semantics are in
[Persistence and project format](05-persistence.md).

## 16. Recovery when the remembered project cannot be read

If the copy in this browser is damaged or was written by a newer version, the tool
does **not** overwrite it. It shows `#recovery-bar` and:

- the session stays usable, showing the example, with **automatic saving paused**;
- **Save project** still downloads what is on screen, so nothing is trapped;
- the bar's two buttons both ask for confirmation first, because discarding cannot be
  undone:
  - `#btn-recovery-discard` — "Discard saved drawing and start from the example";
  - `#btn-recovery-new` — "Discard and start blank".
- Only after you confirm is the stored value removed and automatic saving resumed.

## 17. Exports

Section: Output (`#panel-output`).

| Control | Effect |
| --- | --- |
| `#field-layout` | Page layout: A4 landscape (default), A4 portrait, A3 landscape, Letter landscape. |
| `#field-export-loads` | Include node loads in the exported PDF/SVG/print (default on). |
| `#field-export-lengths` | Include span lengths in the exported PDF/SVG/print (default on). |
| `#btn-pdf` | Downloads `line-route-drawing.pdf`, vector only. |
| `#btn-svg` | Downloads `line-route-drawing.svg`, editable primitives, white background. |
| `#btn-print` | Writes a print document into a hidden iframe and opens the browser's print dialog. |
| `#export-status` | One line saying what happened, including the paper used. |

- Both switches are **presentation only**. Turning one off deletes no record; the
  preview and the drawing reference keep showing everything you entered.
- All three exports hide the drawing's *own* text — the `Origin` label and the
  alphabetical letters — and keep everything that is a fact about the installation:
  the `FPB` label inside its box, the load callouts and the span lengths (subject to
  the switches). The measurement-completeness notice is never exported.
- **Printing uses the page layout you chose**, in the orientation that layout
  declares, and the drawing is scaled to fit exactly one sheet.
- Export is disabled while any route is invalid or the spacing is too small.

The rendering pipeline, the four layouts and the fit-to-page rules are in
[Rendering and export](07-rendering-and-export.md).

### Worked example: the bundled example drawing

**Load example** produces exactly this topology (from `EXAMPLE_ROUTES` in
[src/config.js](../src/config.js)):

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

Verified by running the engine: 34 nodes, 33 edges, endpoints
`Origin, A, B, TC, C, D, E, F, G, H`; at spacing 40 the export scene is
536 × 736 px, with 33 lines, 33 X poles and 1 TC triangle. The preview scene is
552 × 752 px (it uses the larger `viewPadding`), carries 9 labels and 33 span-length
placeholders. `test/geometry.test.js` ("example network: topology matches the
reference drawing") and `test/integration.test.js` pin this.
