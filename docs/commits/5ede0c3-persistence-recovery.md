# Commit 5ede0c3 — persistence recovery, route identity, replacement confirmation

This note holds the full rationale for commit `5ede0c3`. The commit message was
cut short by a shell heredoc failure part way through, and amending is not
permitted, so the remainder is recorded here. Everything below was true of the
commit when it was made.

The message that landed covers:

1. the startup defect that destroyed an unreadable saved project, and the
   `recoveryPending` gate that now stops it;
2. route ids lost during hydration, and their preservation through
   `createRoute({ id })` and `reserveRouteId`;
3. the replacement confirmation that asked only about route count, replaced by a
   comparison of the whole authored project;
4. the scope boundaries that were not touched, and the file list.

## Validation

`npm test` 174 passing (was 138): 36 new cases across `test/recovery.test.js`
(10), `test/route_identity.test.js` (11) and `test/replacement.test.js` (15).

Browser harness 86/86, up from 68.

### Startup recovery

Verified in a real browser rather than only in unit tests, because the defect
lived in startup ordering and DOM wiring:

- a corrupted stored value shows the recovery bar, the session stays usable, and
  the stored bytes are unchanged afterwards;
- adding, editing and deleting routes and changing origin, spacing and layout all
  leave the stored value untouched while recovery is pending;
- reloading while pending still leaves it untouched, so the defect cannot recur
  on the next visit;
- Save project downloads the current session while recovering;
- declining the discard changes nothing: storage and the bar are both unchanged;
- accepting it is the only way persistence resumes, and the next reload restores
  that newly authorised project;
- a project saved by a newer version is preserved byte-for-byte and explained,
  not treated as an empty slot.

### Route identity

A project saved with ids `route-10` to `route-18` is loaded into a freshly
reloaded page and restores those exact ids; editing one row leaves the other
eight unchanged; a new route takes `route-19`; deleting one keeps the survivors
stable.

### Replacement confirmation

An identical project asks nothing; empty projects differing only in Origin
symbol, in spacing, or in page layout each ask; declining leaves spacing, layout,
origin and localStorage unchanged; an invalid file reports its error without
asking anything.

### Regressions, all still passing

The 39 px minimum and its warning; exports disabled at 20 px with the typed value
preserved; TC and FPB clipping with no X and no line inside a symbol; the Origin
dropdown labels; TC and FPB destination naming; PDF, SVG and print hiding the
Origin and alphabetical labels while keeping every line and symbol; and the PDF
staying vector-only.

## Rollback

Each correction reverts independently:

- the recovery gate is the `recoveryPending` early return in `persistProject()`
  plus the `recovery` branch of `restoreOrStart()`; removing both restores the
  previous startup behaviour;
- the id change is one `id:` argument in `applyProject` and the id branch of
  `createRoute`;
- the confirmation change is the comparison call in `loadProjectFile`.

Nothing else depends on any of them, and no committed data format changed, so a
project written now stays readable either way.
