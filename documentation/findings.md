# Findings

Observations made while documenting this codebase. Most were recorded for a separate
decision rather than fixed; **F10 has since been implemented and closed**, and is kept
here in its closed form so the history of the defect stays visible.

Severity is about what a user or maintainer would experience, not about code style.

| ID | Area | Severity | Status |
| --- | --- | --- | --- |
| [F1](#f1-the-form-and-the-project-parser-disagree-on-documented-limits) | Form vs. parser limits | Low | Open — documented, not changed |
| [F2](#f2-an-edited-route-is-now-covered-by-a-browser-test) | Untested UI path | Medium | **Closed** — 22 browser checks exercise the edit form |
| [F3](#f3-drag-at-zoom-is-implemented-but-unverified) | Untested UI behaviour | Low | Open |
| [F4](#f4-the-static-spacing-minimum-in-the-markup-is-stale) | Stale literal | Low | Open |
| [F5](#f5-unknown-keys-in-a-project-file-are-ignored-silently) | Forward compatibility | Low | Open |
| [F6](#f6-the-completeness-notice-is-preview-only) | Export completeness | Low | Open — arguably by design |
| [F7](#f7-route-entry-has-no-undo-and-no-row-reordering) | Data safety | Medium | Open — by design |
| [F8](#f8-appjs-is-a-1590-line-controller) | Maintainability | Low | Open |
| [F9](#f9-no-performance-baseline-for-large-drawings) | Unverified scale | Medium | Open |
| [F10](#f10-a-load-on-a-tc-point-is-now-refused-by-the-model-and-the-parser) | Eligibility not enforced at the boundary | Low–Medium | **Closed** — enforced at both boundaries and tested |

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

**Fix.** A new browser section, *Editing an existing route*, in
`scripts/test-browser.mjs` (+22 checks, 198 → 221). It builds a three-route project
whose second route starts at point `A`, records a 25 kVA load on `A`, opens the edit form
through the row's own Edit button, changes the direction East → West, and saves through
the real form. It then asserts, against both the rendered table and the persisted
project:

- the route count is unchanged and the form returns to add mode;
- the edited route keeps its id in the UI **and** in the saved file;
- the load keeps the same endpoint id, stays out of the unresolved bar, and is still
drawn as a `25 kVA` callout;
- both neighbouring routes are byte-identical in the table;
- all 11 designations belonging to the fixture's routes are unchanged;
- the state survives a reload with the same id and the load still drawn.

East → West was chosen deliberately: it keeps every node id, label and designation
identical (verified against the real engine), so a failure indicates the edit path broke
identity rather than the drawing legitimately changing shape.

**No implementation defect was found.** The replacement path already spreads into the
existing route object, so `id` is preserved, and endpoint asset ids are derived from the
route id, so a load on `endpoint:A` stays resolved. The finding was a coverage gap, not a
bug.

**Test strength verified.** With `state.routes[index] = { id: createRoute(...).id, ... }`
substituted for the real replacement, 4 checks fail (stable id in the UI, id in the saved
file, designations, reload). With a line added that drops loads on the edited route's
endpoints, 2 checks fail (load still recorded, callout still drawn). The source was then
restored byte-for-byte (`git diff` empty) and the suites re-verified green.

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

## F10 — A load on a TC point is now refused by the model and the parser

**Status: closed.** Enforced at both boundaries with executable coverage.

**Observed originally.** A TC point is documented as not load-eligible, and
`isLoadEligible('tc') === false` was asserted by `test/schedules.test.js` test 15 and
`test/annotations.test.js` test 27. But eligibility was enforced only by the
**predicate** and by the point pickers / CSV export in `network_panel.js`. Neither
`addLoad()` nor the project parser checked it. Reproduced directly:

- `addLoad([], {nodeId: 'dst:r3' /* a TC */, value: 10, unit: 'kVA'})`
  → `{ok: true}` with the record created.
- A valid serialised project with a load on `dst:r3` → `parseProjectJson` returned
  **`ok: true`** and kept the load.

**Impact.** Low for normal use — the dropdown offered only eligible points, so the UI
could not produce this state. It mattered because the project file is the more permissive
interface (see [Known limitations §10](10-limitations.md#10-form-and-model-disagree-in-two-places)):
a hand-edited or externally generated file could place a number on a TC triangle.

**Aggravating detail, now corrected.** `test/annotations.test.js` test 27 was titled *"a
load on a TC point is refused by the data model, not placed anyway"* but asserted only
`isLoadEligible(...) === false`. It has been retitled to say what it does
("the eligibility predicate excludes a TC point from carrying a load"), and the real
model-refusal test now lives in `test/load_eligibility.test.js`.

**Fix.** `addLoad()` accepts an optional `lookupNode` resolver and refuses a target whose
`nodeType` is ineligible, returning `{ok: false, code: 'INELIGIBLE_LOAD_TARGET'}` without
touching the input list. The panel supplies a canonicalising resolver. The project parser
refuses a file carrying such a load in `validateMeasuredData()`, after building the
registry, returning `INELIGIBLE_LOAD_TARGET` and nothing to apply.

**A bug the new test caught.** The first attempt resolved the target with
`registry.nodeAsset(id)`, which only knows canonical ids, so an **aliased coordinate
spelling** of the same TC node returned `null` and the check was silently skipped. Both
the parser and the panel now canonicalise first (`canonicalNodeId`), and
test 7 pins that the alias is refused.

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
