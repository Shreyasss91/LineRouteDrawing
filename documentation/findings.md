# Findings

Observations made while documenting this codebase. Most were recorded for a separate
decision rather than fixed; **F10 has since been implemented and closed**, and is kept
here in its closed form so the history of the defect stays visible.

Severity is about what a user or maintainer would experience, not about code style.

| ID | Area | Severity | Status |
| --- | --- | --- | --- |
| [F1](#f1-the-form-and-the-project-parser-disagree-on-documented-limits) | Form vs. parser limits | Low | Open — documented, not changed |
| [F2](#f2-an-edited-route-is-now-covered-by-a-browser-test) | Untested UI path | Medium | **Closed** — 32 browser checks exercise the edit form |
| [F3](#f3-drag-at-zoom-is-implemented-but-unverified) | Untested UI behaviour | Low | Open |
| [F4](#f4-the-static-spacing-minimum-in-the-markup-is-stale) | Stale literal | Low | Open |
| [F5](#f5-unknown-keys-in-a-project-file-are-ignored-silently) | Forward compatibility | Low | Open |
| [F6](#f6-the-completeness-notice-is-preview-only) | Export completeness | Low | Open — arguably by design |
| [F7](#f7-route-entry-has-no-undo-and-no-row-reordering) | Data safety | Medium | Open — by design |
| [F8](#f8-appjs-is-a-1590-line-controller) | Maintainability | Low | Open |
| [F9](#f9-no-performance-baseline-for-large-drawings) | Unverified scale | Medium | Open |
| [F10](#f10-a-load-on-a-tc-point-is-now-refused-by-the-model-parser-and-import-planner) | Eligibility not enforced at the boundary | Low–Medium | **Closed** — three guarded boundaries, fail-closed, each with executable evidence |

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

## F3 — Drag at zoom is implemented but unverified

**Observed.** `app.js` divides pointer travel by the current zoom so a zoomed-out drag
moves the same distance as the cursor ("Scene-space position at the moment the drag
began, so zoom never bends the move"). The browser suite drags only at fit zoom.

**Impact.** Low — the arithmetic is simple — but an untested interaction that involves
two coordinate systems is exactly the kind that breaks quietly.

**Suggested fix.** Add a browser check that zooms in twice, drags a callout by a known
screen distance, and asserts the stored offset matches the scene-space distance.

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

## F10 — A load on a TC point is now refused by the model, parser and import planner

**Status: closed.** Enforced at three guarded boundaries, each with its own executable
coverage; the optional-resolver bypass is also fixed (see below).

**Observed originally.** A TC point is documented as not load-eligible, and
`isLoadEligible('tc') === false` was asserted by `test/schedules.test.js` test 15 and
`test/annotations.test.js` test 27. But eligibility was enforced only by the
**predicate** and by the point pickers / CSV export in `network_panel.js`. Neither
`addLoad()` nor the project parser checked it. Reproduced directly:

- `addLoad([], {nodeId: 'dst:r3' /* a TC */, value: 10, unit: 'kVA'})`
  → `{ok: true}` with the record created.
- A valid serialised project with a load on `dst:r3` → `parseProjectJson` returned
  **`ok: true`** and kept the load.

**A second weakness, found during review of the first fix.** The first fix made
`lookupNode` *optional*: a caller that omitted it skipped the eligibility check entirely.
A check that can be forgotten is not a guarantee, so the model boundary could still be
bypassed by omission. It now fails closed — the resolver is **required**, and both a
missing resolver and an unresolved target refuse the load (`MISSING_NODE_RESOLVER` and
`UNRESOLVED_LOAD_TARGET` respectively), before the `INELIGIBLE_LOAD_TARGET` check for a
resolved but ineligible point. The unguarded primitive was split out as
`insertLoadRecord()`, named so that calling it is a visible decision; it is for
restoring known-valid records only, and no user-reachable action calls it directly.

**Impact.** Low for normal use — the dropdown offered only eligible points, so the UI
could not produce this state. It mattered because the project file is the more permissive
interface (see [Known limitations §10](10-limitations.md#10-form-and-model-disagree-in-two-places)):
a hand-edited or externally generated file could place a number on a TC triangle.

**Aggravating detail, now corrected.** `test/annotations.test.js` test 27 was titled *"a
load on a TC point is refused by the data model, not placed anyway"* but asserted only
`isLoadEligible(...) === false`. It has been retitled to say what it does
("the eligibility predicate excludes a TC point from carrying a load"), and the real
model-refusal test now lives in `test/load_eligibility.test.js`.

**Fix.** Three guarded boundaries, distinguished in the docs so none is claimed to do
another's job:

1. `addLoad()` — the model operation. Fails closed: refuses with
   `MISSING_NODE_RESOLVER` when no resolver is supplied, `UNRESOLVED_LOAD_TARGET` when
   the id resolves to nothing, and `INELIGIBLE_LOAD_TARGET` when the point cannot carry a
   load. The input list is never mutated. The panel supplies a canonicalising resolver.
2. Project parser (`validateMeasuredData`) — refuses the whole file with
   `INELIGIBLE_LOAD_TARGET`, nothing to apply.
3. Schedule import planner (`parseNodeLoadImport`) — refuses the row during planning,
   before any plan exists, reported as `bad-value` with a detail naming the TC rule.
   This is the shared planner behind both CSV import and clipboard paste.

`insertLoadRecord()` and `applyNodeLoadPlan()` are **unguarded by design** and are not
counted as boundaries: the first is the primitive beneath `addLoad()`, the second trusts
a plan the planner already validated.

**A bug the new tests caught.** The first attempt resolved the target with
`registry.nodeAsset(id)`, which only knows canonical ids, so an **aliased coordinate
spelling** of the same TC node returned `null` and the check was silently skipped. Both
the parser and the panel now canonicalise first (`canonicalNodeId`), and tests pin that
the alias is refused at the model, the parser and the import planner.

**Import-planner coverage.** The import path now has its own test (test 8) that drives
`parseNodeLoadImport` with real delimited text and a canonicalising resolver — the same
function CSV import and clipboard paste share — rather than hand-building a plan. A
separate test (test 9) pins that an aliased spelling is refused for *ineligibility*, not
for being unrecognised.

**Compatibility.** A saved file that already contains a TC load is now refused with a
clear message naming the record and the point. Parsing is all-or-nothing, so nothing is
half-applied, and the recovery/overwrite protections are unchanged — the stored project
is not touched automatically. No schema migration was needed: the schema did not change,
only which documents are accepted.

**Deliberately unchanged.** `reassignLoad(loads, id, nodeId)` still has no registry
argument, so it cannot resolve a node type; its guard remains the UI picker, which
filters by `isLoadEligible`. Adding a parameter would change a settled API. An **orphan**
load (pointing at a node the drawing no longer has) is still kept and warned about, not
refused — that remains the user's data to reassign.

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
