# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are
keyed by **date and commit** rather than by release number, because this project is served
straight from `main` and has no tagged releases; `package.json` declares `1.0.0` and no
version is allocated per change.

This file is **mandatory**: every change, however small, gets an entry. The rule and what
counts as "small" are defined in [CLAUDE.md](CLAUDE.md#changelog-is-mandatory).

Entries are newest-first. Each entry names the commit that carried it, so an entry can be
traced to the exact diff. Documentation-only changes are recorded too — they are changes.

## Unreleased

### Fixed

- **Unknown fields in a project file were ignored silently (finding F5).** A document with
  `project.somethingNew = 123` parsed `ok: true` with no warning. The obvious reading -
  "forward compatible, and a newer *version* is refused by `FUTURE_VERSION` anyway" -
  misses the case that actually loses data: a field this build writes correctly but a typo
  mangles. `{"spanns": 4}` is not a newer-version field; it is a route with no span count,
  and the old reader reported "Route 1 has a span count that is not a whole number of at
  least 1" while discarding `spanns`. The same happens to a renamed field, a hand-edited
  value, or anything another branch wrote: it vanishes on the next save, with no copy left
  and nothing reported.

  Every fixed-shape object now has an enumerated list of accepted fields, and anything else
  is refused with the stable code `UNKNOWN_PROJECT_FIELD`, carrying the exact JSON path and
  the names accepted there:

  ```
  document.project.somethingNew
  document.project.routes[0].spanns
  document.project.loads[0].amps
  document.project.loadPlacements["dst:route-1"].scale
  document.metadata.buildNumber
  ```

  **Not treated as fixed shape.** `spanLengths`, `loadPlacements`, `spanPlacements` and
  `nodeDesignations` are maps keyed by asset id. The key IS the data, so every key is
  accepted - including an id this drawing does not have, which is the orphan case
  reconciliation exists for. Only the shape of each value is checked. No extension
  namespace was invented: there is nowhere to put an undefined field.

  **Version-aware order.** The check cannot simply run on the payload. The schema version is
  read first, so an unreadable version is never reported as a field problem; the envelope
  and project are then judged against THAT FILE'S OWN version contract; the document is
  migrated; the migrated payload is judged against the current contract; and only then does
  semantic validation run. Judging every file against today's contract would refuse real
  version 1 files for lacking fields that did not exist yet - and version 1 files carry
  `savedAt` on the envelope and `layout` despite the version table crediting it to v2, so
  both are accepted where they were actually written. Step four guards the other direction,
  so a migration cannot introduce a name this build does not define without being noticed.

  **Recovery is unchanged in spirit.** A refusal is all-or-nothing: no project is returned,
  the caller's document is not mutated, and the stored text is neither stripped nor
  replaced. `loadFromStorage()` still returns `{status: 'invalid', message, raw}`, so the
  recovery bar appears, autosaving stays paused, and the original text stays byte-identical
  in storage.

- **The form and the project parser disagreed on two limits, and nothing said which was
  the policy (finding F1).** The form refused a 501st span while the parser accepted it,
  and the form clamped spacing to 12-120 px while the parser accepted 8 px. The numbers
  were literals in two files, free to drift again.

  Neither side was simply wrong, so the fix is not to make one match the other. The two
  contexts are now defined separately in one DOM-free module, `src/data/constraints.js`:

  | | Interactive input (the form) | Stored values (a project file) |
  | --- | --- | --- |
  | Spans per route | whole number 1...500; 501 refused before anything changes | any whole number >= 1 opens and is drawn unchanged; > 500 is reported |
  | Editing a route over 500 | - | **grandfathered**: the count may be kept, may not grow |
  | Span spacing | clamped into 12...120 on entry | any finite value > 0 opens and is drawn unchanged; outside the range or below the clearance requirement, it is reported |

  Capping the parser would have made previously openable files unopenable, which is data
  loss by policy: a file records what someone authored, and a later build narrowing a form
  field must not rewrite it. So nothing is clamped, rounded or dropped on the way in.

  Grandfathering exists because refusing every edit to an over-limit route would trap the
  user: changing its direction, its marker or its starting point would all require first
  shortening a route they did not mean to touch. `checkRouteSpanCount(spans, {
  existingSpans })` accepts the existing count and refuses only growth - the edit that
  actually crosses the line.

  The module is geometry-free: the clearance minimum is passed in from
  `requiredSpanLength()` rather than imported or restated, so the real marker geometry
  stays the only source of the tightness rule and this module only compares against it.

  What the user sees, above the drawing and each carrying one concern:
  `#spacing-warning` (unchanged for the tight case, now also used for a stored spacing
  *wider* than the field accepts - 300 px draws correctly and only the field disagrees) and
  the new `#route-warning`, which names the row, its count and the 500 limit. The parser
  reports the same conditions through `parseProjectJson(...).warnings`, so a headless
  consumer is told too. No schema version changed, because the persisted format did not.

- **The completeness notice swallowed presses meant for the labels under it (finding
  F12).** While a survey is incomplete the renderer appends an `#notice` group after
  `#load-callouts` and `#span-lengths`, carrying a filled white rectangle. Painting last is
  deliberate — the message needs a clear band — but the rectangle also kept default
  `pointer-events`, so it took the hit. A press on a label that happened to sit under the
  band was a press on the notice: the canvas `pointerdown` found no `[data-annot-id]`
  ancestor, no drag started, and the event reached the stage listener, which panned the
  viewport. The label could not be moved at all, and the gesture moved the whole drawing.

  Reproduced through the real UI: route `origin → south, 2 spans` left unmeasured, a
  40 kVA load on its destination, then the callout dragged into the band with a real drag.

  ```
  before: elementFromPoint(callout centre) -> rect in #notice, owner null
          drag -> pan 229.9,13.8 -> 189.9,-4.2, offset unchanged

  after:  elementFromPoint(callout centre) -> text in #callout:dst:route-10, owner dst:route-10
          drag -> stored (-16.17,-7.74) = pointer (-46,-22) / zoom 2.845, pan unchanged
  ```

  The group is now `<g id="notice" pointer-events="none">` (`src/render/svg.js`). Nothing
  about the notice is a control, so it has no business taking pointer input: the press
  reaches whatever is genuinely underneath — an annotation keeps its drag, and an empty
  part of the band behaves like the bare stage. Geometry, text, colours, opacity and paint
  order are untouched, so it looks identical and is still visible in the preview. It was
  never exported (`showCompleteNotice` is `false` in all three export profiles), so no PDF
  or SVG output changes.

- **A load naming its point by an accepted alias was treated as an orphan and never
  drawn.** The project parser accepted the file - `canonicalNodeId('0,-2')` resolves to
  `dst:route-1` - but kept the spelling verbatim, while `src/ui/network_panel.js`
  (`known.has(load.nodeId)`) and the annotation layer (`callout:<nodeId>`) compared that raw
  string. So a valid load was reported as *"1 load belongs to points this drawing no longer
  has"*, given no callout, and the schedule panel could not name its point. Reproduced with
  a project built by the real serializer:

  ```
  routes: route-1 origin -> south, 2 spans   (destination at 0,-2)
  load:   load-1 -> "0,-2", 25 kVA           (coordinate alias, not the asset id)

  parseProjectJson -> ok: true, loads[0].nodeId === "0,-2"
  schedule panel    -> "— (missing)  0,-2  —  load-1"   is-unresolved
  callout:dst:route-1 -> absent;  "25 kVA" missing from the drawing
  ```

  Aliases are now canonicalised **once**, at the validation boundary
  (`validateMeasuredData()` in `src/ui/project.js`), where the registry is already built:

  ```js
  const validatedLoads = loads.map((load) => {
    const canonical = registry.canonicalNodeId(load.nodeId);
    return canonical === null ? load : { ...load, nodeId: canonical };
  });
  ```

  Every consumer - schedule panel, annotation layer, reassignment picker, exporter - sees
  one spelling, so none of them needed alias logic of its own. Fixes finding **F11**.

- Only identifiers that **resolve** are rewritten. A genuinely unresolved reference keeps
  its exact spelling, still raises the reconciliation warning, and still offers Reassign -
  a broken reference is not an alias, and is never deleted, nulled or reidentified.
- `validatedLoads` holds new objects, so the caller's parsed JSON is not mutated. The
  spelling stored in the *file* is untouched by reading it; only the in-memory project is
  normalised. No schema version change - the serialised contract is unchanged.
- An aliased load on a TC point is still refused with `INELIGIBLE_LOAD_TARGET`: the
  eligibility rule now judges what the identifier resolves to, which it already did.

- **The route-edit TC guard fell back to raw id equality, which was itself a data-loss
  path.** An earlier version resolved the destination's canonical id and, when that failed,
  compared raw identifiers instead. Identity here is first-writer-wins, so when two routes
  finish at the **same coordinate** — an ordinary junction — only the earlier route's id is
  a registered asset: `dst:route-11` resolves to nothing while the route is perfectly
  valid. The fallback then compared `dst:route-10` against `dst:route-11`, found them
  different, and allowed the edit. The shared node became a TC with the load still on it
  and the project was unopenable — reproduced with both routes valid:

  ```
  two routes: origin -> south 1 span   (both destinations at 0,-1)
  load:       load-1 -> dst:route-10, 25 kVA
  edit route-11, tick TC, save
    -> no error, route-11 saved tc: true
    -> parseProjectJson: { ok: false, code: 'INELIGIBLE_LOAD_TARGET' }
  ```

  The guard now resolves the destination **by asset id first, then by the coordinate the
  route's path ends on** (a route whose destination is a shared junction has no id of its
  own), compares canonical identities, and **fails closed**: if the destination cannot be
  located at all, the edit is refused with a retryable message instead of guessing.
  `coordKey()` and `canonicalNodeId()` are the existing helpers — no second registry and no
  hand-written id parsing.

