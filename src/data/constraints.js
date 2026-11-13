/**
 * The route and spacing limits, in one place.
 *
 * Two very different kinds of value pass through this file, and the difference is
 * the whole point of it existing:
 *
 *  - **Interactive values** are what a person can type into the form. They are
 *    bounded, and the bounds are enforced by rejecting or clamping before
 *    anything is changed.
 *  - **Stored values** are what a project file already contains. They are never
 *    rejected, clamped or rewritten on the way in. A file that was saved by an
 *    older build - or by a newer one with looser bounds - must still open, and
 *    the values the user authored must survive until they deliberately change
 *    them. All this module does for those is *describe* them, so the application
 *    can warn and offer a repair instead of silently editing the user's data.
 *
 * Keeping both halves here means the form, the parser and the tests cannot
 * disagree about what the limits are. Before this module they did: the form
 * refused a 501st span while the parser accepted it, and the form clamped
 * spacing to a 12-120 px window while the parser accepted 8 px.
 *
 * Deliberately DOM-free and geometry-free: it must be usable from the parser,
 * from tests and from the controller without a document, and the clearance
 * minimum is passed in rather than imported, because the geometry layer owns it
 * (`requiredSpanLength()` in `src/geometry/clearance.js`). Nothing here
 * duplicates that calculation - it only compares against it.
 */

/**
 * Most spans one route may be *given* through the form.
 *
 * This is an authoring limit, not a limit on what can be drawn or read: a
 * project with a longer route still opens, and the route can still be edited as
 * long as its span count does not grow.
 */
export const MAX_ROUTE_SPANS = 500;

/**
 * Narrowest spacing the spacing field will hold.
 *
 * A floor rather than a clearance requirement: below this the markers sit on top
 * of each other and the drawing stops being a drawing. The real requirement is
 * `requiredSpanLength()`, which is larger, and spacing between the two is
 * accepted with a warning and with export disabled - see `checkSpanClearance()`
 * in `src/geometry/clearance.js`.
 */
export const MIN_SPAN_SPACING = 12;

/** Widest spacing the spacing field will hold. */
export const MAX_SPAN_SPACING = 120;

/**
 * Judge a span count typed into the form.
 *
 * A route that is *already* longer than `MAX_ROUTE_SPANS` - it came from a file,
 * not from this form - may keep its count, and may be shortened. What it may not
 * do is grow. Refusing outright would trap the user, because every other change
 * to that route (its direction, its marker, its starting point) would then require
 * shortening a route they did not mean to touch.
 *
 * The rule is **monotonic non-increase** against the count the route currently
 * has, which is what makes progressive reduction work: 648 may become 600, and 600
 * may then become 550. An earlier version of this function accepted an over-limit
 * count only when it was *identical* to the existing one, so every intermediate
 * step of a reduction was refused and the only reachable way to shorten a long
 * route was to jump straight to 500 or fewer.
 *
 * @param {number} spans Count from the form.
 * @param {object} [options] Context for the judgement.
 * @param {number|null} [options.existingSpans] Count the route already has, when editing.
 * @returns {{ok: boolean, code: string|null, message: string|null, grandfathered: boolean}}
 *   Verdict. `grandfathered` describes the situation rather than the verdict: it is
 *   true whenever both the route as it stands and the proposed count are over the
 *   limit, so a refusal for growth is visibly a refusal about a grandfathered route
 *   and not about a new over-limit one.
 */
export function checkRouteSpanCount(spans, options = {}) {
  const existingSpans = Number.isInteger(options.existingSpans) ? options.existingSpans : null;
  if (!Number.isInteger(spans)) {
    return {
      ok: false,
      code: 'SPANS_NOT_INTEGER',
      message: 'Spans must be a whole number (no decimals).',
      grandfathered: false,
    };
  }
  if (spans <= 0) {
    return {
      ok: false,
      code: 'SPANS_BELOW_ONE',
      message: 'Spans must be greater than zero.',
      grandfathered: false,
    };
  }
  const overLimit = spans > MAX_ROUTE_SPANS;
  if (overLimit) {
    // Grandfathering comes from the route as it stands, not from the number the user
    // happened to type. A route at or under the limit has nothing to grandfather, so a
    // new over-limit route is always refused.
    const grandfatheredFrom = existingSpans !== null && existingSpans > MAX_ROUTE_SPANS;
    if (!grandfatheredFrom) {
      return {
        ok: false,
        code: 'SPANS_ABOVE_LIMIT',
        message: `Use ${MAX_ROUTE_SPANS} spans or fewer for one route.`,
        grandfathered: false,
      };
    }
    if (spans > existingSpans) {
      return {
        ok: false,
        code: 'SPANS_ABOVE_LIMIT',
        message:
          `This route has ${existingSpans} spans, above the ${MAX_ROUTE_SPANS} the form ` +
          'adds routes with. It is kept as saved, so you can lower that count or leave ' +
          'it, but not raise it.',
        grandfathered: true,
      };
    }
  }
  return { ok: true, code: null, message: null, grandfathered: overLimit };
}

