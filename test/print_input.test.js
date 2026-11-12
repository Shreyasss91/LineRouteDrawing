/**
 * Terminal input classification for the headed print check.
 *
 * `scripts/print-dialog-smoke.mjs` waits for a person to inspect a native print
 * dialog and then press Enter. The decision of what a received chunk of bytes means
 * is a pure function, `classifyTerminalInput`, and it is the part most likely to be
 * wrong in a way nobody notices: an acknowledgement that accepts too much turns a
 * skipped inspection into a passing result.
 *
 * The defect these tests were written against: the first version called
 *
 *   finish(chunk[0] !== 0x03)
 *
 * which treated every key that was not Ctrl+C as an acknowledgement. Pressing a
 * random letter, or a stray keystroke while reaching for the mouse, reported a
 * completed manual inspection. Piped data - a script writing anything at all into
 * the process - did the same, so the check could pass without a person ever looking
 * at the dialog.
 *
 * The rules the function must obey:
 *   - Enter (LF or CR) is the only acknowledgement;
 *   - Ctrl+C is a cancellation, and wins over anything else in the same chunk;
 *   - any other byte is an ordinary key and means nothing;
 *   - a chunk may hold several bytes, so the whole chunk is examined.
 *
 * These tests need no terminal, browser or dialog, so they run in the ordinary suite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTerminalInput } from '../scripts/print-dialog-smoke.mjs';

/** Bytes for a string, matching what a stream would deliver. */
function bytes(text) {
  return Buffer.from(text, 'utf8');
}

/* ------------------------------------------------------------------------ */
/* Enter is the only acknowledgement                                         */
/* ------------------------------------------------------------------------ */

test('Enter acknowledges, as LF or as CR', () => {
  // LF is what a line-buffered pipe delivers; CR (or CRLF) is what a terminal in
  // raw mode sends when the Enter key is pressed. Both must acknowledge.
  assert.equal(classifyTerminalInput(bytes('\n')), 'acknowledged');
  assert.equal(classifyTerminalInput(bytes('\r')), 'acknowledged');
  assert.equal(classifyTerminalInput(bytes('\r\n')), 'acknowledged');
});

test('a bare Enter byte in a binary chunk acknowledges', () => {
  assert.equal(classifyTerminalInput(Buffer.from([0x0a])), 'acknowledged');
  assert.equal(classifyTerminalInput(Buffer.from([0x0d])), 'acknowledged');
});

test('ordinary keys are not acknowledgements', () => {
  // The whole point of the correction. None of these may acknowledge, however they
  // are delivered.
  for (const key of ['x', 'y', ' ', 'a', 'q', '.', '\t', '\u001b']) {
    assert.equal(
      classifyTerminalInput(bytes(key)),
      null,
      `${JSON.stringify(key)} must not acknowledge`,
    );
  }
});

test('digits and punctuation a person might type are ignored', () => {
  for (const key of ['0', '1', '9', '-', '/', '?', 'A', 'Z']) {
    assert.equal(classifyTerminalInput(bytes(key)), null, `${JSON.stringify(key)} is ignored`);
  }
});

/* ------------------------------------------------------------------------ */
/* Ctrl+C cancels                                                            */
/* ------------------------------------------------------------------------ */

test('Ctrl+C cancels', () => {
  assert.equal(classifyTerminalInput(Buffer.from([0x03])), 'cancelled');
});

test('Ctrl+C wins over an Enter in the same chunk', () => {
  // A person who types ahead and then gives up sends both at once. Stopping must not
  // be turned into a success by the presence of a newline beside it.
  assert.equal(classifyTerminalInput(Buffer.from([0x0a, 0x03])), 'cancelled');
  assert.equal(classifyTerminalInput(Buffer.from([0x03, 0x0a])), 'cancelled');
  assert.equal(classifyTerminalInput(bytes('abc\n')), 'acknowledged');
  assert.equal(classifyTerminalInput(bytes('abc\u0003')), 'cancelled');
});

/* ------------------------------------------------------------------------ */
/* A chunk may hold several bytes                                            */
/* ------------------------------------------------------------------------ */

test('several characters followed by Enter acknowledge once', () => {
  // A paste, or a terminal buffering a fast typist, delivers one chunk holding many
  // bytes. Reading only the first byte would ignore the Enter and hang the check.
  assert.equal(classifyTerminalInput(bytes('hello\n')), 'acknowledged');
  assert.equal(classifyTerminalInput(bytes('abc\r\n')), 'acknowledged');
  assert.equal(classifyTerminalInput(bytes('typed some text and pressed enter\r')), 'acknowledged');
});

test('several ordinary characters without Enter say nothing', () => {
  assert.equal(classifyTerminalInput(bytes('hello')), null);
  assert.equal(classifyTerminalInput(bytes('abc def ghi')), null);
});

test('an empty chunk says nothing', () => {
  // A zero-length read is not an acknowledgement and must not end the wait.
  assert.equal(classifyTerminalInput(Buffer.from([])), null);
  assert.equal(classifyTerminalInput(''), null);
});

/* ------------------------------------------------------------------------ */
/* The old behaviour is provably gone                                        */
/* ------------------------------------------------------------------------ */

test('no non-Enter input can acknowledge', () => {
  // A direct statement of the defect. Every byte a terminal can send, other than the
  // two that mean Enter, must classify as nothing or as a cancellation - never as an
  // acknowledgement.
  const acknowledgements = [];
  for (let byte = 0; byte <= 0xff; byte += 1) {
    if (byte === 0x0a || byte === 0x0d) continue;
    const result = classifyTerminalInput(Buffer.from([byte]));
    if (result === 'acknowledged') acknowledgements.push(byte);
  }
  assert.deepEqual(
    acknowledgements,
    [],
    `these byte values wrongly acknowledge: ${acknowledgements.map((b) => `0x${b.toString(16)}`).join(', ')}`,
  );
});

test('piped arbitrary data cannot produce an acknowledgement', () => {
  // The failure mode a machine-run check would hit: something writes into the
  // process without a newline. That must never look like a person confirming.
  for (const payload of ['garbage', 'yes', 'true', '1', 'ok', '\u0000', 'PASS']) {
    assert.equal(
      classifyTerminalInput(bytes(payload)),
      null,
      `${JSON.stringify(payload)} must not acknowledge`,
    );
  }
});
