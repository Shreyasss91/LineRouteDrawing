# Feature and validation matrix

Every capability, its implementation status, and **how it was verified**. This is the
document to read before assuming something works.

## Legend

| Status | Meaning |
| --- | --- |
| **Verified** | Implemented, and checked by an automated test that runs on this working tree, or by an explicit manual validation recorded below |
| **Verified (manual)** | Implemented and confirmed by hand; not automatable here |
| **Incomplete validation** | Implemented, with partial automated coverage — either the code path is exercised only indirectly, or the automated checks do not cover the browser/OS combinations it will meet |
| **Partial** | Works for the described cases, with a stated limit |
| **Planned** | Not implemented; deliberately out of scope for this build |
| **Unsupported** | Not implemented and not intended |

Test evidence is given as `file` or `file: "test name"` so it can be re-run.

---

## 1. Route entry and topology

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| Cardinal-direction route instructions (N/S/E/W) | Verified | `geometry.test.js`, `integration.test.js` | Four directions only; no diagonals |
| Origin fixed at grid `(0,0)` | Verified | `geometry.test.js` | The Origin cannot be moved |
| Chained routes (a route starting where the last ended) | Verified | `geometry.test.js`, `02-user-guide.md` worked example | — |
| Forward reference rejected, not reordered | Verified | `geometry.test.js`, `replacement.test.js` | — |
| Branches from any **named** point | Verified | `geometry.test.js` "multiple branches" | See **Partial**: a branch cannot start from an intermediate pole |
| Branch from an intermediate pole (`A2`) | **Unsupported** | `state.js` `availableSources()` offers endpoints only | Not expressible in the model; see `10-limitations.md` §1 |
| Shared endpoints between routes | Verified | `geometry.test.js` | — |
| Partial overlap of spans | Verified | `geometry.test.js`, `assets.test.js` | — |
| Complete overlap (same path either way) | Verified | `geometry.test.js`, `designations.test.js` | One physical span, one length |
| Perpendicular crossings become junctions | Verified | `geometry.test.js` test 9 ("intersecting routes become connected junctions") | No junction **symbol** is drawn (all profiles set `showJunctionMarkers:false`) |
| Zero-length span rejected | Verified | `network.js` `ERROR_CODES.ZERO_LENGTH`; `geometry.test.js` | Not reachable from the UI (unit steps only) |
| Editing a row in place | **Incomplete validation** | `app.js` `startEdit()` / `handleSubmit()`; no automated test | Exercised only by hand in the browser; no unit test covers `startEdit()` |
| Deleting a route leaves later identities stable | Verified | `route_identity.test.js` test 7, test 8 ("deleting a route leaves every other identity stable") | Deleting the **route** is the tested unit; deleting a row via the UI button is the same `state.routes.splice` path |
| Deleting a branch leaves its records unresolved, not reassigned | Verified | `reconcile.test.js` tests 1, 4, 6, 7 | — |
| Invalid rows are never dropped | Verified | `geometry.test.js` (forward reference and broken chain), `reconcile.test.js` test 7 | — |
| Route span cap 500 | Verified | `app.js` `readForm()` | **UI-only**; the engine and file format accept any positive integer |
| Load / clear the example | Verified | `browser`, `integration.test.js` | — |

## 2. Marker kinds

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| Pole drawn as an X | Verified | `render.test.js` | — |
| TC drawn as a triangle | Verified | `tc_anchor.test.js`, `fpb.test.js`, `browser` §10 | — |
| FPB drawn as a box with `FPB` inside | Verified | `fpb.test.js`, `browser` | — |
| A marker replaces the X | Verified | `fpb.test.js`, `browser` | — |
| TC anchored on its downstream base midpoint | Verified | `tc_anchor.test.js` (12 tests) | — |
| TC apex points back along the arriving cable | Verified | `tc_anchor.test.js` per-direction tests | Falls back to `south` when no route arrives (the Origin declared a TC) |
| TC shrinks, never grows, at tight spacing | Verified | `tc_anchor.test.js` "the adaptive fit only ever shrinks" | — |
| Lines clipped out of TC and FPB | Verified | `tc_clip.test.js`, `fpb_clip.test.js` | Clipping is in the scene; topology unchanged |
| Visible pieces still meet the symbol | Verified | `tc_clip.test.js`, `fpb_clip.test.js` | — |
| Origin marker kind (plain X / TC / FPB) | Verified | `origin_label.test.js`, `network.js` | The Origin keeps id `origin` and grid `(0,0)` |
| A destination cannot be both TC and FPB | Verified | `schedules.test.js`, form validation, project parser | Three independent gates |
| Marker overlap prevention via a derived spacing floor | Verified | `clearance.test.js` | Reported, not auto-corrected |

