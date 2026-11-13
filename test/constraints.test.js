/**
 * Route and spacing limits: one policy, two contexts.
 *
 * These tests protect the distinction the limits module exists to make:
 *
 *   - Values typed into the form are bounded, and out-of-range input is refused
 *     or clamped before anything changes.
 *   - Values already in a project are never rejected, clamped or rewritten. A
 *     file saved by an older build - or one with looser bounds - must still open,
 *     and what the user authored must survive until they change it deliberately.
 *
 * Before this module the form and the parser disagreed in two places: the form
 * refused a 501st span while the parser accepted it, and the form clamped spacing
 * to 12-120 px while the parser accepted 8 px. Nothing in the codebase said which
 * of those was the policy.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_ROUTE_SPANS,
  MAX_SPAN_SPACING,
  MIN_SPAN_SPACING,
  checkRouteSpanCount,
  clampSpanSpacing,
  describeStoredLimits,
  describeStoredRouteLimits,
  describeStoredSpacingLimits,
} from '../src/data/constraints.js';
import {
  parseProjectJson,
  serializeProjectJson,
  toProjectPayload,
} from '../src/ui/project.js';
import { requiredSpanLength } from '../src/geometry/clearance.js';

const FIXED_DATE = new Date('2026-03-04T05:06:07.000Z');
const REQUIRED = requiredSpanLength();

/** A project whose first route is as long as the caller asks. */
function projectWithSpans(spans, spanLength = 40) {
  return {
    routes: [{ id: 'route-1', from: 'origin', direction: 'south', spans, tc: false, fpb: false }],
    originMarker: 'plain',
    spanLength,
    layout: 'a4_landscape',
  };
}

function jsonOf(project) {
  return serializeProjectJson(project, { now: FIXED_DATE });
}

/* ------------------------------------------------------------------ */
/* The limits themselves, and the span count                           */
/* ------------------------------------------------------------------ */

test('1. the policy names one limit for each bound', () => {
  assert.equal(MAX_ROUTE_SPANS, 500);
  assert.equal(MIN_SPAN_SPACING, 12);
  assert.equal(MAX_SPAN_SPACING, 120);
  // The clearance requirement is geometry's, and it is stricter than the field's floor.
  assert.ok(REQUIRED > MIN_SPAN_SPACING, `${REQUIRED} should exceed ${MIN_SPAN_SPACING}`);
});

test('2. exactly the limit is accepted, one more is not', () => {
  const atLimit = checkRouteSpanCount(MAX_ROUTE_SPANS);
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.grandfathered, false);

  const over = checkRouteSpanCount(MAX_ROUTE_SPANS + 1);
  assert.equal(over.ok, false);
  assert.equal(over.code, 'SPANS_ABOVE_LIMIT');
  assert.match(over.message, /500 spans or fewer/);
});

test('3. a count that is not a whole number above zero is refused with its own code', () => {
  assert.equal(checkRouteSpanCount(0).code, 'SPANS_BELOW_ONE');
  assert.equal(checkRouteSpanCount(-3).code, 'SPANS_BELOW_ONE');
  assert.equal(checkRouteSpanCount(2.5).code, 'SPANS_NOT_INTEGER');
  assert.equal(checkRouteSpanCount(NaN).code, 'SPANS_NOT_INTEGER');
  assert.equal(checkRouteSpanCount(1).ok, true);
});

test('4. an over-limit route from a file keeps its count when edited', () => {
  // The count is grandfathered: the edit is allowed, because refusing it would force the
  // user to shorten a route they only wanted to change the direction of.
  const kept = checkRouteSpanCount(648, { existingSpans: 648 });
  assert.equal(kept.ok, true);
  assert.equal(kept.grandfathered, true);

  // It may not grow.
  const grown = checkRouteSpanCount(649, { existingSpans: 648 });
  assert.equal(grown.ok, false);
  assert.equal(grown.code, 'SPANS_ABOVE_LIMIT');

  // Nor may a *new* route start over the limit.
  assert.equal(checkRouteSpanCount(648, { existingSpans: null }).ok, false);
  // A route already shortened below the limit is an ordinary route again.
  assert.equal(checkRouteSpanCount(500, { existingSpans: 648 }).ok, true);
});

