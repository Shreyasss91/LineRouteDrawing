/**
 * Timing helper for the performance baseline.
 *
 * The rules this file exists to enforce, because a benchmark that breaks them
 * produces numbers that look precise and mean nothing:
 *
 *   - **Warm up first.** The first run of a phase pays for JIT compilation, so it is
 *     discarded. What is measured is steady state, which is what a user feels while
 *     editing; cold start is measured separately and labelled as such.
 *   - **Report a distribution, not one number.** Median and p95. A single run of a
 *     9 ms phase can read 14 ms because something else happened.
 *   - **Use the high-resolution clock.** `performance.now()` where available.
 *
 * Nothing here is imported by the application. It is measurement only.
 */

/** High-resolution clock, whichever runtime this is. */
export const now =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

/**
 * Run a function repeatedly and summarize the timings.
 *
 * @param {() => unknown} fn Work to measure. Any return value is discarded.
 * @param {object} [options] Tuning.
 * @param {number} [options.warmup] Runs discarded before measuring.
 * @param {number} [options.iterations] Measured runs.
 * @returns {{median: number, p95: number, min: number, max: number, iterations: number}}
 *   Milliseconds. `p95` uses the nearest-rank method on the sorted samples.
 */
export function timeIt(fn, options = {}) {
  const warmup = options.warmup ?? 3;
  const iterations = options.iterations ?? 25;
  for (let i = 0; i < warmup; i += 1) fn();

  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = now();
    fn();
    samples.push(now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  return {
    median: at(0.5),
    p95: at(0.95),
    min: samples[0],
    max: samples[samples.length - 1],
    iterations,
  };
}

/** Format milliseconds for a table: fixed width, three decimals. */
export function ms(value) {
  return `${value.toFixed(3)} ms`;
}

/**
 * Render a result set as a plain-text table.
 *
 * @param {string[]} rowLabels Row names, e.g. the phase names.
 * @param {Array<{name: string, results: Record<string, {median: number, p95: number}>}>} groups
 *   One group per dataset.
 * @returns {string} Table text.
 */
export function table(rowLabels, groups) {
  const width = Math.max(...rowLabels.map((label) => label.length)) + 2;
  const cell = (group, label) => {
    const result = group.results[label];
    return result ? `${result.median.toFixed(3)} / ${result.p95.toFixed(3)}` : '-';
  };
  const lines = [];
  lines.push(`${''.padEnd(width)}${groups.map((g) => g.name.padEnd(22)).join('')}`);
  for (const label of rowLabels) {
    lines.push(`${label.padEnd(width)}${groups.map((g) => cell(g, label).padEnd(22)).join('')}`);
  }
  return lines.join('\n');
}