## 3. Identity, designations and naming

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| Every pole has a designation | Verified | `designations.test.js`, `browser` §1 | — |
| `Origin:1` vs `A1` vs `TC:1` naming | Verified | `designations.test.js` | The colon is deliberate |
| Per-source counters | Verified | `designations.test.js` | — |
| Numbering continues across branches | Verified | `designations.test.js`, `browser` §1 | — |
| Names are never reissued | Verified | `designations.test.js`, `route_identity.test.js` | Persisted via `nodeDesignations` |
| Names stable across reload | Verified | `browser` "every designation survives a reload unchanged" | — |
| Adding a branch renames nothing existing | Verified | `browser` "adding a branch renames nothing that already existed" | — |
| Span designations with an en dash (`A1–A2`) | Verified | `browser` "span designations are the two endpoint names joined by an en dash", `designations.test.js` | Orientation = first drawn |
| TC/FPB never take an alphabetical letter | Verified | `designations.test.js`, `export_visibility.test.js` | — |
| Asset ids stable across edits | Verified | `assets.test.js`, `route_identity.test.js` (11 tests) | First writer wins |
| Aliases resolve to one canonical id | Verified | `assets.test.js` | — |
| Unresolved records are never reattached | Verified | `reconcile.test.js` (7 tests) | — |

## 4. Network data (loads and lengths)

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| Node loads with kVA/kW/kVAr/HP | Verified | `schedules.test.js` (26 tests) | Case-insensitive unit input |
| Default unit kVA | Verified | `schedules.test.js` | — |
| One callout per pole with one line per record | Verified | `browser` "one callout shows all three loads, unsummed", `annotations.test.js` | — |
| Loads never summed, never converted | Verified | `schedules.test.js` | **By design**; see `10-limitations.md` §4 |
| TC not load-eligible | Verified | `load_eligibility.test.js` tests 1–10 exercise the real refusals at both boundaries; `schedules.test.js` test 15 and `annotations.test.js` test 27 pin the predicate | `addLoad()` refuses (via `lookupNode`), the project parser refuses with `INELIGIBLE_LOAD_TARGET`, and the schedule importer refuses the row. Aliased coordinate spellings are caught too |
| Value must be `> 0` (zero refused) | Verified | `schedules.test.js` | Blank means "no load" |
| Editing a load's value in place | Verified | `network_panel.js`, `schedules.test.js` | — |
| Reassign an unresolved load | Verified | `schedules.test.js`, `reconcile.test.js` | Keeps id and value |
| Span lengths, one per physical span | Verified | `schedules.test.js`, `schedule_io.test.js` | Keyed by span asset id |
| Unmeasured span labelled `— m` | Verified | `browser` "an unmeasured span reads as a dash, never a zero", `annotations.test.js` | — |
| Clearing a length means unmeasured, not zero | Verified | `schedules.test.js` | — |
| Default-length utility fills only unmeasured | Verified | `browser` "the default length fills the remaining spans" | Reports filled/skipped |
| A length never moves the drawing | Verified | `schedules.test.js`, `annotations.test.js` | `applyMeasuredChange` never touches routes |
| Unresolved records: bar, review, discard | Verified | `browser` §3, `reconcile.test.js` | Discard is confirm-gated |

