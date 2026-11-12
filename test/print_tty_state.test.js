/**
 * Lifecycle tests for the headed print check's manual acknowledgement wait.
 *
 * These drive the production function, `waitForManualAcknowledgement`, from
 * `scripts/print-dialog-smoke.mjs`. They do not restate its cleanup steps: the point of
 * injecting the input stream and the timer functions is that the code under test is the
 * code that runs, so a change to cleanup that breaks restoration shows up here.
 *
 * The defect these tests exist for, in two parts:
 *
 *   1. A pipe could acknowledge. The script's wait attached its `data` listener
 *      regardless of whether stdin was a terminal, so a newline written into the
 *      process - by a script, a heredoc, a redirected file - was indistinguishable
 *      from a person pressing Enter. The check could report a completed inspection
 *      that never happened. A newline from a pipe is not a human, and the fix is to
 *      require an interactive TTY for success and fail closed otherwise.
 *
 *   2. A failed `setRawMode` was swallowed. Raw mode is what makes a single keypress
 *      arrive without waiting for a line; if it could not be enabled, the old code
 *      carried on reading a cooked stream, which is exactly the mode that accepts
 *      line-buffered input. It now gives up and reports `input_unavailable`.
 *
 * What a fake stream can and cannot prove is stated at the bottom of this file.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyTerminalInput,
  waitForManualAcknowledgement,
} from '../scripts/print-dialog-smoke.mjs';

/* ------------------------------------------------------------------ */
/* A fake TTY, behind the real production code                        */
/* ------------------------------------------------------------------ */

/**
 * A stand-in input stream that behaves enough like a terminal to exercise the real
 * lifecycle.
 *
 * It records every raw-mode change so restoration can be proved, tracks which
 * listeners are attached so removal can be proved, and can be told to fail on
 * `setRawMode(true)`.
 */
class FakeTtyStream {
  constructor({ raw = false, failRawMode = false } = {}) {
    this.isTTY = true;
    this.isRaw = raw;
    this.failRawMode = failRawMode;
    this.rawModeHistory = [];
    this.listeners = new Map();
    this.paused = false;
    this.resumed = false;
  }

  setRawMode(value) {
    if (value === true && this.failRawMode) {
      throw new Error('setRawMode is not supported on this stream');
    }
    this.rawModeHistory.push(value);
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

  /** Total listeners still attached, across every event this code subscribes to. */
  totalListeners() {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  resume() {
    this.resumed = true;
    this.paused = false;
    return this;
  }

  pause() {
    this.paused = true;
    return this;
  }

  /** Deliver a chunk, exactly as a terminal would. */
  emit(event, payload) {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(payload);
  }
}

/**
 * A pair of timer functions whose firing is controlled by the test.
 *
 * This is how a 180 second wait is tested in microseconds, and it lets the test prove
 * the deadline is cleared rather than merely that nothing happened to depend on it.
 */
function manualTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    /** Every timer still scheduled. Empty means nothing is left behind. */
    get pending() {
      return [...pending.values()];
    },
    fireAll() {
      for (const { fn } of [...pending.values()]) fn();
    },
  };
}

/** Wait one macrotask so promise continuations from the lifecycle have run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------------ */
/* Interactive input is required: the fail-closed gate                */
/* ------------------------------------------------------------------ */