### Added

- `test/schema_fields.test.js` - 14 tests, Node suite 502 -> 516 in 32 files: the original
  `project.somethingNew` reproduction; unknown envelope, `metadata`, route (`spanns`), load
  and placement fields with their exact paths; the dynamic maps accepting canonical ids,
  coordinate spellings and ids this drawing does not have; a historical v1 and v2 document
  opening under its own contract while a v1 file carrying a v3 field is refused; a future
  version still refused for the version reason; all-or-nothing; the serializer's own output
  accepted at all three versions; and the storage layer preserving the unreadable text.
- Browser §16 "Unknown project fields are refused, not trimmed" (5 checks), suite 335 ->
  340 in 17 sections: an unknown field stops the project opening, the recovery bar names
  `document.project.somethingNew`, the seeded route is not applied to the drawing, the
  stored text is byte-identical afterwards, and the same project without that field opens
  normally.
- `test/constraints.test.js` - 17 tests, Node suite 485 -> 502 in 31 files. The limit
  values; 500 accepted and 501 refused; a grandfathered 648 kept, 649 refused, a new 648
  refused and 648 -> 500 ordinary again; clamping at the floor, the ceiling, rounding and
  non-numeric input; stored spacing below, above and inside the range; the spacing verdict
  following an injected requirement (35 vs 50 for the same 40 px project); over-long routes
  named by row; and, through the real parser and serializer, a 501-span and a 9 px project
  opening unchanged, a 300 px project opening unchanged, an in-range project saying
  nothing, a save/reload that does not drift, and a version-1 document keeping its
  out-of-range values through every migration step.