/* ------------------------------------------------------------------ */
/* Interactive spacing                                                 */
/* ------------------------------------------------------------------ */

test('5. typed spacing is clamped into the field range, at both ends', () => {
  assert.equal(clampSpanSpacing(8), MIN_SPAN_SPACING);
  assert.equal(clampSpanSpacing(MIN_SPAN_SPACING), MIN_SPAN_SPACING);
  assert.equal(clampSpanSpacing(REQUIRED), REQUIRED);
  assert.equal(clampSpanSpacing(MAX_SPAN_SPACING), MAX_SPAN_SPACING);
  assert.equal(clampSpanSpacing(900), MAX_SPAN_SPACING);
  assert.equal(clampSpanSpacing(40.6), 41, 'whole pixels');
  assert.equal(clampSpanSpacing('60'), 60, 'a form value arrives as text');
  assert.equal(clampSpanSpacing(NaN), null);
  assert.equal(clampSpanSpacing(undefined), null);
});

/* ------------------------------------------------------------------ */
/* Describing stored values, without changing them                     */
/* ------------------------------------------------------------------ */

test('6. a stored spacing below the clearance requirement is described, not corrected', () => {
  const messages = describeStoredSpacingLimits(8, { requiredSpacing: REQUIRED });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /8 px/);
  assert.match(messages[0], new RegExp(`${REQUIRED} px`));
  assert.match(messages[0], /kept as saved/);
  assert.match(messages[0], /export/);
});

test('7. the wide end of the field range is described too', () => {
  assert.deepEqual(describeStoredSpacingLimits(MAX_SPAN_SPACING, { requiredSpacing: REQUIRED }), []);
  const messages = describeStoredSpacingLimits(MAX_SPAN_SPACING + 1, { requiredSpacing: REQUIRED });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /121 px/);
  assert.match(messages[0], /120 px/);
  assert.match(messages[0], /kept as saved/);
});

test('8. the spacing verdict follows the clearance requirement it is given', () => {
  // Same project, two different marker configurations: the warning appears only for the
  // stricter one. Nothing about the stored value changes either way.
  assert.deepEqual(describeStoredSpacingLimits(40, { requiredSpacing: 35 }), []);
  const stricter = describeStoredSpacingLimits(40, { requiredSpacing: 50 });
  assert.equal(stricter.length, 1);
  assert.match(stricter[0], /40 px/);
  assert.match(stricter[0], /50 px/);
  // A project with everything in range produces nothing at all.
  assert.deepEqual(describeStoredSpacingLimits(40, { requiredSpacing: REQUIRED }), []);
});

test('9. an over-long stored route is described by row, with its own count', () => {
  const routes = [
    { spans: 4 },
    { spans: MAX_ROUTE_SPANS + 1 },
    { spans: 1200 },
    { spans: MAX_ROUTE_SPANS },
  ];
  const messages = describeStoredRouteLimits(routes);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /Route 2 has 501 spans/);
  assert.match(messages[1], /Route 3 has 1200 spans/);
  assert.match(messages[0], /most 500/);
  assert.match(messages[0], /kept exactly as saved/);
  assert.deepEqual(describeStoredRouteLimits([{ spans: 1 }, { spans: MAX_ROUTE_SPANS }]), []);
});

test('10. the combined description covers routes and spacing together', () => {
  const project = { routes: [{ spans: 900 }], spanLength: 8 };
  const messages = describeStoredLimits(project, { requiredSpacing: REQUIRED });
  assert.equal(messages.length, 2);
  assert.match(messages[0], /Route 1 has 900 spans/);
  assert.match(messages[1], /8 px/);
  assert.deepEqual(describeStoredLimits({ routes: [{ spans: 2 }], spanLength: 40 }, {
    requiredSpacing: REQUIRED,
  }), []);
});

