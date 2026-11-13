# Findings

Observations made while documenting this codebase. Most were recorded for a separate
decision rather than fixed; **F10 has since been implemented and closed**, and is kept
here in its closed form so the history of the defect stays visible.

Severity is about what a user or maintainer would experience, not about code style.

| ID | Area | Severity | Status |
| --- | --- | --- | --- |
| [F1](#f1-the-form-and-the-project-parser-disagree-on-documented-limits) | Form vs. parser limits | Low | Open — documented, not changed |
| [F2](#f2-an-edited-route-is-now-covered-by-a-browser-test) | Untested UI path | Medium | **Closed** — 32 browser checks exercise the edit form |
| [F3](#f3-drag-at-zoom-is-verified-against-the-stored-scene-offset) | Untested UI behaviour | Low | **Closed** — drag verified at three zoom levels against the stored scene offset |
| [F4](#f4-the-static-spacing-minimum-in-the-markup-is-stale) | Stale literal | Low | Open |
| [F5](#f5-unknown-keys-in-a-project-file-are-ignored-silently) | Forward compatibility | Low | Open |
| [F6](#f6-the-completeness-notice-is-preview-only) | Export completeness | Low | Open — arguably by design |
| [F7](#f7-route-entry-has-no-undo-and-no-row-reordering) | Data safety | Medium | Open — by design |
| [F8](#f8-appjs-is-a-1590-line-controller) | Maintainability | Low | Open |
| [F9](#f9-no-performance-baseline-for-large-drawings) | Unverified scale | Medium | Open |
| [F10](#f10-a-load-cannot-reach-a-tc-point-by-creation-move-edit-import-or-file) | Eligibility not enforced at the boundary | Low–Medium | **Closed** — five guarded boundaries covering creation, move, route edit, import and file; fail-closed, each with executable evidence |
| [F11](#f11-an-aliased-load-id-is-not-resolved-by-the-schedule-and-annotation-layers) | Alias identity handled inconsistently | Low | **Closed** — aliases canonicalised once at the validation boundary |
| [F12](#f12-the-in-drawing-notice-overlay-intercepts-pointer-events-over-the-annotations-beneath-it) | Interaction | Low–Medium | Open — recorded while testing F3, not changed |

---

## F1 — The form and the project parser disagree on documented limits

**Observed.** Two limits enforced by the **form** are not enforced by the **project
parser**:

| Limit | Form | Parser |
| --- | --- | --- |
| Spans per route | 500 max (`app.js:1074`) | accepts 501 (verified: `parseProjectJson` returns `ok: true`) |
| Span spacing | clamped 12…120 px (and `min` = 35 at boot) | accepts `spanLength: 8` (verified: `ok: true`, value `8`) |

Both are safe because the engine is independent, but the asymmetry is real.

**Impact.** A hand-edited or externally generated project can create a drawing that the
UI cannot reproduce or comfortably edit. A spacing of 8 opens into a drawing with the
tight-spacing warning and export disabled, which is correct but may surprise.

**Why it was not changed.** Enforcing the form's caps in the parser would make
previously-openable files unopenable — a behaviour change, not a documentation fix.

**Suggested decision.** Either (a) document the file format as the more permissive
interface (done in [Known limitations §10](10-limitations.md#10-form-and-model-disagree-in-two-places)),
or (b) add parser-level caps as a separate, tested change with a migration note.

**Related documentation correction.** While checking this, the claim that the parser
accepts direction *labels* (`"South"`) proved **false** — `VALID_DIRECTIONS` holds only
the lowercase keys, and a file containing `"South"` is refused with `INVALID_ROUTES`.
Verified. All documentation now states keys only.

## F2 — An edited route is now covered by a browser test

**Status: closed.** The interaction has real DOM coverage; no implementation defect was
found.

**Observed originally.** Editing a row (`startEdit()` → "Save changes" →
`handleSubmit()` replace path, [src/ui/app.js](../src/ui/app.js)) is a common operation
that had **no automated coverage**:

- `route_identity.test.js` test 5 covered "editing one restored route does not touch
  another" at the *model* level, not in the DOM.
- The browser suite (then 198 checks) never opened the edit form.

**Impact.** A regression in the edit path — for example losing the row's `id`, which
would orphan its loads — would not have been caught.

**Fix.** A browser section, *Editing an existing route*, in `scripts/test-browser.mjs`.
It was introduced with 23 checks (198 → 221) and then **strengthened to 32 checks**
(221 → 230), which is the state described here.

The scenario attaches the load to the **destination of the route being edited**, not to
its source. That is the strongest place to put it, because the destination's asset id is
derived from the edited route's id (`dst:<routeId>`), so one relationship covers route
identity, endpoint identity and load attachment. Editing the route also *moves* that
destination in the drawing, which is what makes the test prove the load follows the
point **by identity rather than by position**.

It builds a three-route project, records a 25 kVA load on the edited route's destination
through the real dropdown, opens the edit form through the row's own Edit button, changes
the direction East → West, and saves through the real form. It then asserts, against the
rendered table, the saved project and the rendered callout:

- the route count is unchanged and the form returns to add mode;
- the edited route keeps its id in the UI **and** in the saved file;
- the destination keeps the id `dst:<routeId>` even though its coordinate changes;
- the load keeps that exact destination id, plus its value and unit;
- it stays out of the unresolved bar and is redrawn as a `25 kVA` callout;
- the callout group keeps the id `callout:dst:<routeId>` **and its bounding box moves**,
  so it follows the point rather than being left behind or re-created elsewhere;
- both unrelated route records are byte-identical **in the saved project object**, not
  merely in the table;
- every designation entry for the fixture's own routes is unchanged — with the key set
  derived from the captured route ids rather than hardcoded, so the section does not
  depend on where it sits in the suite or on the route counter;
- after a reload: the same route id, the same direction, the same load node id, value and
  unit, and the callout still drawn.

East → West was chosen deliberately: it keeps every node id, label and designation
identical (verified against the real engine), so a failure indicates the edit path broke
identity rather than the drawing legitimately changing shape.

**No implementation defect was found.** The replacement path already spreads into the
existing route object, so `id` is preserved, and endpoint asset ids are derived from the
route id, so a load on `endpoint:A` stays resolved. The finding was a coverage gap, not a
bug.

**Test strength verified** by three mutations of `src/ui/app.js`, each reverted
byte-for-byte (`git diff` empty) and the suites re-run green afterwards:

| Mutation | Checks that fail |
| --- | --- |
| Regenerate the route id on edit (`{ id: createRoute(...).id, ... }`) | **10** — id in the UI, id in the saved file, unresolved banner, callout present, callout keyed to the destination, callout text, callout position, designations, reload id, reloaded load target |
| Drop the load on the edited route's destination | **9** — load still recorded, value/unit, callout present, callout keyed to the destination, callout text, callout position, plus the three reload assertions |
| Corrupt the designation table on recompute (rename every point) | **1** — the designation-preservation check |

The first mutation is the important one: regenerating the route id is exactly the
regression this finding was written about, and it now fails ten ways because the load is
attached to the route's own destination rather than to a point shared with a neighbour.

## F3 — Drag at zoom is verified against the stored scene offset

**Status: closed.** Verified by browser regression coverage; **no production change was
needed**, because the arithmetic was already correct.

**Observed.** `app.js` divides pointer travel by `view.zoom` before adding it to the
stored manual offset, so a zoomed-out drag moves the same scene distance the cursor
travelled on screen. The browser suite dragged only at fit zoom, leaving the conversion
itself unexercised.

**The transform, established from source rather than assumed.** The preview is an SVG
whose `width`/`height` match its `viewBox`, drawn at a 1:1 scene-unit-to-pixel scale, and
the canvas is placed with a CSS `translate(view.x, view.y) scale(view.zoom)` written by
`applyView()`. There is no viewBox scaling and no second transform, so the only scale is
`view.zoom` and the contract is exactly:

```
scene-space delta = screen-space delta / view.zoom
```

The persisted manual offset (`loadPlacements[nodeId] = {dx, dy, candidateIndex}`) is a
displacement from the automatically chosen label position in **scene units**. It is
therefore independent of both zoom and pan: zooming re-renders the same scene geometry
and panning only changes `view.x`/`view.y`.

**Verified.** Browser §"Manual annotation placement" now drags a real callout with real
pointer events at three deliberately different zooms - fit (`zoom ≈ 2.84`), zoomed in
twice (`≈ 4.44`) and zoomed out three times (`≈ 1.46`) - and for each one asserts all
three views of the same gesture:

| Assertion | What it proves |
| --- | --- |
| pointer travel `÷ zoom` equals the change in the stored `dx`/`dy` | the persisted offset is scene-space |
| the same figure equals the change in the plate's own SVG `x`/`y` | the label is drawn where it was stored |
| the label's on-screen movement equals the pointer travel | the label keeps up with the cursor at any zoom |

The zoom is read back from the rendered `matrix()` transform `applyView()` writes, and the
scene position from the plate's SVG attributes, so the test does not restate the formula.
Across the two non-fit zooms the applied conversion factor differs by exactly the ratio of
the zooms (`3.052` measured against `3.052`), which a raw-pixel implementation cannot
reproduce. Panning, re-zooming after a reload, and a reload itself all leave the stored
offset unchanged, and dragging changes no route, load, node or span-length data.

**Regression strength.** Replacing `(clientX - start.x) / scale` with the raw pixel delta
fails 5 of the section's checks, including the conversion-factor check, which then reports
`factorIn=1/1.000 factorOut=1/1.000 ratio=1.000 zoomRatio=3.052` - the exact signature of
the defect. The source was restored byte-for-byte afterwards.

## F4 — The static spacing minimum in the markup is stale

**Observed.** [index.html:273](../index.html) ships
`<input id="field-spacing" type="number" min="39" max="120" …>`. At boot,
`app.js:1576` overwrites `min` with `requiredSpanLength()`, which is **35**. So the
literal `39` is dead, and it disagrees with the derived value.

**Impact.** Low. It matters for the window between HTML parse and boot, and it misleads
anyone reading the markup as the source of truth.

**Suggested fix.** Remove the `min` attribute from the markup (it is always set
programmatically), or set it to a value the code keeps in sync.

## F5 — Unknown keys in a project file are ignored silently

**Observed.** A project document with an extra key (`project.somethingNew = 123`)
parses `ok: true` with **no warning** (verified).

**Impact.** Low for this build, and normal pass-through JSON behaviour. It becomes
relevant only if a future version adds a field: a *newer* file opened by this build is
already refused by `FUTURE_VERSION`, so silent key loss cannot happen across versions
today.

**Suggested decision.** Leave as is, or add a warning listing unrecognised keys. Worth
a note because it is the difference between "forward compatible" and "refuses".

## F6 — The completeness notice is preview-only

**Observed.** `showCompleteNotice` is `true` only in the `preview` profile. An exported
PDF/SVG/print therefore does **not** say that some spans are unmeasured.

**Impact.** A reader of the final sheet can mistake `— m` labels for a drawing that was
never surveyed *by design*, rather than one that is still incomplete.

**Assessment.** This is very likely intentional (`export_visibility.test.js` pins it,
and the notice is an application status message rather than a drawing element), but it
is a judgement a reviewer may want to revisit: an "incomplete survey" mark on a
controlled drawing is arguably a safety-relevant statement.

## F7 — Route entry has no undo and no row reordering

**Observed.** There is no undo stack. Rows are evaluated in entry order and cannot be
reordered; the only remedies are re-entry or reloading a saved file.

**Impact.** Medium — the cost of a mis-click is re-typing. `Delete` keeps later rows
(as invalid) rather than cascading, which mitigates the worst case.

**Status.** By design (documented in
[Known limitations §6](10-limitations.md#6-no-server-no-accounts-no-collaboration)).
Recorded because "no undo" is the single most likely user complaint and it is not
currently mentioned in [README.md](../README.md).

## F8 — `app.js` is a 1590-line controller

**Observed.** [src/ui/app.js](../src/ui/app.js) is 1590 lines and holds: DOM lookup,
event wiring, form validation, the viewport (zoom/pan/fit), exports, persistence
gating, hit areas, highlights, the annotation drag, and the mini-preview. Compare
`network_panel.js` at 941 and `project.js` at 854.

**Impact.** Low today (it works and the browser suite covers much of it), but it is the
largest untested unit in the project, and its size is why several UI behaviours (F3)
have no tests — extracting a DOM-free helper is the only way to unit-test them.

**Suggested direction** (not done, and outside this task's scope): extract the
viewport transform and the drag arithmetic into DOM-free modules, following the
precedent of `clearance.js`, `print.js`, `schedule_io.js` and `project.js`.

## F9 — No performance baseline for large drawings

**Observed.** A synthetic 40-route chain (501 spans) takes roughly 2 ms to build the
network and 9 ms to build the scene under Node, but the browser path — including
annotation placement, hit-area generation and two SVG renders — has **no measurement**
and no test beyond the bundled example's 34 nodes.

**Impact.** Medium and unquantified. `annotations.js` searches candidate positions
against obstacles, which is the most likely superlinear cost.

**Suggested fix.** Add a scripted large-drawing timing check before claiming any scale
limit.

## F10 — A load cannot reach a TC point by creation, move, edit, import or file

**Status: closed.** Enforced at five guarded boundaries, each with its own executable
coverage; the optional-resolver bypass and the unguarded reassignment are fixed, and the
route-edit transition that could strand a project is refused.

**Observed originally.** A TC point is documented as not load-eligible, and
`isLoadEligible('tc') === false` was asserted by `test/schedules.test.js` test 15 and
`test/annotations.test.js` test 27. But eligibility was enforced only by the
**predicate** and by the point pickers / CSV export in `network_panel.js`. Neither
`addLoad()` nor the project parser checked it. Reproduced directly:

- `addLoad([], {nodeId: 'dst:r3' /* a TC */, value: 10, unit: 'kVA'})`
  → `{ok: true}` with the record created.
- A valid serialised project with a load on `dst:r3` → `parseProjectJson` returned
  **`ok: true`** and kept the load.

**Two further weaknesses, found by auditing every operation that can change a target.**
The first fix guarded *creation* and left *movement* open, which is the same act one step
later, and left the import planner's own preconditions implicit. Both were reproduced:

- `reassignLoad([{id, nodeId: <pole>, value: 25, unit: 'kVA'}], id, <a TC>)`
  → `{ok: true}`, the load on the triangle — while `addLoad()` on the same point
  correctly returned `INELIGIBLE_LOAD_TARGET`.
- `parseNodeLoadImport(text)` with no `context` → threw `TypeError: context.lookupNode is
  not a function` from the middle of the row loop. Fail-closed in the sense that mattered
  (no unverified plan existed), but a crash rather than a reportable result.

**Impact.** Low for normal use — the dropdown and the reassign picker both offered only
eligible points, so the UI could not produce this state. It mattered because the project
file is the more permissive interface
(see [Known limitations §10](10-limitations.md#10-form-and-model-disagree-in-two-places)):
a hand-edited or externally generated file could place a number on a TC triangle.

**Aggravating detail, now corrected.** `test/annotations.test.js` test 27 was titled *"a
load on a TC point is refused by the data model, not placed anyway"* but asserted only
`isLoadEligible(...) === false`. It has been retitled to say what it does
("the eligibility predicate excludes a TC point from carrying a load"), and the real
model-refusal tests now live in `test/load_eligibility.test.js`.

**Fix.** Five guarded boundaries, distinguished in the docs so none is claimed to do
another's job:

1. `addLoad()` — **creating** a load. Fails closed: refuses with
   `MISSING_NODE_RESOLVER` when no resolver is supplied, `UNRESOLVED_LOAD_TARGET` when
   the id resolves to nothing, and `INELIGIBLE_LOAD_TARGET` when the point cannot carry a
   load. The input list is never mutated. The panel supplies a canonicalising resolver.
2. `reassignLoad()` — **moving** an existing load. The same contract and the same three
   codes, plus `UNKNOWN_LOAD` for a stale load id. Keeping the id, value and unit on a
   successful move is pinned by test. An unguarded primitive
   `insertReassignedLoad()` is exported for restoring already-validated records and is
   not reachable from a user action.
3. Project parser (`validateMeasuredData`) — refuses the whole file with
   `INELIGIBLE_LOAD_TARGET`, nothing to apply.
4. Schedule import planner (`parseNodeLoadImport`) — refuses the row during planning,
   before any plan exists, reported as `bad-value` with a detail naming the TC rule; and
   refuses outright with `missing-capability` if it is given neither or only one of
   `lookupNode` and `isEligible`, because it could not verify any target. This is the
   shared planner behind both CSV import and clipboard paste.
5. Route edit (`handleSubmit()` in `src/ui/app.js`) — **refuses to turn a destination
   into a TC point while it carries a load**, showing the load's value and pointing at
   the Loads tab. This is the most severe of the five, because it is the only one that
   could produce a project the app cannot reopen (see below). It compares **canonical
   node identity**, not identifier text: both the edited destination and every load's
   target are resolved through the live registry (`canonicalNodeId`), so a load stored
   under a coordinate alias is recognised as belonging to the destination. The first
   version compared `load.nodeId === destinationAssetId(routeId)` and missed exactly those
   loads — reproduced, and it reopened the data-loss path this rule exists to close.

   It also **fails closed**. An earlier version fell back to comparing raw ids when the
   destination could not be canonicalised, and that fallback was itself a data-loss path:
   identity is first-writer-wins, so when two routes end at the **same coordinate** (an
   ordinary junction) only the earlier route's id is registered and `dst:<laterRoute>`
   resolves to nothing while the route is perfectly valid. The fallback then compared
   `dst:route-10` against `dst:route-11`, found them different, and allowed the edit; the
   shared node became a TC with the load still on it and the project was unopenable.
   Reproduced with both routes valid. The destination is now resolved by its **asset id
   first, then by the coordinate its path ends on**, and an unresolvable destination
   refuses the edit with a retryable message instead of guessing. Registry absence is a
   separate, unreachable case: `boot()` calls `refresh() → recompute()` synchronously
   before any submit can be dispatched, so the registry always exists.

`insertLoadRecord()`, `insertReassignedLoad()` and `applyNodeLoadPlan()` are **unguarded
by design** and are not counted as boundaries: the first two are the primitives beneath
the guarded operations, the third trusts a plan the planner already validated.

**Audited and left alone.** Two operations were checked and need no guard:

- `updateLoad()` cannot change a load's point — `nodeId` is deliberately not taken from
  its patch — so editing a value can never re-target a load (test 3 pins this).
- `removeLoad()` and `removeLoadsForNode()` only remove.

**The route-edit transition, reproduced in a real browser.** The audit above covers
operations that move a *load*. Changing a *point* can invalidate a load that is already
correct, and that path had no guard at all — `handleSubmit()` carried a comment saying a
TC flag change "can alter which endpoints exist downstream" and that "Nothing is
dropped", which was accurate and was the problem. Steps, all through the UI:

1. add a route whose destination is an ordinary pole;
2. attach a 25 kVA load to that destination;
3. open Edit on the route, tick **TC point**, save;
4. the route saves with `tc: true` and the load is still on `dst:<routeId>`;
5. `parseProjectJson` on the project just saved returns
   **`INELIGIBLE_LOAD_TARGET`** — the app had written a file it refuses to read.

The practical consequence is the worst in this finding: on the next visit the project
cannot be opened, the bundled example loads instead, automatic saving is paused, and the
user's drawing is stranded behind a recovery banner. The edit turned a working drawing
into an unreopenable one in a single save, with no warning.

**Fix.** The edit is refused *before* the route is replaced, so nothing is written. The
message names the load and the action:

> This route cannot be changed to a TC point while it carries a load: 1 load (25 kVA)
on its destination. Move or remove it on the Loads tab first, then change the point to TC.

The three silent alternatives were each rejected: deleting the load loses data the user
did not ask to lose, transferring it puts a number on a point they did not choose, and
orphaning it yields a project that fails to open. Refusing keeps the user in control and
leaves the form in edit mode so the fix and retry are one step. Making a destination TC
when it carries **no** load is unaffected, so the rule is not over-applied.

**A bug the new tests caught.** The first attempt resolved the target with
`registry.nodeAsset(id)`, which only knows canonical ids, so an **aliased coordinate
spelling** of the same TC node returned `null` and the check was silently skipped. Both
the parser and the panel now canonicalise first (`canonicalNodeId`), and tests pin that
the alias is refused at the model, the parser, the reassign path and the import planner.

**Import-planner coverage.** The import path has its own test (test 8) that drives
`parseNodeLoadImport` with real delimited text and a canonicalising resolver — the same
function CSV import and clipboard paste share — rather than hand-building a plan. A
separate test (test 9) pins that an aliased spelling is refused for *ineligibility*, not
for being unrecognised, and test 19 pins the fail-closed capability requirements.

**Compatibility.** A saved file that already contains a TC load is now refused with a
clear message naming the record and the point. Parsing is all-or-nothing, so nothing is
half-applied, and the recovery/overwrite protections are unchanged — the stored project
is not touched automatically. No schema migration was needed: the schema did not change,
only which documents are accepted. `reassignLoad()` gained an options argument; its one
caller is the panel's orphan picker, which was updated, and the resulting error is
surfaced through the existing `notify()` path.

**Deliberately unchanged.** An **orphan** load (pointing at a node the drawing no longer
has) is still kept and warned about, not refused — that remains the user's data to
reassign, and `reassignLoad()` is the supported way to place it on a live eligible point.

The `addLoadUnchecked` alias added earlier in this work was **removed**: it was introduced
as a "backwards-compatible" alias for a symbol that never existed in the previous public
API (confirmed with `git log -S`), and it had no consumer. `insertLoadRecord()` remains
the single explicitly named unguarded primitive.

---

## Documentation corrections made during this task

These were errors in *documentation written during this task*, found by checking
against the code, and already corrected. They are listed for transparency, not as
defects in the application.

| Drafted claim | Actual code | Where corrected |
| --- | --- | --- |
| Project file stores `designationCounters` | It does **not**; counters are derived on load by `countersFromDesignations()` | [Persistence §3](05-persistence.md#3-what-is-deliberately-not-stored) |
| Project file stores `spanLengths`/`nodeDesignations` as arrays of pairs | They are **objects keyed by id** | [Persistence §1–2](05-persistence.md#1-the-document-envelope) |
| `originMarker` value is `pole` | It is **`plain`** (the form's `<option value="plain">`; the serializer normalises) | [Persistence §2](05-persistence.md#2-project-field-reference) |
| The parser accepts direction labels | It accepts **keys only**; `"South"` is refused with `INVALID_ROUTES` | F1 above, and [Persistence §2](05-persistence.md#2-project-field-reference) |
| The spacing input's minimum is the constant 12 | The markup says 39 and boot sets it to **35** (`requiredSpanLength()`) | F4 above, [User guide §14](02-user-guide.md#14-span-spacing-and-clearance) |
| `replacement.test.js` covers route-row deletion | It covers **project replacement** (`sameAuthoredProject`); row deletion is covered by `route_identity.test.js` and `reconcile.test.js` | [Feature matrix §1](09-feature-matrix.md#1-route-entry-and-topology) |
| A browser check proves row editing | No such check exists **(now added — browser §5)** | F2 above |
| A browser check proves a click is not a drag | No such check exists | [Feature matrix §5](09-feature-matrix.md#5-annotation-placement) |
| The example's bounding box is `minX=−3, maxX=5` | It is `minX=0, maxX=12, minY=−17, maxY=0` | [Route and geometry §1](04-route-and-geometry.md#1-coordinate-system) |

---

## F11 — An aliased load id is not resolved by the schedule and annotation layers

**Status: closed.** Found while fixing the TC-transition guard (F10), then fixed in a
separate act once the F10 work was committed and validated.

**Observed.** A load's `nodeId` is normally the canonical asset id (`dst:route-6`), but
the registry also accepts a **coordinate spelling** as an alias: `canonicalNodeId('0,-2')`
returns `dst:route-1`. The project parser accepts such a load, keeps the spelling verbatim,
and correctly resolves it for the eligibility rule — so the file loads. But two other
layers compare the raw string:

- `src/ui/network_panel.js` (`known.has(load.nodeId)`) treats the load as an **orphan**;
- because of that, the annotation layer draws **no callout** for it.

Reproduced with a project built by the real serializer:

```
routes: [{ id: 'route-1', from: 'origin', direction: 'south', spans: 2, tc: false }]
loads:  [{ id: 'load-1', nodeId: '0,-2', value: 25, unit: 'kVA' }]   // alias
```

The load parses `ok: true`, but the app shows *"1 load refers to points or spans this
drawing no longer has"* and the 25 kVA callout is missing from the drawing.

**Impact.** Low, because the application never *writes* an alias: every UI path stores the
canonical id, so this is reachable only through a hand-edited or externally generated
file. It is not zero, though — the parser accepts the file, which makes the resulting
"orphan" report misleading rather than merely absent.

**Fixed.** `validateMeasuredData()` in `src/ui/project.js` canonicalises each load's
`nodeId` **once**, at the boundary where loads enter application state, using the registry
it already builds for the eligibility check:

```js
const validatedLoads = loads.map((load) => {
  const canonical = registry.canonicalNodeId(load.nodeId);
  return canonical === null ? load : { ...load, nodeId: canonical };
});
```

Every downstream consumer — the schedule panel's `known.has(load.nodeId)`, the annotation
layer's `callout:<nodeId>`, the reassignment picker, the saved project — now sees one
spelling, so no consumer needed alias logic of its own. Only identifiers that **resolve**
are rewritten: a genuinely unresolved reference keeps its exact text, so the existing
reconciliation warning still fires and Reassign is still offered. `validatedLoads` holds new
objects, so the caller's parsed JSON is not mutated. No schema version change: the stored
contract is unchanged, and an alias file is simply read into canonical form.

**Verified after the fix.** The same serializer-built project now parses to
`{ id: 'load-1', nodeId: 'dst:route-1', value: 25, unit: 'kVA' }` with **no** orphan warning;
the schedule panel shows `dst:route-1 pole` with no `is-unresolved` mark; the callout is
drawn as `callout:dst:route-1` carrying `25 kVA`; and a real save writes the canonical id,
which survives a reload. Projects that already use canonical ids are byte-identical, and a
load pointing at `dst:gone` still reports *"belongs to points this drawing no longer has"*
and keeps its spelling.

**Why not teach each consumer.** Two subsystems (and the picker, and the exporter) all ask
the same question. Fixing them individually means four implementations of one rule and four
chances to disagree, which is exactly how this defect arose; normalising at the single
entry point gives them nothing to disagree about.

---

## F12 — The in-drawing notice overlay intercepts pointer events over the annotations beneath it

**Status: open. Recorded, not changed.** Discovered while adding the F3 zoom coverage; it
is unrelated to the zoom conversion, so it was left alone rather than folded into an act
about coordinate arithmetic.

**Observed.** When a drawing has unmeasured spans or loads, the renderer adds an
`#notice` group (`src/render/svg.js`) carrying a filled white rectangle
(`fill="#ffffff" fill-opacity="0.92"`) and a centred message. It is appended **after**
`#load-callouts` and `#span-lengths`, so it paints over them, and because the rectangle has
default `pointer-events` it also **takes the hit** for anything underneath.

A pointer press that lands on the notice is therefore a press on the notice, not on the
label beneath: `pointerdown` on the canvas finds no `[data-annot-id]` ancestor, the drag
never starts, and the event reaches the stage listener, which **pans the viewport**
instead. So a callout that happens to sit under the notice cannot be dragged at all, and
attempting it moves the whole drawing.

Reproduced while writing the F3 tests: with two unmeasured spans, a callout dragged to a
position under the notice returned `elementFromPoint` -> the notice's `text` for every
sample point across its plate, and a drag gesture panned the viewport (`panX`
`342.3 -> 382.2`) while the stored offset stayed at `{dx: -20.84, dy: -21.2}`.

**Impact.** Low–Medium. It is not reachable while every span and load is measured —
the notice is absent then — but an incomplete survey is an ordinary working state, and in
that state some labels simply cannot be moved. The failure is quiet and misleading: the
user sees the drawing jump rather than an explanation. No data is lost or corrupted, which
is why it is not higher.

**Why it was not folded into F3.** F3 concerns the screen-space-to-scene-space conversion
of drag travel. This is a hit-testing and paint-order matter in the renderer, and changing
it needs its own decision about whether an informational overlay should be interactive at
all. It is also confined to the on-screen preview: `showCompleteNotice` is true only for
the preview profile, so the notice is not drawn into an exported PDF or SVG (see
[F6](#f6-the-completeness-notice-is-preview-only)) and this cannot affect a printed sheet.

**Suggested direction, if it is taken up.** Mark the notice non-interactive —
`pointer-events="none"` on the `#notice` group — so it stays visible and exported but
stops absorbing input, and add a browser check that presses a point known to be under the
notice and asserts that the drag either starts or that the viewport does not move. Worth
confirming at the same time that the notice is not the only overlay relying on default
pointer behaviour.

**Workaround, documented rather than coded.** Measure the spans first; the notice then
disappears and every callout is draggable.