- Browser §15 "Route and spacing limits" (18 checks), suite 317 -> 335 in 16 sections. The
  form refusing 501 and accepting 500; a 501-span / 9 px project opening with no recovery
  banner, both values intact, both warnings shown and export withheld; editing that route's
  direction **without shortening it**, with 501 still in the saved file; typing 8 and
  getting 12; a 300 px project opening, being explained and **not** withholding export;
  typing 400 and getting 120; and an ordinary project showing neither line.
- Browser §9 "The incomplete-measurement notice does not block labels" (17 checks), suite
  298 → 317. It parks a real callout under the notice band with a real drag, then proves
  the band no longer takes the press: the notice is drawn and has `pointer-events: none`;
  the label really does lie inside the band and the element under its centre belongs to
  the callout; a drag there stores `pointer ÷ zoom`, the label follows the pointer and the
  viewport does not move; the callout id and the load's id/target/value/unit are unchanged;
  the placement survives a reload and the notice is redrawn; an empty part of the band
  still pans; and measuring every span removes the notice without disturbing the offset.
- Two **test-strength** corrections in the existing drag section (finding F3, unchanged
  production code). The saved `loadPlacements` are now snapshotted immediately before and
  after the stage pan and asserted byte-identical, so "panning moves the view and not the
  label" is proved rather than inferred from the viewport numbers. The "a click is not a
  drag" check now aims through the same `findGrabPoint()` search the drags use and asserts
  the element at that point belongs to the expected annotation, so a click that landed on
  something else entirely can no longer pass.
- `test/project.test.js` 22 → 29 tests (23-29) covering the canonicalisation boundary:
  alias normalised to the canonical id; already-canonical preserved; an unresolved
  identifier kept verbatim with its warning; the caller's JSON unmutated; the canonical id
  surviving a save/reload; and an aliased load on a TC point still refused.
- Browser §7 reworked (14 → 19 checks) from "the alias survives verbatim" to the fixed
  behaviour: canonicalised at the boundary, no orphan warning, the schedule panel showing
  `dst:route-1 pole` with no `is-unresolved` mark, the `callout:dst:route-1` group present
  with `25 kVA`, and the canonical id written by a real save and surviving a reload. The
  route-edit refusal checks from the previous act are retained, as is the stored-file
  assertion that a refusal does not rewrite the saved record.
