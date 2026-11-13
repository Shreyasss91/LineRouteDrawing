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
| Editing a row in place | Verified | Browser §5 (32 checks): the edit form opens; a direction change saves with the route `id` preserved in the table **and** the saved file; a load on the edited route's **destination** keeps its derived id (`dst:<routeId>`) even though that point moves, stays resolved, and its callout is redrawn on the moved point; both unrelated route records are byte-identical in the saved project; designations are carried; the same direction, load target, value and unit survive a reload | `startEdit()`/`handleSubmit()` have no *unit* test; coverage is browser-level. The direction change is East → West, chosen because it preserves every node id |
| Deleting a route leaves later identities stable | Verified | `route_identity.test.js` test 7, test 8 ("deleting a route leaves every other identity stable") | Deleting the **route** is the tested unit; deleting a row via the UI button is the same `state.routes.splice` path |
| Deleting a branch leaves its records unresolved, not reassigned | Verified | `reconcile.test.js` tests 1, 4, 6, 7 | — |
| Invalid rows are never dropped | Verified | `geometry.test.js` (forward reference and broken chain), `reconcile.test.js` test 7 | — |
| Unknown project fields refused | Verified | `schema_fields.test.js` (14), `browser` §16 | `UNKNOWN_PROJECT_FIELD` carries the exact JSON path and the accepted names there; checked per schema version, before and after migration; dynamic asset-id maps keep every key. **Closed F5** |
| Unreadable project preserved, autosave paused | Verified | `schema_fields.test.js` test 14, `browser` §16 | The stored text is returned as `raw` and left in storage byte-identical |
| Route span cap 500 | Verified | `constraints.test.js` tests 2-4b, `browser` §15 | **Interactive only.** The engine and the file format accept any positive integer; a longer route opens unchanged and is editable, with its count grandfathered (`src/data/constraints.js`). **Closed F1** |
| Reducing a grandfathered route | Verified | `constraints.test.js` tests 4a, 4b, `browser` §15 (648 -> 600 -> 550 -> 500) | Monotonic non-increase against the count the route has now: 648 → 600 → 550 → 500 each accepted, every re-growth refused, and 500 → 501 refused like an ordinary route. The baseline moves down with the route |
| Load / clear the example | Verified | `browser`, `integration.test.js` | — |

## 2. Marker kinds

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| Pole drawn as an X | Verified | `render.test.js` | — |
| TC drawn as a triangle | Verified | `tc_anchor.test.js`, `fpb.test.js`, `browser` §14 | — |
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
| TC not load-eligible | Verified | `load_eligibility.test.js` (20 tests) drives the model, reassignment and import boundaries; browser §6 drives the route-edit transition, including a shared-junction destination, and §7 the same transition with an aliased load; `schedules.test.js` test 15 and `annotations.test.js` test 27 pin the predicate | `addLoad()` and `reassignLoad()` both fail closed (`MISSING_NODE_RESOLVER`, `UNRESOLVED_LOAD_TARGET`, `INELIGIBLE_LOAD_TARGET`, plus `UNKNOWN_LOAD` for a stale id on move); the project parser refuses the file; `parseNodeLoadImport` refuses the row before a plan exists and refuses outright without both `lookupNode` and `isEligible`. `updateLoad()` cannot change a target at all. Targets resolved through the asset registry, so aliased spellings are judged by what they resolve to. `insertLoadRecord()` and `insertReassignedLoad()` are unguarded by design and are not counted here. Turning a loaded destination into a TC point is refused by the form before anything is written, because it would otherwise save a project the parser rejects. The check compares canonical node identity and fails closed, resolving the destination by asset id then by its end coordinate, so an aliased load and a load on a shared junction are both caught |
| Value must be `> 0` (zero refused) | Verified | `schedules.test.js` | Blank means "no load" |
| Editing a load's value in place | Verified | `network_panel.js`, `schedules.test.js` | — |
| Reassign an unresolved load | Verified | `schedules.test.js`, `reconcile.test.js` | Keeps id and value |
| Aliased load `nodeId` canonicalised on read | Verified | `project.test.js` tests 23–29, browser §7 "the alias is canonicalised at the validation boundary" and four further checks | Normalised once in `validateMeasuredData()`, so the schedule panel recognises the point, the callout is drawn, and the canonical id is what a save writes. Unresolved ids keep their exact spelling and stay reconcilable; the caller's JSON is not mutated. **Closed F11** |
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
| Drag to move an annotation | Verified | `browser` §8 "a callout can be dragged", at fit zoom and at two other zooms | — |
| Drag stored as an offset, follows its pole | Verified | `browser` §8 "the callout keeps its scene position across a reload" | Offset is a scene-space delta, so a re-layout carries the label with its pole |
| Drag scaled by zoom | Verified | `browser` §8, three zooms: stored and drawn scene delta both equal `pointer ÷ zoom`, on-screen movement equals the pointer delta, and the two conversion factors differ by the ratio of the zooms (3.052 vs 3.052) | **Closed F3.** No production change was needed - the arithmetic was already correct; it was the coverage that was missing |
| A click of no travel is not recorded | Verified | `browser` §8 "a click on a callout is not recorded as a drag" | A drag under half a pixel is discarded |
| A label under the completeness notice can still be dragged | Verified | `browser` §9 "dragging a label under the notice records a manual offset"; a mutation that restores the old markup fails 5 checks | **Closed F12.** The `#notice` group carries `pointer-events="none"`, so the band is visible but pass-through: a label under it keeps its drag and an empty part of it pans the viewport. Geometry, text, colours and paint order are unchanged, and the notice is still preview-only |
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
| TSV copy to the clipboard | Verified | `browser` §10; `schedule_io.test.js` | Falls back to `execCommand` on `file://` |
| CSV/paste import with delimiter detection | Verified | `schedule_io.test.js` | Comma or tab |
| Staged import with a plan | Verified | `browser` §10, `schedule_io.test.js` | Nothing applied until Apply |
| Replace vs update-matching-ids modes | Verified | `schedule_io.test.js`, `browser` §10 | — |
| A bad line refuses the whole file | Verified | `browser` §10, `schedule_io.test.js` | 7 `IMPORT_ERRORS` codes |
| Unresolved rows reported, file still accepted | Verified | `schedule_io.test.js` | By design |
| Excel/`.xlsx` direct import | **Unsupported** | — | CSV/TSV only |
| Other CAD or GIS formats | **Unsupported** | — | — |