test('a non-TTY stream is refused immediately, before any listener is attached', async () => {
  const input = new FakeTtyStream();
  input.isTTY = false;
  const timers = manualTimers();

  const outcome = await waitForManualAcknowledgement({
    input,
    timeoutMs: 180000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  assert.equal(outcome, 'input_unavailable');
  assert.equal(input.totalListeners(), 0, 'no listener may be attached to a pipe');
  assert.equal(timers.pending.length, 0, 'no deadline may be armed for a pipe');
});

test('a piped newline cannot acknowledge the inspection', async () => {
  // The defect, stated directly. `classifyTerminalInput` says a newline is an
  // acknowledgement; the lifecycle must still refuse because the source is a pipe.
  assert.equal(classifyTerminalInput(Buffer.from('\n')), 'acknowledged');

  const piped = new FakeTtyStream();
  piped.isTTY = false;

  const outcome = await waitForManualAcknowledgement({ input: piped, timeoutMs: 180000 });

  assert.notEqual(outcome, 'acknowledged');
  assert.equal(outcome, 'input_unavailable');
});

test('arbitrary machine input cannot acknowledge', async () => {
  for (const payload of ['yes\n', '1\n', 'PASS\n', 'ok\r\n']) {
    const piped = new FakeTtyStream();
    piped.isTTY = false;
    const outcome = await waitForManualAcknowledgement({ input: piped, timeoutMs: 1000 });
    assert.equal(outcome, 'input_unavailable', `${JSON.stringify(payload)} must not acknowledge`);
  }
});

test('a missing stream is refused', async () => {
  assert.equal(await waitForManualAcknowledgement({ input: null, timeoutMs: 1000 }), 'input_unavailable');
  assert.equal(await waitForManualAcknowledgement({ input: undefined, timeoutMs: 1000 }), 'input_unavailable');
});

test('a TTY without setRawMode is refused rather than read as cooked input', async () => {
  // A terminal-looking stream that offers no raw mode has no way to deliver a
  // single keypress. Reading it as cooked would accept line-buffered input.
  const input = new FakeTtyStream();
  input.setRawMode = undefined;

  const outcome = await waitForManualAcknowledgement({ input, timeoutMs: 1000 });
  assert.equal(outcome, 'input_unavailable');
});

/* ------------------------------------------------------------------ */
/* Raw-mode activation failure                                        */
/* ------------------------------------------------------------------ */

test('a failed setRawMode(true) fails safely and leaves nothing behind', async () => {
  const input = new FakeTtyStream({ raw: false, failRawMode: true });
  const timers = manualTimers();

  const outcome = await waitForManualAcknowledgement({
    input,
    timeoutMs: 180000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  assert.equal(outcome, 'input_unavailable', 'a failure to go raw must not succeed');
  assert.equal(input.totalListeners(), 0, 'no listener may survive a failed activation');
  assert.equal(timers.pending.length, 0, 'no deadline may survive a failed activation');
  assert.equal(input.isRaw, false, 'the stream must not be left raw');
});

test('a failed setRawMode(true) still reports without waiting for the timeout', async () => {
  // If the deadline had been armed before activation, the run would hang for the full
  // inspection period on a stream nothing can ever answer on.
  const input = new FakeTtyStream({ failRawMode: true });
  const timers = manualTimers();

  const started = Date.now();
  const outcome = await waitForManualAcknowledgement({
    input,
    timeoutMs: 180000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  assert.equal(outcome, 'input_unavailable');
  assert.ok(Date.now() - started < 1000, 'it must return at once, not after the deadline');
});

/* ------------------------------------------------------------------ */
/* Enter acknowledges, and restores the prior mode                    */
/* ------------------------------------------------------------------ */

test('starting in cooked mode, Enter acknowledges and cooked mode is restored', async () => {
  const input = new FakeTtyStream({ raw: false });
  const timers = manualTimers();

  const waiting = waitForManualAcknowledgement({
    input,
    timeoutMs: 180000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  assert.equal(input.isRaw, true, 'raw mode is enabled while waiting');
  input.emit('data', Buffer.from('\r'));
  const outcome = await waiting;

  assert.equal(outcome, 'acknowledged');
  assert.equal(input.isRaw, false, 'cooked mode must be restored');
  assert.deepEqual(input.rawModeHistory, [true, false], 'enabled once, restored once');
});

test('starting in raw mode, Enter acknowledges and raw mode is restored', async () => {
  // The old code called setRawMode(false) unconditionally, silently changing a
  // configuration its caller owned.
  const input = new FakeTtyStream({ raw: true });
  const timers = manualTimers();

  const waiting = waitForManualAcknowledgement({
    input,
    timeoutMs: 180000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  input.emit('data', Buffer.from('\r'));
  const outcome = await waiting;

  assert.equal(outcome, 'acknowledged');
  assert.equal(input.isRaw, true, 'the stream was raw before and must still be raw');
  assert.deepEqual(input.rawModeHistory, [true, true]);
});

test('LF also acknowledges', async () => {
  const input = new FakeTtyStream();
  const waiting = waitForManualAcknowledgement({ input, timeoutMs: 180000 });
  input.emit('data', Buffer.from('\n'));
  assert.equal(await waiting, 'acknowledged');
});

/* ------------------------------------------------------------------ */
/* Ordinary keys are ignored, and the wait continues                  */
/* ------------------------------------------------------------------ */

test('ordinary characters do not acknowledge and the wait stays armed', async () => {
  const input = new FakeTtyStream();
  const timers = manualTimers();

  const waiting = waitForManualAcknowledgement({
    input,
    timeoutMs: 180000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  input.emit('data', Buffer.from('x'));
  await settle();

  // Still waiting: a keystroke proves nothing about whether the dialog was checked.
  assert.equal(timers.pending.length, 1, 'the deadline must still be armed');
  assert.equal(input.totalListeners(), 4, 'listeners must still be attached');

  input.emit('data', Buffer.from('\r'));
  assert.equal(await waiting, 'acknowledged');
});

test('several characters followed by Enter acknowledge', async () => {
  const input = new FakeTtyStream();
  const waiting = waitForManualAcknowledgement({ input, timeoutMs: 180000 });
  input.emit('data', Buffer.from('typed ahead\r'));
  assert.equal(await waiting, 'acknowledged');
});

/* ------------------------------------------------------------------ */
/* Ctrl+C cancels, immediately and not as a timeout                   */
/* ------------------------------------------------------------------ */

test('Ctrl+C cancels', async () => {
  const input = new FakeTtyStream();
  const timers = manualTimers();

  const waiting = waitForManualAcknowledgement({
    input,
    timeoutMs: 180000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  input.emit('data', Buffer.from([0x03]));
  const outcome = await waiting;

  assert.equal(outcome, 'cancelled');
  assert.notEqual(outcome, 'timed_out', 'a stop must never be reported as a timeout');
  assert.equal(timers.pending.length, 0, 'the deadline must be cleared on cancellation');
});

test('Ctrl+C takes precedence over Enter in the same chunk', async () => {
  for (const chunk of [Buffer.from([0x0a, 0x03]), Buffer.from([0x03, 0x0a]), Buffer.from('abc\r\u0003')]) {
    const input = new FakeTtyStream();
    const waiting = waitForManualAcknowledgement({ input, timeoutMs: 180000 });
    input.emit('data', chunk);
    assert.equal(await waiting, 'cancelled', `${chunk.toString('hex')} must cancel`);
  }
});

/* ------------------------------------------------------------------ */
/* Timeout, EOF and error                                             */
/* ------------------------------------------------------------------ */

test('the deadline returning timed_out', async () => {
  const input = new FakeTtyStream();
  const timers = manualTimers();

  const waiting = waitForManualAcknowledgement({
    input,
    timeoutMs: 180000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].ms, 180000, 'the full configured period must be used');

  timers.fireAll();
  assert.equal(await waiting, 'timed_out');
  assert.equal(input.totalListeners(), 0, 'listeners are removed on timeout');
  assert.equal(input.isRaw, false, 'raw mode is restored on timeout');
});

test('end of input reports input_unavailable, not a timeout', async () => {
  const input = new FakeTtyStream();
  const timers = manualTimers();

  const waiting = waitForManualAcknowledgement({
    input,
    timeoutMs: 180000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  input.emit('end');
  const outcome = await waiting;

  assert.equal(outcome, 'input_unavailable');
  assert.equal(timers.pending.length, 0);
  assert.equal(input.totalListeners(), 0);
});

test('close and error also report input_unavailable', async () => {
  for (const event of ['close', 'error']) {
    const input = new FakeTtyStream();
    const waiting = waitForManualAcknowledgement({ input, timeoutMs: 180000 });
    input.emit(event, new Error('stream failed'));
    assert.equal(await waiting, 'input_unavailable', `${event} must end the wait safely`);
    assert.equal(input.totalListeners(), 0, `${event} must remove listeners`);
  }
});

/* ------------------------------------------------------------------ */
/* Cleanup holds for every outcome                                    */
/* ------------------------------------------------------------------ */

test('every outcome removes all listeners and clears the deadline', async () => {
  const scenarios = [
    { name: 'acknowledged', drive: (i, t) => i.emit('data', Buffer.from('\r')), expected: 'acknowledged' },
    { name: 'cancelled', drive: (i) => i.emit('data', Buffer.from([0x03])), expected: 'cancelled' },
    { name: 'timed_out', drive: (i, t) => t.fireAll(), expected: 'timed_out' },
    { name: 'input_unavailable', drive: (i) => i.emit('end'), expected: 'input_unavailable' },
  ];

  for (const { name, drive, expected } of scenarios) {
    const input = new FakeTtyStream();
    const timers = manualTimers();
    const waiting = waitForManualAcknowledgement({
      input,
      timeoutMs: 180000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    drive(input, timers);
    assert.equal(await waiting, expected, name);
    assert.equal(input.totalListeners(), 0, `${name}: no listener may remain`);
    assert.equal(timers.pending.length, 0, `${name}: no timer may remain`);
    assert.equal(input.isRaw, false, `${name}: raw mode must be restored`);
  }
});

test('no later input can affect a completed wait', async () => {
  const input = new FakeTtyStream();
  const timers = manualTimers();

  const waiting = waitForManualAcknowledgement({
    input,
    timeoutMs: 180000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  input.emit('data', Buffer.from('\r'));
  assert.equal(await waiting, 'acknowledged');

  // Everything that could arrive afterwards must reach nothing at all.
  assert.doesNotThrow(() => {
    input.emit('data', Buffer.from([0x03]));
    input.emit('data', Buffer.from('\r'));
    input.emit('end');
    input.emit('error', new Error('late'));
  });
  assert.equal(input.totalListeners(), 0);
});

test('repeated events cannot settle the same wait twice', async () => {
  const input = new FakeTtyStream();
  const timers = manualTimers();
  const outcomes = [];

  const waiting = waitForManualAcknowledgement({
    input,
    timeoutMs: 180000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  waiting.then((outcome) => outcomes.push(outcome));

  // A real stream can deliver several of these; only the first may count.
  input.emit('data', Buffer.from('\r'));
  input.emit('data', Buffer.from([0x03]));
  input.emit('end');
  input.emit('close');
  timers.fireAll();

  await settle();
  assert.deepEqual(outcomes, ['acknowledged'], 'exactly one outcome, the first');
});

/* ------------------------------------------------------------------ */
/* What these tests do and do not prove                               */
/* ------------------------------------------------------------------ */

test('the fake stream is not an operating-system terminal', () => {
  // Recorded deliberately, so nobody mistakes this suite for proof that a real
  // terminal behaves this way. A `FakeTtyStream` with `isTTY = true` is a plain object
  // that imitates the parts of the contract this code depends on: the `isTTY` flag,
  // `isRaw`, `setRawMode`, and the event methods. It is not a pty, has no kernel line
  // discipline, and cannot show what Enter actually sends, whether SIGINT is
  // intercepted by the terminal driver, or whether the operating system restores
  // terminal settings after the process exits.
  //
  // The interactive path is therefore verified by running the headed script in a real
  // terminal, which the README describes. These tests pin the logic that a real
  // terminal drives; they do not stand in for the terminal itself.
  const fake = new FakeTtyStream();
  assert.equal(fake.isTTY, true);
  assert.equal(typeof fake.setRawMode, 'function');
  assert.equal(Object.getPrototypeOf(fake), FakeTtyStream.prototype);
});