- Browser §6 extended with a **shared-junction** case (9 checks), suite 257 → 266. It
  proves the premise (the second route's destination is not its own asset id, and both
  destinations resolve to the same physical node), that a load on the shared node is found
  when editing the *second* route and the edit refused with the stored project still
  openable, and that a load-free shared destination can still become a TC point — so the
  guard does not over-refuse junctions.

### Notes

- Registry absence is a separate, unreachable case rather than a handled one: `boot()`
  calls `refresh() → recompute()` synchronously before any submit event can be dispatched,
  so `current.registry` always exists. The null check remains as a guard against a future
  reordering and is documented as such.

### Verification

- **The unknown-field policy is proved by mutation, in both directions.** Making
  `findUnknownField()` always return `null` fails 6 of the 14 tests, including the original
  reproduction and the storage-preservation check. Judging every document against the
  current contract instead of its own version fails 3 tests in the new file and 3 elsewhere,
  because real v1 and v2 projects stop opening. `src/ui/project.js` was restored
  byte-for-byte (`cmp` clean) and the suites re-run green.
- **The limits fix is proved by mutation, in both directions.** Removing the grandfathering
  (`if (overLimit)` instead of `if (overLimit && spans !== existingSpans)`) fails Node test
  4 and the browser check *the saved project keeps the grandfathered span count*. Clamping
  the stored spacing inside the parser (`Math.min(120, Math.max(12, spanLength))`) fails 4
  Node tests and 3 browser checks. `src/data/constraints.js` and `src/ui/project.js` were
  each restored byte-for-byte (`cmp` clean) and the suites re-run green.
- **The notice fix is proved by mutation.** Restoring `<g id="notice">` without the
  attribute fails **5** of the 17 new checks, including `the notice no longer takes the
  hit`, `the covered label is still grabbable`, `dragging a label under the notice records
  a manual offset` and `the covered label follows the pointer`; `src/render/svg.js` was
  restored byte-for-byte afterwards (`cmp` clean) and the suite re-run green.
- Full runs in this state: `npm test` **516/516 Node tests in 32 files**;
  `npm run test:browser` **340/340 checks in 17 sections**; documentation links 324 in 15
  files with 0 problems; code fences balanced.
- Deliberate behaviour recorded rather than changed: the preview also draws `#hit-areas`
  last with `pointer-events: all`, because pressing a pole selects it. A label dragged on
  top of a pole's hit circle therefore pans instead of moving — a hit target doing its job,
  and recoverable because the plate is wider than the circle. It is documented alongside
  F12 so it is not later mistaken for a regression of this fix.
- **Drag-at-zoom now has executable coverage (finding F3 closed). No production change.**
  A callout is drawn at a scene coordinate and shown through the CSS
  `translate() scale(view.zoom)` that `applyView()` writes; the SVG's `width`/`height`
  match its `viewBox`, so there is no second scale. The persisted manual offset is
  therefore scene-space and the contract is exactly

  ```
  scene-space delta = screen-space delta / view.zoom
  ```

  The browser suite only ever dragged at fit zoom, so a regression in that division would
  have gone unnoticed. Browser §8 now drags a real callout with real pointer events at
  three deliberately different zooms:

  | Zoom | Level | Pointer delta | Scene delta = pointer ÷ zoom |
  | --- | --- | --- | --- |
  | fit | 2.8447 | (-60, -60) | (-21.09, -21.09) |
  | in ×2 | 4.4449 | (+53, +27) | (+11.92, +6.07) |
  | out ×3 | 1.4565 | (-17, -9) | (-11.67, -6.18) |

  Each one asserts the whole gesture rather than only that the label moved: the change in
  the stored `dx`/`dy`, the change in the plate's own SVG `x`/`y`, and the label's
  on-screen movement (which must equal the pointer delta). The applied conversion factors
  differ by exactly the ratio of the zooms - measured 3.052 against 3.052 - which a
  raw-pixel implementation cannot reproduce.

  Also covered: zooming and panning leave the stored offset untouched; a genuine reload
  (previously this check only waited, it never reloaded) keeps the scene position while
  re-fitting the zoom; re-zooming after that reload still does not move the label;
  dragging changes no route, load, node or span-length data; a click is not recorded as a
  drag; an annotation with no offset is still placed automatically.

  Mutation: replacing `(clientX - start.x) / scale` with the raw pixel delta fails 5 of
  the section's checks, with the conversion-factor check reporting
  `factorIn=1/1.000 factorOut=1/1.000 ratio=1.000 zoomRatio=3.052` - the exact signature of
  the defect. `src/ui/app.js` restored byte-for-byte (`cmp` clean).

- Browser §8 grew from 2 to 26 checks; suite 274 → 298 in 14 sections.