## 5. Annotation placement

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| Automatic callout and label placement | Verified | `annotations.test.js` (37 tests) | Candidate scoring, not global optimisation |
| Collision avoidance | Verified | `annotations.test.js`, `collide.js` tests | Box/segment tests |
| Leader line and arrowhead | Verified | `annotations.test.js` | — |
| Drag to move an annotation | Verified | `browser` §5 "a callout can be dragged" | — |
| Drag stored as an offset, follows its pole | Verified | `browser` §5 "the dragged position survives a reload" | — |
| Drag scaled by zoom | **Incomplete validation** | Implemented in `app.js` ("Scene-space position at the moment the drag began, so zoom never bends the move"); no automated check | The browser suite drags only at fit zoom |
| A click of no travel is not recorded | **Incomplete validation** | Implemented (a drag under half a pixel is discarded); no automated check | — |
| Annotations identical in preview and export | Verified | `annotation_layer.js` `labelSlots` + browser PDF/print sections | Same unpadded frame |

## 6. Persistence

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| Automatic save after every change | Verified | `browser` (reload-based checks) | `localStorage` only |
| Save / load a `.json` project | Verified | `project.test.js` (22 tests) | — |
| Round trip is the identity | Verified | `project.test.js`, `recovery.test.js` | — |
| Schema v1/v2 read and migrated | Verified | `migration.test.js` (20 tests) | v4+ refused |
| Every refusal code reachable | Verified | `project.test.js` | 20 codes |
| Behaviours: `none`/`ok`/`invalid`/`unavailable` | Verified | `storage.test.js` (12 tests) | — |
| Quota exceeded reported, not thrown | Verified | `storage.test.js` | — |
| Recovery mode never overwrites stored data | Verified | `recovery.test.js` (10 tests), `browser` | Discard is confirm-gated |
| Versioned storage key | Verified | `storage.test.js` | `line-route-drawing:v3:project` |
| Confirmation only on a real change | Verified | `replacement.test.js` (15 tests: `sameAuthoredProject`, declining leaves the project untouched, an invalid file is refused before any confirmation) | Compares authored fields exactly |
| Cross-device sync | **Unsupported** | — | No server, no account |
| Undo / redo | **Unsupported** | — | No history stack |
| Multiple named projects | **Unsupported** | — | One remembered project plus files |

## 7. Data interchange

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| CSV export, node loads | Verified | `schedule_io.test.js` (31 tests) | Includes load-less nodes as blank rows |
| CSV export, span lengths | Verified | `schedule_io.test.js` | One row per physical span |
| TSV copy to the clipboard | Verified | `browser` §6; `schedule_io.test.js` | Falls back to `execCommand` on `file://` |
| CSV/paste import with delimiter detection | Verified | `schedule_io.test.js` | Comma or tab |
| Staged import with a plan | Verified | `browser` §6, `schedule_io.test.js` | Nothing applied until Apply |
| Replace vs update-matching-ids modes | Verified | `schedule_io.test.js`, `browser` §6 | — |
| A bad line refuses the whole file | Verified | `browser` §6, `schedule_io.test.js` | 7 `IMPORT_ERRORS` codes |
| Unresolved rows reported, file still accepted | Verified | `schedule_io.test.js` | By design |
| Excel/`.xlsx` direct import | **Unsupported** | — | CSV/TSV only |
| Other CAD or GIS formats | **Unsupported** | — | — |