/**
 * Bring a typed spacing into the range the field can hold.
 *
 * Only ever applied to a value the user has just entered, never to a value read
 * from a file - clamping a stored value would rewrite the user's data behind
 * their back.
 *
 * @param {number} value Value from the field.
 * @returns {number|null} The clamped, whole-pixel spacing, or `null` if unusable.
 */
export function clampSpanSpacing(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(MAX_SPAN_SPACING, Math.max(MIN_SPAN_SPACING, Math.round(number)));
}

/**
 * Describe stored route span counts that the form would not accept.
 *
 * Advisory only: the route is opened and drawn with the count exactly as saved, and
 * the count may be kept when the route is edited - it just may not grow. The wording
 * says all three of those things, because an earlier version told the user to shorten
 * the route *before changing anything else*, which was both unnecessary (the count is
 * retained and the route is editable) and false.
 *
 * @param {Array<{spans: number}>} routes Routes as read.
 * @returns {string[]} One message per out-of-range route, in row order.
 */
export function describeStoredRouteLimits(routes) {
  const warnings = [];
  for (const [index, route] of (Array.isArray(routes) ? routes : []).entries()) {
    if (!Number.isInteger(route?.spans) || route.spans <= MAX_ROUTE_SPANS) continue;
    warnings.push(
      `Route ${index + 1} has ${route.spans} spans, above the ${MAX_ROUTE_SPANS} the form ` +
        'adds routes with. It is kept as saved: you can leave that count or lower it, ' +
        `but not raise it. At ${MAX_ROUTE_SPANS} or fewer it is an ordinary route again.`,
    );
  }
  return warnings;
}

/**
 * Describe a stored spacing that the form would not accept.
 *
 * The two messages cover the two ends of the field's range. Export is already
 * withheld for the tight end by `checkSpanClearance()`, which is why the message
 * can say so; the wide end draws perfectly well and only the field disagrees.
 *
 * @param {number} spanLength Spacing as read.
 * @param {object} options Injection context.
 * @param {number} options.requiredSpacing Smallest spacing the markers need, from
 *   `requiredSpanLength()`. Passed in so this module stays geometry-free.
 * @returns {string[]} Zero or one message.
 */
export function describeStoredSpacingLimits(spanLength, options = {}) {
  const value = Number(spanLength);
  if (!Number.isFinite(value)) return [];
  const required = Number(options.requiredSpacing);
  if (Number.isFinite(required) && value < required) {
    return [
      `The span spacing in this project is ${value} px, below the ${required} px ` +
        'the marker symbols need. It is kept as saved: the drawing is shown, and export ' +
        'stays disabled until you raise the spacing.',
    ];
  }
  if (value > MAX_SPAN_SPACING) {
    return [
      `The span spacing in this project is ${value} px, wider than the ` +
        `${MAX_SPAN_SPACING} px the spacing field accepts. It is kept as saved; changing ` +
        'the field will bring it back within range.',
    ];
  }
  return [];
}

/**
 * Every stored value the form would not accept, in the order it was found.
 *
 * @param {object} project The project as read.
 * @param {Array<{spans: number}>} project.routes Routes as read.
 * @param {number} project.spanLength Spacing as read.
 * @param {object} options Injection context, see `describeStoredSpacingLimits`.
 * @returns {string[]} Messages, empty when everything is within the form's range.
 */
export function describeStoredLimits(project, options = {}) {
  return [
    ...describeStoredRouteLimits(project?.routes),
    ...describeStoredSpacingLimits(project?.spanLength, options),
  ];
}
