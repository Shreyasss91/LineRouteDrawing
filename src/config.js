/**
 * Central application configuration.
 *
 * Every tunable drawing dimension lives here so that the geometry engine, the
 * scene builder and all renderers share one source of truth. Nothing in this
 * file depends on the DOM, so it can be imported from Node.js tests.
 */

/** Cardinal directions understood by the geometry engine. */
export const DIRECTIONS = Object.freeze({
  north: Object.freeze({ key: 'north', dx: 0, dy: 1, label: 'North' }),
  south: Object.freeze({ key: 'south', dx: 0, dy: -1, label: 'South' }),
  east: Object.freeze({ key: 'east', dx: 1, dy: 0, label: 'East' }),
  west: Object.freeze({ key: 'west', dx: -1, dy: 0, label: 'West' }),
});

/** Case-insensitive lookup table for direction names. */
export const DIRECTION_ALIASES = Object.freeze(
  Object.fromEntries(
    Object.values(DIRECTIONS).flatMap((dir) => [
      [dir.key, dir.key],
      [dir.label.toLowerCase(), dir.key],
    ]),
  ),
);

/**
 * Rendering profiles. Each profile is an explicit configuration object; the
 * canonical network model is never mutated to hide labels.
 */
export const RENDER_PROFILES = Object.freeze({
  preview: Object.freeze({
    id: 'preview',
    showOriginLabel: true,
    showAlphaLabels: true,
    showPoleMarkers: true,
    showLines: true,
    showTcMarkers: true,
    showFpbMarkers: true,
    showJunctionMarkers: false,
  }),
  pdf: Object.freeze({
    id: 'pdf',
    showOriginLabel: false,
    showAlphaLabels: false,
    showPoleMarkers: true,
    showLines: true,
    showTcMarkers: true,
    showFpbMarkers: true,
    showJunctionMarkers: false,
  }),
  svg: Object.freeze({
    id: 'svg',
    showOriginLabel: false,
    showAlphaLabels: false,
    showPoleMarkers: true,
    showLines: true,
    showTcMarkers: true,
    showFpbMarkers: true,
    showJunctionMarkers: false,
  }),
  print: Object.freeze({
    id: 'print',
    showOriginLabel: false,
    showAlphaLabels: false,
    showPoleMarkers: true,
    showLines: true,
    showTcMarkers: true,
    showFpbMarkers: true,
    showJunctionMarkers: false,
  }),
});

/**
 * Marker kinds a route destination can carry.
 *
 * `plain` is an ordinary endpoint drawn as an X crossing. `tc` is a test point
 * drawn as a triangle. `fpb` is a feeder pillar box drawn as a rectangle with
 * its label inside, so it never also receives an X.
 */
export const MARKER_KINDS = Object.freeze({
  plain: 'plain',
  tc: 'tc',
  fpb: 'fpb',
});

/** Page layouts offered for PDF export and printing. */
export const PAGE_LAYOUTS = Object.freeze({
  a4_landscape: Object.freeze({
    id: 'a4_landscape',
    label: 'A4 landscape',
    widthPt: 841.89,
    heightPt: 595.28,
    format: 'a4',
    orientation: 'landscape',
  }),
  a4_portrait: Object.freeze({
    id: 'a4_portrait',
    label: 'A4 portrait',
    widthPt: 595.28,
    heightPt: 841.89,
    format: 'a4',
    orientation: 'portrait',
  }),
  a3_landscape: Object.freeze({
    id: 'a3_landscape',
    label: 'A3 landscape',
    widthPt: 1190.55,
    heightPt: 841.89,
    format: 'a3',
    orientation: 'landscape',
  }),
  letter_landscape: Object.freeze({
    id: 'letter_landscape',
    label: 'Letter landscape',
    widthPt: 792,
    heightPt: 612,
    format: 'letter',
    orientation: 'landscape',
  }),
});

/** Default drawing configuration. All lengths are in CSS pixels. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Distance between two adjacent poles (one span) in px. */
  spanLength: 40,
  /** Half-size of the crossing (X) symbol arms in px. */
  poleMarkerSize: 4.5,
  /** Stroke width of route lines in px. */
  lineWidth: 1.6,
  /** Half-width of the TC triangle base in px. */
  tcMarkerSize: 6,
  /** Height of the TC triangle in px. */
  tcMarkerHeight: 10,
  /** Font size used for the FPB label inside its box, in px. */
  fpbFontSize: 11,
  /** Horizontal padding inside the FPB box, in px. */
  fpbPaddingX: 4,
  /** Vertical padding inside the FPB box, in px. */
  fpbPaddingY: 2.5,
  /** Text drawn inside an FPB marker. */
  fpbText: 'FPB',
  /** Padding added around the network bounding box for exports, in px. */
  exportPadding: 28,
  /** Padding inside the browser viewport, in px. */
  viewPadding: 36,
  /** Minimum page margin for PDF export, in pt. */
  pdfMarginPt: 28,
  /** Font family used for every text element. */
  fontFamily: 'Helvetica, Arial, sans-serif',
  /** Font size for origin and alphabetical labels, in px. */
  labelFontSize: 13,
});

/** The example configuration from the handwritten reference drawing. */
export const EXAMPLE_ROUTES = Object.freeze([
  Object.freeze({ from: 'origin', direction: 'south', spans: 1, tc: false }),
  Object.freeze({ from: 'A', direction: 'east', spans: 4, tc: false }),
  Object.freeze({ from: 'B', direction: 'south', spans: 3, tc: true }),
  Object.freeze({ from: 'tc:1', direction: 'south', spans: 3, tc: false }),
  Object.freeze({ from: 'C', direction: 'east', spans: 1, tc: false }),
  Object.freeze({ from: 'C', direction: 'south', spans: 2, tc: false }),
  Object.freeze({ from: 'D', direction: 'west', spans: 3, tc: false }),
  Object.freeze({ from: 'D', direction: 'east', spans: 7, tc: false }),
  Object.freeze({ from: 'D', direction: 'south', spans: 10, tc: false }),
]);

/** Merge overrides supplied at runtime onto the default configuration. */
export function createConfig(overrides = {}) {
  const merged = { ...DEFAULT_CONFIG, ...overrides };
  if (!(merged.spanLength > 0)) {
    throw new RangeError('spanLength must be a positive number');
  }
  return merged;
}
