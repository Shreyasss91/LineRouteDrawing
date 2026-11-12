# Findings

Observations made while documenting this codebase. **Nothing here was fixed.** The
documentation task explicitly forbade changing application source, tests, dependencies
or schema, so each item is recorded for a separate decision.

Severity is about what a user or maintainer would experience, not about code style.

| ID | Area | Severity | Status |
| --- | --- | --- | --- |
| [F1](#f1-the-form-and-the-project-parser-disagree-on-documented-limits) | Form vs. parser limits | Low | Open — documented, not changed |
| [F2](#f2-an-edited-route-has-no-automated-test) | Untested UI path | Medium | Open |
| [F3](#f3-drag-at-zoom-is-implemented-but-unverified) | Untested UI behaviour | Low | Open |
| [F4](#f4-the-static-spacing-minimum-in-the-markup-is-stale) | Stale literal | Low | Open |
| [F5](#f5-unknown-keys-in-a-project-file-are-ignored-silently) | Forward compatibility | Low | Open |
| [F6](#f6-the-completeness-notice-is-preview-only) | Export completeness | Low | Open — arguably by design |
| [F7](#f7-route-entry-has-no-undo-and-no-row-reordering) | Data safety | Medium | Open — by design |
| [F8](#f8-appjs-is-a-1590-line-controller) | Maintainability | Low | Open |
| [F9](#f9-no-performance-baseline-for-large-drawings) | Unverified scale | Medium | Open |

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

## F2 — An edited route has no automated test

**Observed.** Editing a row (`startEdit()` → "Save changes" →
`handleSubmit()` replace path, [src/ui/app.js](../src/ui/app.js)) is a common operation
with **no automated coverage**:

- `route_identity.test.js` test 5 covers "editing one restored route does not touch
  another" at the *model* level, not the DOM.
- The browser suite (198 checks) never opens the edit form.

**Impact.** A regression in the edit path — for example losing the row's `id`, which
would orphan its loads — would not be caught.

**Suggested fix.** Add a browser check: load the example, click Edit on row 2, change
the direction, Save changes, and assert (a) the row count is unchanged, (b) the route
id is preserved, (c) a load on the affected point is still resolved.

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
largest untested unit in the project, and its size is why several UI behaviours (F2,
F3) have no tests — extracting a DOM-free helper is the only way to unit-test them.

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
| A browser check proves row editing | No such check exists | F2 above |
| A browser check proves a click is not a drag | No such check exists | [Feature matrix §5](09-feature-matrix.md#5-annotation-placement) |
| The example's bounding box is `minX=−3, maxX=5` | It is `minX=0, maxX=12, minY=−17, maxY=0` | [Route and geometry §1](04-route-and-geometry.md#1-coordinate-system) |