- **New finding F12 recorded, not fixed:** the in-drawing "measurements incomplete" notice
  is drawn above the callouts and is hit-testable, so a label under it cannot be dragged -
  a press there pans the viewport instead. Found while writing the F3 tests and unrelated
  to the zoom conversion, so it was recorded rather than folded in. It is confined to the
  preview (the notice is preview-only, F6) and disappears once every span is measured; the
  tests keep it out of the fixture deliberately.

### Validation

- `npm test` → 485 tests, 485 pass, 0 fail.
- `npm run test:browser` → 298/298 checks passed, 14 sections (was 257/257 before these acts).
- Mutation (fail-closed guard): restoring id-only resolution with a raw-id fallback fails 3
  checks, including "the shared-node project is still openable"
  (`{"ok":false,"code":"INELIGIBLE_LOAD_TARGET"}`).
- Mutation (canonicalisation): disabling it fails 4 Node tests and 8 browser checks,
  reproducing the original symptoms exactly - orphan warning, `— (missing) 0,-2`, no
  callout, alias written on save.
- Mutation (unresolved handling): silently reidentifying an unresolved load fails test 26.
- Mutation (drag conversion): raw pointer deltas instead of `delta / zoom` fail 5 browser
  checks, including the conversion-factor check.
- All sources restored byte-for-byte (`cmp` clean); suites re-run green.

### Fixed

- **The route-edit TC guard compared identifier text, so an aliased load was missed.**
  `5404f21` detected attached loads with `load.nodeId === destinationAssetId(routeId)`.
  A load's `nodeId` may legally be a coordinate spelling — the registry resolves `0,-2`
  to `dst:route-1` — and the loader keeps the spelling verbatim rather than rewriting it,
  so those loads were not seen as attached. Reproduced with a project built by the real
  serializer: the edit saved `tc: true`, and `parseProjectJson` then refused the file with
  `INELIGIBLE_LOAD_TARGET` — the same data loss `5404f21` exists to prevent, through a
  different door. The guard now resolves both the edited destination and every load's
  target through the live registry (`canonicalNodeId`) and compares canonical identity,
  so any accepted alias is caught.
- **A refusal message interpolated `undefined`.** A resolver may return an object with no
  usable `nodeType`; the message then read "a undefined point". It now reads "a point
  whose type cannot be established". `addLoad()` and `reassignLoad()` share the helper, so
  they stay consistent.

### Changed

- The `reassignLoad()` JSDoc documented `lookupNode` as `lookupNode?`, contradicting its
  own description. It is now declared required, matching `addLoad()`: omission is a
  caller error that fails closed, not a supported mode.

### Added

- Browser section **Changing a destination to a TC point (aliased load)** (13 checks),
  bringing the suite to 257 checks in 14 sections. It builds the aliased project with the
  real serializer, proves the alias resolves to the canonical destination, loads it
  through the normal workflow, asserts the edit is refused and that the route, the load's
  id/alias/value/unit, openability of the saved project and a clean reload all survive.
- `test/load_eligibility.test.js` test 20: a target whose type cannot be established is
  refused with `INELIGIBLE_LOAD_TARGET` by **both** `addLoad()` and `reassignLoad()`, with
  a readable message.
- Findings **F11** records a separate, pre-existing limitation found while doing this: the
  schedule and annotation layers still compare raw `nodeId`, so an aliased load is
  reported as an orphan and not drawn, even though the registry resolves it. Left
  unchanged as out of scope.

### Validation

- `npm test` → 478 tests, 478 pass, 0 fail (was 477).
- `npm run test:browser` → 257/257 checks passed, 14 sections (was 244/244 in 13).
- Mutation: reverting the guard to raw id equality makes the new alias checks fail.
  Source restored byte-for-byte; suites re-run green.

### Fixed

- **Editing a route to make its destination a TC point could save a project the app
  cannot reopen.** If the destination carried a load, the edit saved happily and left the
  load on a point that is no longer load-eligible. The app's own parser then refused that
  file, so the next visit showed the bundled example, paused automatic saving and stranded
  the drawing behind a recovery banner — permanent-looking data loss from one save.
  Reproduced through the UI before the fix. The edit is now **refused before anything is
  written**, with the form left in edit mode and a message naming the load and the action:

  > This route cannot be changed to a TC point while it carries a load: 1 load (25 kVA)
  > on its destination. Move or remove it on the Loads tab first, then change the point to TC.

  Deleting, transferring or orphaning the load were each rejected as silent data loss.
  Making a destination TC when it carries no load is unaffected.

### Added

- Browser suite section **Changing a destination to a TC point** (14 checks), bringing the
  suite to 244 checks in 13 sections. It drives the refusal through the real form and
  asserts the route, load id, value and unit survive, the project is still **openable by
  `parseProjectJson`**, and a reload shows no recovery banner; then that the permitted
  transition (no load) still works and that removing the load makes the same edit succeed.