/* ------------------------------------------------------------------ */
/* The parser accepts what the form would not, and says so             */
/* ------------------------------------------------------------------ */

test('11. a project with more spans than the form allows still opens, unchanged', () => {
  const project = projectWithSpans(MAX_ROUTE_SPANS + 1);
  const parsed = parseProjectJson(jsonOf(project));
  assert.equal(parsed.ok, true, 'a longer route is readable, not corrupt');
  assert.equal(parsed.project.routes[0].spans, MAX_ROUTE_SPANS + 1, 'the count is preserved');
  assert.ok(
    parsed.warnings.some((w) => /Route 1 has 501 spans/.test(w)),
    'the reader is told, so the limit is not a surprise later',
  );
});

test('12. a project with spacing below the clearance requirement still opens, unchanged', () => {
  const project = projectWithSpans(2, REQUIRED - 1);
  const parsed = parseProjectJson(jsonOf(project));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.project.spanLength, REQUIRED - 1, 'the authored spacing is preserved');
  assert.ok(parsed.warnings.some((w) => /below the \d+ px the marker symbols need/.test(w)));
});

test('13. a project with spacing above the field range still opens, unchanged', () => {
  const project = projectWithSpans(2, 300);
  const parsed = parseProjectJson(jsonOf(project));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.project.spanLength, 300);
  assert.ok(parsed.warnings.some((w) => /300 px/.test(w) && /120 px/.test(w)));
});

test('14. an in-range project carries no limit warnings at all', () => {
  const parsed = parseProjectJson(jsonOf(projectWithSpans(MAX_ROUTE_SPANS, REQUIRED)));
  assert.equal(parsed.ok, true);
  // Whatever else the reader may say, nothing may be said about limits.
  assert.deepEqual(
    parsed.warnings.filter((w) => /spans|spacing/.test(w)),
    [],
  );
});

test('15. an out-of-range project survives a save and reload without drifting', () => {
  const saved = jsonOf(projectWithSpans(MAX_ROUTE_SPANS + 40, 9));
  const first = parseProjectJson(saved);
  assert.equal(first.ok, true);
  // Re-serialize exactly what was read, then read it again: no clamping, no rounding, no
  // quiet repair on the way through.
  const again = parseProjectJson(serializeProjectJson(first.project, { now: FIXED_DATE }));
  assert.equal(again.ok, true);
  assert.equal(again.project.routes[0].spans, MAX_ROUTE_SPANS + 40);
  assert.equal(again.project.spanLength, 9);
  assert.deepEqual(
    again.project.routes.map((r) => r.spans),
    first.project.routes.map((r) => r.spans),
  );
});

test('16. the parser does not clamp a stored value into the field range', () => {
  const parsed = parseProjectJson(jsonOf(projectWithSpans(2, 9)));
  assert.equal(parsed.ok, true);
  assert.notEqual(parsed.project.spanLength, MIN_SPAN_SPACING);
  assert.equal(parsed.project.spanLength, 9);
  // And the serializer writes back what it was given, not the clamped figure.
  const payload = toProjectPayload(parsed.project);
  assert.equal(payload.spanLength, 9);
});

test('17. an older document keeps out-of-range values through every migration step', () => {
  // The migrations add measured data and point names; they must not be the place where a
  // limit is quietly applied.
  const v1 = JSON.parse(jsonOf(projectWithSpans(MAX_ROUTE_SPANS + 7, 6)));
  v1.schemaVersion = 1;
  delete v1.project.loads;
  delete v1.project.spanLengths;
  const parsed = parseProjectJson(JSON.stringify(v1));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.project.routes[0].spans, MAX_ROUTE_SPANS + 7);
  assert.equal(parsed.project.spanLength, 6);
  assert.ok(parsed.warnings.some((w) => /Route 1 has 507 spans/.test(w)));
});
