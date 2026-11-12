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