## 8. Rendering and export

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| One shared scene for all outputs | Verified | `render.test.js`, `pdf_geometry.test.js` | — |
| SVG export, editable primitives | Verified | `render.test.js`, `browser` §10 | — |
| PDF export, vector only | Verified | `pdf_geometry.test.js` (11), `pdf_layouts.test.js` (12), `browser` §8 | jsPDF 4.2.1 vendored |
| PDF page transform (one scale, centred) | Verified | `pdf_geometry.test.js` | — |
| Four page layouts | Verified | `page_format.test.js` (9), `pdf_layouts.test.js` | See `10-limitations.md` §5 |
| One page, every layout (automated) | Verified | `browser` "the drawing fits the printable height, so one sheet is enough" per layout, `print_fit.test.js` | The `c39eca9` fix |
| Print paper matches the chosen layout | Verified | `browser` §9 (`@page size`) | — |
| Letter landscape in the real Chrome print dialog | **Verified (manual)** | Manual run recorded for `c39eca9` | — |
| A4 portrait / A3 landscape in a real print dialog | **Incomplete validation** | Automated only | No manual run recorded |
| Physical printer output | **Verified (manual, external)** | Carried out by the user | Not reproducible in this repo |
| Export switches (loads, lengths) | Verified | `export_visibility.test.js` (11), `browser` §7 | Presentation only |
| Exports hide `Origin` and letters | Verified | `export_visibility.test.js` | — |
| Completeness notice never exported | Verified | `export_visibility.test.js` | — |
| Export blocked on invalid routes or tight spacing | Verified | `browser`, `clearance.test.js` | — |
| Drawing is **not to scale** | — | `04-route-and-geometry.md` §2 | Equal graphical spacing by design |
| Raster export (PNG/JPEG) | **Unsupported** | — | — |
| DWG/DXF/PDF-A | **Unsupported** | — | — |
| Custom paper size | **Unsupported** | — | Four fixed layouts |
| Multiple sheets / multipage | **Unsupported** | — | One sheet, scaled to fit |

## 9. Interface and accessibility

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| Zoom, pan, fit, reset | Verified | `app.js` `MIN_ZOOM` 0.15 … `MAX_ZOOM` 6 | — |
| Re-fit on window resize | Verified | `app.js` resize handler | Only when a drawing exists |
| Three-way selection sync | Verified | `browser` §4 "the selected row is marked" and neighbours | By asset id |
| Drawing reference panel | Verified | `mini_preview.test.js` (11), `browser` §4 | Read-only |
| Spacing warning with the required value | Verified | `clearance.test.js`, `browser` | — |
| Keyboard-only route entry | **Incomplete validation** | The form is native HTML, so tab/enter work; not tested | No dedicated keyboard test |
| Keyboard operation of the preview canvas | **Unsupported** | — | Zoom/pan/select need a pointer |
| Screen-reader support of the drawing | **Unsupported** | — | The SVG has no text alternative; the schedules are the accessible record |
| Touch gesture support | **Incomplete validation** | Pointer events are used; pinch-zoom is not implemented | Not tested on a touch device |
| Dark mode / theming | **Unsupported** | — | One stylesheet |
| Internationalisation | **Unsupported** | — | English only; `en`-dash and `—` are literal characters |
| Locale-correct decimal input | **Incomplete validation** | `<input type="number">`; comma decimals depend on the browser | Not tested |

## 10. Platform

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| Runs fully offline from the local filesystem | Verified | No network requests in the source; jsPDF vendored | `file://` disables the clipboard fallback path |
| Works from `npm run serve` | Verified | `scripts/serve.js`, used by `test-browser.mjs` | — |
| Chromium (via Playwright) | Verified | 198 browser checks | — |
| Chrome, manually | Verified (manual) | Print-dialog validation | — |
| Firefox | **Incomplete validation** | Nothing browser-specific in the source | Never run |
| Safari / iOS | **Incomplete validation** | Nothing browser-specific | Never run |
| Mobile layouts | **Unsupported** | — | The UI assumes a desktop-sized viewport |
| Node.js 20+ for the test suite | Verified | `npm test` on this tree | `engines` declares `>=20` |

## 11. Summary of what is *not* proven

Collected from the tables above — these are the honest gaps:

1. **Drag-at-zoom** is implemented but has no automated check.
2. **A4 portrait and A3 landscape have never been printed from a real print dialog** —
   only the automated fit check and the Letter-landscape manual run exist.
3. **Firefox and Safari have never been run.**
4. **No touch device, no mobile layout, no keyboard-only run.**
5. **No screen-reader path to the drawing.**
6. **No performance baseline** for large drawings (hundreds of routes).
7. **Physical printing was validated outside this repository** by the user, and is not
   reproducible here.
