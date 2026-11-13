/**
 * Canonical capture of every automatically placed annotation in a scene.
 *
 * TEST SUPPORT ONLY. Nothing under `src/` imports this file.
 *
 * Why it exists: the annotation layer is going to get a spatial index, and the only
 * acceptable outcome is that **not one placement changes**. A count of labels is not
 * evidence of that, and neither is a screenshot. This module serializes every
 * placement decision - identity, chosen candidate, exact centre, collision count,
 * manual-versus-automatic, and the leader and arrowhead derived from the centre - into
 * a canonical text that can be compared byte for byte before and after the change.
 *
 * The format is positional and pipe-separated, one record per line, because it is
 * complete (every observable field) and small enough to commit as a fixture for a
 * 501-span drawing. The column order is written into each fixture's header, and the
 * numbers are produced by `String()`, which is round-trip exact for doubles and
 * therefore deterministic in this engine.
 *
 * The fixtures committed next to the tests were produced by running this module against
 * the *unoptimized* implementation, which is what makes them a contract rather than a
 * snapshot of whatever the code does today.
 */

import { buildNetwork } from '../../src/geometry/network.js';
import { buildScene } from '../../src/geometry/scene.js';

/** Column order, repeated in each fixture header so a diff can be read unaided. */
export const CAPTURE_COLUMNS = [
  'kind',
  'id',
  'assetId',
  'centerX',
  'centerY',
  'side',
  'candidateIndex',
  'collisions',
  'manual',
  'fontSize',
  'lines',
  'a',
  'b',
  'measured',
  'leader',
  'arrow',
];

/** The measured data a scene build needs, from a benchmark project. */
function measuredDataOf(project) {
  return {
    loads: project.loads ?? [],
    spanLengths: project.spanLengths ?? {},
    loadPlacements: project.loadPlacements ?? {},
    spanPlacements: project.spanPlacements ?? {},
  };
}

/**
 * Build one scene from a benchmark project, through the real pipeline.
 *
 * @param {object} project Benchmark project.
 * @param {string} [profileId] Render profile id.
 * @returns {object} Scene.
 */
export function buildSceneFor(project, profileId = 'preview') {
  const network = buildNetwork(project.routes);
  if (!network.ok) {
    throw new Error(`fixture does not build: ${JSON.stringify(network.errors)}`);
  }
  return buildScene(network, profileId, { spanLength: project.spanLength }, measuredDataOf(project));
}

/** `span.a` / `span.b` hold the resolved node asset; record its id, not `[object]`. */
function assetIdOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return String(value.id ?? value.assetId ?? '');
  return String(value);
}

/** One annotation as its positional record. */
function annotationFields(item) {
  const leader = item.leader
    ? [
        item.leader.x1,
        item.leader.y1,
        item.leader.x2,
        item.leader.y2,
        item.leader.tipX,
        item.leader.tipY,
      ]
    : null;
  const arrow = item.arrow
    ? [
        item.arrow.tipX,
        item.arrow.tipY,
        ...item.arrow.points.flatMap((p) => [p.x, p.y]),
      ]
    : null;
  return [
    item.kind,
    item.id,
    item.assetId,
    String(item.center.x),
    String(item.center.y),
    item.side,
    String(item.candidateIndex),
    String(item.collisions),
    String(item.manual),
    String(item.fontSize),
    JSON.stringify(item.lines),
    assetIdOf(item.a),
    assetIdOf(item.b),
    item.kind === 'span' ? String(item.measured) : '',
    leader ? leader.map(String).join(' ') : '',
    arrow ? arrow.map(String).join(' ') : '',
  ];
}

/**
 * Serialize a scene's annotation layer canonically.
 *
 * @param {object} scene Scene from `buildScene`.
 * @param {object} [options] Tuning.
 * @param {boolean} [options.includeNotice] Include the completeness notice record.
 * @returns {string} Canonical text, one record per line, `\n`-separated.
 */
export function canonicalPlacements(scene, options = {}) {
  const includeNotice = options.includeNotice !== false;
  const layer = scene.annotations ?? { callouts: [], spans: [], obstacles: [], notice: null };
  const lines = [];
  lines.push('# placement-capture v1');
  lines.push(`# scene ${scene.width}x${scene.height} padding=${String(scene.padding)}`);
  lines.push(`# columns ${CAPTURE_COLUMNS.join('|')}`);
  lines.push(
    `# callouts=${layer.callouts.length} spans=${layer.spans.length} ` +
      `obstacles=${(layer.obstacles ?? []).length}`,
  );
  for (const callout of layer.callouts) lines.push(annotationFields(callout).join('|'));
  for (const span of layer.spans) lines.push(annotationFields(span).join('|'));
  if (includeNotice) {
    const n = layer.notice;
    lines.push(
      n
        ? [
            'notice',
            n.id,
            '',
            String(n.center.x),
            String(n.center.y),
            '',
            '',
            '',
            '',
            String(n.fontSize),
            JSON.stringify([n.text]),
            '',
            '',
            '',
            '',
            [n.size.width, n.size.height, n.boxes.x1, n.boxes.y1, n.boxes.x2, n.boxes.y2]
              .map(String)
              .join(' '),
          ].join('|')
        : 'notice|none',
    );
  }
  lines.push(`completeness|${JSON.stringify(layer.completeness)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The same capture for one benchmark project.
 *
 * @param {object} project Benchmark project.
 * @param {string} [profileId] Render profile id.
 * @param {object} [options] See `canonicalPlacements`.
 * @returns {string} Canonical text.
 */
export function captureProject(project, profileId = 'preview', options = {}) {
  return canonicalPlacements(buildSceneFor(project, profileId), options);
}

/**
 * The record lines of a capture: everything except the header comments.
 *
 * @param {string} text Canonical capture.
 * @returns {string[]} Records.
 */
export function recordLines(text) {
  return text.split('\n').filter((line) => line && !line.startsWith('#'));
}

/**
 * The annotation records only, ignoring the notice and the completeness line.
 *
 * Placements are profile-independent by design, so this is what must match across the
 * preview and the exports; the notice deliberately does not.
 *
 * @param {string} text Canonical capture.
 * @returns {string[]} Records.
 */
export function placementLines(text) {
  return recordLines(text).filter(
    (line) => !line.startsWith('notice|') && !line.startsWith('completeness|'),
  );
}