- The **Manual annotation placement** section now builds its own callout fixture instead of
  inheriting one from the route-edit section, which it had silently depended on.

### Validation

- `npm test` → 477 tests, 477 pass, 0 fail.
- `npm run test:browser` → 244/244 checks passed, 13 sections (was 230/230 in 12).
- Mutation: removing the route-edit guard reproduces the original defect — 7 checks fail,
  including the reload assertion, which reports the exact "cannot be opened" banner.
- `src/ui/app.js` restored byte-for-byte afterwards; suites re-run green.

### Fixed

- **`reassignLoad()` could move a load onto a TC point.** Guarding creation but not
  movement enforced the rule on one path and left it bypassable on the other, one step
  later. Reproduced:

  ```
  reassignLoad([{ id, nodeId: <a pole>, value: 25, unit: 'kVA' }], id, <a TC>)
    -> { ok: true }, load on the triangle
  ```

  It now fails closed with the same codes as `addLoad()` — `MISSING_NODE_RESOLVER`,
  `UNRESOLVED_LOAD_TARGET`, `INELIGIBLE_LOAD_TARGET` — plus `UNKNOWN_LOAD` for a stale
  record id. A rejected move leaves the input list untouched; a successful one keeps the
  record's id, value and unit. The unguarded primitive is exported separately as
  `insertReassignedLoad()`, for restoring already-validated records, and is not reachable
  from any user action. The panel's orphan picker passes the canonicalising `lookupNode`
  it already had.
- **The import planner threw a `TypeError` instead of reporting when it could not verify a
  target.** `parseNodeLoadImport()` read `context.lookupNode` and `context.isEligible`
  without checking they existed, so a caller missing either crashed mid-row. It produced
  no unverified plan, but a crash is not a result the caller can show. It now returns
  `missing-capability` up front. `context.loads` was likewise read unconditionally and
  now defaults to an empty list.

### Removed

- `addLoadUnchecked`, an alias I introduced in `f1948a9` as "backwards compatible" for a
  symbol that never existed in the previous public API (confirmed with `git log -S`) and
  that had no consumer. `insertLoadRecord()` remains the single explicitly named
  unguarded primitive.

### Added

- `test/load_eligibility.test.js` grown from 14 to 19 tests: refusing a direct move to a
  TC point and to its coordinate-spelling alias, no mutation on a rejected move, eligible
  re-targets preserving id/value/unit, failing closed without a usable resolver (including
  `null`, a string and a stale id), and the planner's capability requirements.

### Audited, unchanged

- `updateLoad()` cannot change a load's point — `nodeId` is not taken from its patch — so
  editing a value needs no eligibility check.
- `removeLoad()` / `removeLoadsForNode()` only remove.
- The UI reassign picker already filtered by `isLoadEligible`; it is now the second of two
  guards rather than the only one.
- An orphan load is still kept and warned about rather than refused.

### Validation

- `npm test` → 477 tests, 477 pass, 0 fail (was 472).
- `npm run test:browser` → 230/230 checks passed.
- Mutation evidence, each reverted and re-verified: removing the `reassignLoad()` guard
  fails tests 15, 16 and 18; removing the planner's capability guard fails test 19.
- No schema change, no migration, no change to rendering, export or the project format.

### Changed

- **Browser §5 (route editing) strengthened from 23 to 32 checks.** The load now attaches
  to the **destination of the route being edited**, whose asset id is derived from the
  route id (`dst:<routeId>`) — instead of to a point shared with a neighbouring route.
  That single relationship covers route identity, endpoint identity and load attachment,
  and because editing the route *moves* that destination it is the first assertion in the
  suite that a load follows a point **by identity rather than by position**: the callout's
  bounding box is captured before the edit and compared after.
- Test-order coupling removed. The section no longer hardcodes `route-10/11/12` or matches
  a designation prefix; route ids, destination id and designation keys are all derived
  from the rows actually rendered, so moving the section or changing the route counter
  cannot break it.
- Unrelated routes are now asserted **from the saved project objects**, not only from the
  rendered table, so a change that survives rendering but corrupts the file is caught.
- The post-reload assertions now cover the exact load node id, value and unit and the
  redrawn callout, rather than just the route list.
- Count reporting corrected in `CHANGELOG.md` for `2926c2f`: that commit added **23**
  `check()` calls (198 → 221), not 22 as first written.

### Validation

- `npm run test:browser` → 230/230 checks passed, 12 sections (was 221/221).
- `npm test` → 472 tests, 472 pass, 0 fail (unaffected; `src/` was not touched).
- Mutation evidence, each reverted byte-for-byte with `git diff` empty and the suites
  re-run green: regenerating the route id on edit fails **10** checks, dropping the load
  on the edited destination fails **9**, corrupting the designation table fails **1**.
  The first mutation is precisely the regression F2 was written about.

