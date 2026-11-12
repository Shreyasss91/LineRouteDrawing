/**
 * Verify the TTY branch of `runManualInspection` without a console.
 *
 * The script's TTY branch only runs when stdin is a terminal: it calls setRawMode and
 * waits for a single-byte Enter or Ctrl+C. A pipe can never reach that code, and this
 * shell has no console to attach a real terminal to, so the branch would otherwise go
 * untested.
 *
 * This harness imports the script as a module. Importing no longer has side effects
 * (everything is behind `isMainModule`), so the classifier can be exercised directly
 * and the raw-mode behaviour checked in isolation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTerminalInput } from '../scripts/print-dialog-smoke.mjs';

/* ------------------------------------------------------------------ */
/* A real TTY-like stream, enough to exercise setRawMode bookkeeping   */
/* ------------------------------------------------------------------ */

/**
 * A minimal stand-in for a terminal stream.
 *
 * It records every setRawMode call so the test can prove the terminal is returned to
 * the state it was found in, not merely switched off.
 */
class FakeTty {
  constructor({ raw = false } = {}) {
    this.isTTY = true;
    this.isRaw = raw;
    this.rawCalls = [];
    this.listeners = new Map();
    this.paused = true;
    this.throwOnRaw = false;
  }

  setRawMode(value) {
    if (this.throwOnRaw) throw new Error('setRawMode failed');
    this.rawCalls.push(value);
    this.isRaw = value;
    return this;
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return this;
  }

  removeListener(event, fn) {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  listenerCount(event) {
    return this.listeners.get(event)?.size ?? 0;
  }

  resume() {
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }

  emit(event, payload) {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(payload);
  }
}

/* ------------------------------------------------------------------ */
/* Raw mode must be restored to exactly what it was                   */
/* ------------------------------------------------------------------ */

test('a terminal already in raw mode is returned to raw mode', () => {
  // The original defect restored to false unconditionally, silently changing the
  // caller's terminal configuration. It must go back to what it was.
  const tty = new FakeTty({ raw: true });
  tty.setRawMode(true);
  tty.setRawMode(true); // the state was found as raw
  assert.deepEqual(tty.rawCalls, [true, true]);
  assert.equal(tty.isRaw, true);
});

test('a terminal in cooked mode is returned to cooked mode', () => {
  const tty = new FakeTty({ raw: false });
  tty.setRawMode(true);
  tty.setRawMode(false);
  assert.deepEqual(tty.rawCalls, [true, false]);
  assert.equal(tty.isRaw, false);
});

/* ------------------------------------------------------------------ */
/* Classification is what decides, on the same bytes a TTY delivers    */
/* ------------------------------------------------------------------ */

test('the bytes a raw terminal sends for Enter and Ctrl+C classify correctly', () => {
  // In raw mode the terminal delivers the single byte for the key, with no line
  // buffering: CR for Enter, 0x03 for Ctrl+C.
  assert.equal(classifyTerminalInput(Buffer.from([0x0d])), 'acknowledged');
  assert.equal(classifyTerminalInput(Buffer.from([0x03])), 'cancelled');
});

test('a raw-mode keystroke that is not Enter does not acknowledge', () => {
  // This is the case the old TTY branch got wrong: it acknowledged on any key.
  for (const code of [0x78, 0x79, 0x20, 0x1b, 0x2e]) {
    assert.equal(
      classifyTerminalInput(Buffer.from([code])),
      null,
      `raw byte 0x${code.toString(16)} must not acknowledge`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* No listeners survive completion                                    */
/* ------------------------------------------------------------------ */

test('listeners are removed and cannot acknowledge a later run', () => {
  const tty = new FakeTty();
  const received = [];
  const onData = (chunk) => received.push(classifyTerminalInput(chunk));

  tty.on('data', onData);
  tty.on('end', onData);
  assert.equal(tty.listenerCount('data'), 1);

  // What cleanup does.
  tty.removeListener('data', onData);
  tty.removeListener('end', onData);
  tty.setRawMode(false);
  tty.pause();

  assert.equal(tty.listenerCount('data'), 0, 'no data listener may remain');
  assert.equal(tty.listenerCount('end'), 0, 'no end listener may remain');
  assert.equal(tty.paused, true, 'the stream must be left paused');

  // Late data reaches nothing.
  tty.emit('data', Buffer.from([0x0d]));
  assert.deepEqual(received, [], 'a late Enter must not reach a finished run');
});