## 8. Rendering and export

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| One shared scene for all outputs | Verified | `render.test.js`, `pdf_geometry.test.js` | — |
| SVG export, editable primitives | Verified | `render.test.js`, `browser` §11 | — |
| PDF export, vector only | Verified | `pdf_geometry.test.js` (11), `pdf_layouts.test.js` (12), `browser` §12 | jsPDF 4.2.1 vendored |
| PDF page transform (one scale, centred) | Verified | `pdf_geometry.test.js` | — |
| Four page layouts | Verified | `page_format.test.js` (9), `pdf_layouts.test.js` | See `10-limitations.md` §5 |
| One page, every layout (automated) | Verified | `browser` "the drawing fits the printable height, so one sheet is enough" per layout, `print_fit.test.js` | The `c39eca9` fix |
| Print paper matches the chosen layout | Verified | `browser` §13 (`@page size`) | — |
| Letter landscape in the real Chrome print dialog | **Verified (manual)** | Manual run recorded for `c39eca9` | — |
| A4 portrait / A3 landscape in a real print dialog | **Incomplete validation** | Automated only | No manual run recorded |
| Physical printer output | **Verified (manual, external)** | Carried out by the user | Not reproducible in this repo |
| Export switches (loads, lengths) | Verified | `export_visibility.test.js` (11), `browser` §11 | Presentation only |
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
| Spacing warning with the required value | Verified | `clearance.test.js`, `browser` §15 | — |
| Spacing field range 12-120 px, typed values only | Verified | `constraints.test.js` test 5, `browser` §15 | A stored spacing outside the range opens unchanged and is explained, never clamped. **Closed F1** |
| Stored route/spacing values never rewritten on read | Verified | `constraints.test.js` tests 11-17, `browser` §15 | Refusals are for structure; out-of-range values are warnings. The stored-route warning states that the count may be kept or lowered, never raised. **Closed F1** |
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
| Chromium (via Playwright) | Verified | 355 browser checks | — |
| Chrome, manually | Verified (manual) | Print-dialog validation | — |
| Firefox | **Incomplete validation** | Nothing browser-specific in the source | Never run |
| Safari / iOS | **Incomplete validation** | Nothing browser-specific | Never run |
| Mobile layouts | **Unsupported** | — | The UI assumes a desktop-sized viewport |
| Node.js 20+ for the test suite | Verified | `npm test` on this tree | `engines` declares `>=20` |

## 11. Performance

Measured, not asserted as a target. The full tables, method and caveats are in
[11-performance-baseline.md](11-performance-baseline.md); this table records only what is
now known and how it was obtained.

| Feature | Status | Evidence | Limits |
| --- | --- | --- | --- |
| Reproducible baseline for four fixed drawings | Verified | `npm run benchmark` (Node), `npm run benchmark:browser` (Chrome) | One machine, one run; no threshold and no gate |
| Dataset sizes the numbers refer to | Verified | `benchmark_datasets.test.js` (10 tests) | Counts only; timings vary by machine |
| Bundled example (34 spans) opens and edits without perceptible delay | Verified | baseline: 0.6 ms end to end, 6.8 ms recompute | Measured headless |
| 500-span drawing opens in under half a second | Verified | baseline: 0.23 s unmeasured, 0.47 s fully surveyed (cold start to drawing) | This machine; not a promise |
| Editing a 500-span drawing | Verified | baseline: 92 ms recompute unmeasured, 225 ms fully surveyed | Noticeable on every edit at the surveyed size |
| Annotation placement scales linearly | **Unsupported** | `npm run benchmark -- --scaling`: ×3.4 per doubling at 400 spans | Quadratic; recorded as [F13](findings.md#f13-annotation-placement-is-quadratic-in-the-number-of-labels) |
| PDF, print and long-session behaviour are timed | **Unsupported** | — | Deliberately excluded; reasons in baseline §10 |
| A performance regression fails the suite | **Unsupported** | — | Machine-specific numbers are not a gate |

## 12. Summary of what is *not* proven

Collected from the tables above — these are the honest gaps:

1. **A4 portrait and A3 landscape have never been printed from a real print dialog** —
   only the automated fit check and the Letter-landscape manual run exist.
2. **Firefox and Safari have never been run.**
3. **No touch device, no mobile layout, no keyboard-only run.**
4. **No screen-reader path to the drawing.**
5. **Physical printing was validated outside this repository** by the user, and is not
   reproducible here.
6. **No performance figure has been taken on a machine other than the one in
   [baseline §2](11-performance-baseline.md#2-the-environment-measured)**, and no
   regression gate exists — the baseline is a measurement, not a threshold.

Performance is no longer on this list as an *unquantified* gap: it is measured, and the
one genuinely slow path (annotation placement) is recorded as
[F13](findings.md#f13-annotation-placement-is-quadratic-in-the-number-of-labels).