### Note

- **No implementation defect was found.** `src/` is unchanged by this work; the edit path
  already preserves the route id and endpoint ids are already derived from it. This commit
  is coverage only.

### Changed

- **`addLoad()` now fails closed.** The `lookupNode` resolver was optional, so a caller
  that omitted it skipped the eligibility check entirely and could still create a load on
  a TC point — the model boundary was bypassable by omission. The resolver is now
  **required**: a missing resolver returns `MISSING_NODE_RESOLVER` and an id that resolves
  to nothing returns `UNRESOLVED_LOAD_TARGET`, both before the
  `INELIGIBLE_LOAD_TARGET` check. Input-list immutability and canonical/alias handling are
  unchanged.
- The unguarded primitive is split out as **`insertLoadRecord()`**, named so that calling
  it is a visible decision. It is for restoring known-valid records and for `addLoad()`
  after approval; no user-reachable action calls it directly.
- The import staging paths in `network_panel.js` now reuse the same canonicalising
  `lookupNode` the form uses, instead of a local exact-id `find`, so an aliased coordinate
  spelling is refused for *ineligibility* rather than dismissed as "not in this drawing".
- `test/schedules.test.js`, `test/reconcile.test.js` and `test/schedule_io.test.js` moved
  to `insertLoadRecord()`, because they exercise record handling (values, units, ids,
  callouts, reconciliation) rather than the eligibility rule. This keeps the two concerns
  separate.
- Documentation now distinguishes the four levels explicitly — the guarded model
  operation, the project parser, the import planner, and the raw applier that trusts an
  already validated plan — instead of implying all four enforce eligibility.

### Added

- `test/load_eligibility.test.js` grown from 10 to 14 tests: missing resolver (including
  non-function values), unresolvable target, a target with no `nodeType`, and a real
  `parseNodeLoadImport` test driving delimited text through the **shared** CSV/clipboard
  planner rather than a hand-built plan.

### Fixed

- The import path's eligibility check is now proven by a test of the actual planner. The
  previous test 8 built a project document and called the applier directly, which did not
  exercise `context.isEligible` at all.

### Validation

- `npm test` → 472 tests, 472 pass, 0 fail (was 468).
- `npm run test:browser` → 221/221 checks passed.
- Mutation evidence: disabling the fail-closed guards fails tests 13 and 14; disabling the
  import planner's `isEligible` check fails tests 8 and 9. Source restored and re-verified.

### Added

- `test/load_eligibility.test.js` — 10 tests pinning the two boundaries that refuse a
  load on a TC point, plus the eligible cases that must keep working.
- `INELIGIBLE_LOAD_TARGET` refusal code in the project parser.
- Browser section **Editing an existing route** — 23 checks covering the edit form end
  to end (browser suite 198 → 221 checks in 11 → 12 sections).
- `CHANGELOG.md` (this file).
- `CLAUDE.md` rule that every change needs a changelog entry, and a pre-commit
  documentation checklist.

### Changed

- `addLoad()` accepts an optional `lookupNode` resolver and refuses an ineligible target.
  The option is optional so `src/data` keeps no dependency on `src/geometry`.
- `network_panel.js` supplies a canonicalising `lookupNode`, so eligibility is decided by
  canonical identity rather than by the id text.
- Documentation set updated for both changes: user guide (TC eligibility, "What an edit
  preserves"), persistence (refusal table now 21 codes), feature matrix (two rows moved to
  Verified, browser section numbering updated), testing (new test file, new browser
  section, counts), findings (F2 and F10 closed), README, `CLAUDE.md`.

### Fixed

- A load on a TC point was accepted by `addLoad()` and by the project parser, so a
  hand-edited file could draw a load on a TC triangle (findings F10).

## 2026-11-12 — `2926c2f` — browser coverage for route editing

### Added

- **Browser regression coverage for editing an existing route** (`2926c2f`). A new
  browser section drives the real edit form: clear the example, build three routes, record
  a 25 kVA load on point `A`, open the row's Edit button, change the direction East → West,
  and save through the form. It then asserts, against both the rendered table and the
  persisted project read from `localStorage`, that the route count is unchanged, the edited
  route keeps its `id` in the UI and in the file, the load keeps its endpoint id, stays out
  of the unresolved bar and is still drawn as a `25 kVA` callout, both neighbouring routes
  are untouched, all 11 designations belonging to the fixture are preserved, and the state
  survives a reload. +23 checks (198 → 221).
- East → West is the direction change used because it preserves every node id, label and
  designation (verified against the real geometry engine). Flipping East → North in that
  fixture merges the destination into a neighbouring route and legitimately relabels the
  drawing, which would make the test ambiguous.
- Test-strength evidence recorded in the commit: substituting a regenerated id fails 4
  checks; dropping loads on the edited route's endpoints fails 2.

### Changed

- Documentation for the edit contract: the user guide gains **What an edit preserves**,
  stating the identity guarantee and the separate caveat that a direction change may still
  legitimately alter the topology.
- Browser suite section numbering shifted by one from section 5 onward
  (11 → 12 sections), and all cross-references in the feature matrix and testing doc were
  remapped to match.
- Test counts everywhere: 468 Node tests in 30 files, 221 browser checks in 12 sections.

### Fixed

- Nothing. No implementation defect was found for this entry — `src/` is untouched by
  `2926c2f`. That is the notable result: the edit path already preserved route identity and
  load resolution, and the finding (F2) was a coverage gap rather than a bug.

## 2026-11-12 — `c1fef34` — a load on a TC point is refused

### Fixed

- **A load on a TC point was accepted**, closing findings F10 (`c1fef34`). A TC point is a
  test point, not a load-bearing asset, so `isLoadEligible('tc') === false` already existed
  and was consulted by the point pickers and the CSV export. Two boundaries did not:
  `addLoad([], {nodeId: <a TC>, value: 10})` returned `{ok: true}`, and
  `parseProjectJson()` accepted a project carrying such a load. Both were reproduced
  against a valid serialised project before the change.
- A second defect, found by the new tests during implementation: the first attempt resolved
  the target with `registry.nodeAsset(id)`, which only knows canonical ids, so an aliased
  coordinate spelling of the same TC node returned `null` and the check was **silently
  skipped**. Both the parser and the panel now canonicalise first.

### Added

- `addLoad()` gains an optional `lookupNode` parameter and refuses an ineligible target,
  returning `{ok: false, code: 'INELIGIBLE_LOAD_TARGET'}`, without mutating the input list.
- The parser refuses a file carrying an ineligible load in `validateMeasuredData()`,
  after building the asset registry, returning `INELIGIBLE_LOAD_TARGET` and nothing to
  apply. Parsing stays all-or-nothing.
- `test/load_eligibility.test.js` — 10 tests: model refusal, input not mutated, parser
  refusal, a TC-marker Origin still eligible, poles unchanged, every eligible
  configuration accepted, canonical/aliased identity, the import-and-apply path,
  all-or-nothing refusal, and orphan loads still kept as warnings.
- `annotations.test.js` test 27 retitled, because it asserted only the eligibility
  predicate while its name claimed a model refusal. The real refusal test now lives in the
  model suite.

### Changed

- `INELIGIBLE_LOAD_TARGET` added to the documented refusal table (20 → 21 codes).
- TC eligibility documented as enforced at three points (model, parser, importer) in the
  user guide, persistence, feature matrix, README and `CLAUDE.md`.

### Compatibility

- A previously saved file that carries a load on a TC point is now **refused** with a
  message naming the record and the point. Nothing is half-applied, and the
  recovery-pending and explicit-replacement protections are unchanged, so the stored
  project is not overwritten automatically.
- **No schema change and no migration.** The schema did not change — only which documents
  are accepted.
- `reassignLoad(loads, id, nodeId)` deliberately still has no registry argument; its guard
  remains the UI picker. Adding one would change a settled API.
- An orphan load (pointing at a node the drawing no longer has) is still kept and warned
  about, not refused.

## 2026-11-12 — `46e72f3` — CLAUDE.md, and the eligibility claim corrected

### Added

- `CLAUDE.md` (`46e72f3`) — a working guide for agents and developers: commands, layout,
  the eleven architecture rules, the numbers that must not be guessed, the two identity
  systems, testing conventions, deliberate behaviours, and workflow expectations.

### Changed

- The TC load-eligibility claim was corrected in four places after `CLAUDE.md` prompted
  verification of it. The docs had said "the model refuses it"; in fact only the predicate
  and the UI did. Recorded as findings F10 at the time.

## Earlier history

The repository predates this changelog. The three documentation commits and the 37 feature
commits before `46e72f3` are described in their own commit messages and in the
documentation set rather than being retro-fitted here, which would require inventing dates
and groupings that were never recorded. `git log` is the authority for that period.

Key milestones visible in history: the geometry core (`0115155`), the UI and renderers
(`bb3eea1`), TC/FPB marker geometry (`e45f341`–`b4aceb6`), persistence (`2d939f5`), the
schema v2 and v3 additions (`52750f2`, `7596b0b`), the committed browser suite
(`dd777bb`), and the print-fit fix (`c39eca9`).
