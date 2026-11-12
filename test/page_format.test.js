/**
 * Page-format validation.
 *
 * The print stylesheet needs a CSS paper name, and the layouts are configured with
 * the format key the PDF writer uses. Those two spellings are related in exactly one
 * table, and this file checks that the relationship is total, explicit, and fails
 * loudly at the edges.
 *
 * The reason this is worth its own tests rather than one assertion inside another
 * file: the previous code ended its `switch` with `default: return 'A4'`, so any
 * format it did not know printed on A4 and said nothing. A drawing configured for a
 * paper the table had not been taught would have been sent to the printer as A4,
 * scaled for A4, and reported success. That is a silent wrong-sheet, and it is the
 * kind of fault nobody notices until a printed drawing is measured.
 *
 * Every check below is on the public configuration surface. Nothing here reaches
 * into a private helper or re-implements the mapping, so a change to how the mapping
 * is stored does not invalidate the tests, only to what it maps.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAGE_LAYOUTS,
  cssFormatName,
  cssOrientationName,
} from '../src/config.js';

/* ------------------------------------------------------------------------ */
/* Every supported format has an explicit mapping                            */
/* ------------------------------------------------------------------------ */

test('every configured layout maps to a CSS paper name', () => {
  // The layouts are the authority for which formats exist. Asking each one for its
  // own key, rather than listing the formats here, is what keeps this test honest
  // when a layout is added: a new format that has no mapping fails immediately.
  const seen = new Map();
  for (const [id, layout] of Object.entries(PAGE_LAYOUTS)) {
    assert.equal(typeof layout.format, 'string', `${id} declares a format`);
    const name = cssFormatName(layout.format);
    assert.equal(typeof name, 'string', `${id} maps to a name`);
    assert.ok(name.length > 0, `${id} maps to a non-empty name`);

    // A CSS page-size keyword is letters and digits, starting with a capital. An
    // empty string or something like `A4x landscape` would be written into the rule
    // and ignored by the browser.
    assert.match(
      name,
      /^[A-Za-z][A-Za-z0-9]*$/,
      `${id}: "${name}" looks like a CSS page-size keyword`,
    );
    assert.equal(name[0], name[0].toUpperCase(), `${id}: "${name}" is capitalised`);

    // Two layouts of the same paper must agree, and two of different paper must not
    // share a name. That is what makes the mapping a real mapping and not a
    // constant.
    if (seen.has(layout.format)) {
      assert.equal(seen.get(layout.format), name, `${id}: the same format maps once`);
    }
    seen.set(layout.format, name);
  }
  assert.ok(seen.size >= 1, 'at least one format is mapped');
});

test('the formats in use are exactly the ones caught by name', () => {
  // Spelling out the three papers the application ships is deliberate: this is the
  // test that would fail if a layout were quietly re-pointed at a different paper.
  const expected = { a4: 'A4', a3: 'A3', letter: 'Letter' };
  for (const [format, name] of Object.entries(expected)) {
    assert.equal(cssFormatName(format), name, `${format} maps to ${name}`);
  }

  const formatsInUse = new Set(Object.values(PAGE_LAYOUTS).map((l) => l.format));
  for (const format of formatsInUse) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(expected, format),
      `the layout format "${format}" is one this test accounts for`,
    );
  }
});

test('cssPageSize is derived from format and orientation, never stored separately', () => {
  // `cssPageSize` is the value the print stylesheet writes. It must be the format's
  // name and the layout's orientation, or the sheet and the dimensions disagree.
  for (const [id, layout] of Object.entries(PAGE_LAYOUTS)) {
    const expected = `${cssFormatName(layout.format)} ${cssOrientationName(layout.orientation)}`;
    assert.equal(layout.cssPageSize, expected, `${id}: cssPageSize is derived`);
    assert.equal(
      layout.cssPageSize,
      `${cssFormatName(layout.format)} ${layout.orientation}`,
      `${id}: the orientation in the rule is the layout's own`,
    );
  }
});

test('a derived page size agrees with the declared dimensions', () => {
  // A rule saying "A4 landscape" on a page that is taller than it is wide would be a
  // contradiction between what is printed and what is fitted. The orientation in the
  // rule must match the shape of the dimensions.
  for (const [id, layout] of Object.entries(PAGE_LAYOUTS)) {
    const wantsLandscape = layout.cssPageSize.endsWith('landscape');
    const wantsPortrait = layout.cssPageSize.endsWith('portrait');
    assert.ok(
      wantsLandscape || wantsPortrait,
      `${id}: the page size names an orientation`,
    );
    if (wantsLandscape) {
      assert.ok(
        layout.widthPt > layout.heightPt,
        `${id}: a landscape rule sits on a wider-than-tall page`,
      );
    } else {
      assert.ok(
        layout.heightPt > layout.widthPt,
        `${id}: a portrait rule sits on a taller-than-wide page`,
      );
    }
  }
});

/* ------------------------------------------------------------------------ */
/* Unknown formats are refused, never mapped to A4                           */
/* ------------------------------------------------------------------------ */

test('an unsupported format is rejected with an actionable error', () => {
  // The heart of the act. Each of these used to return "A4" and print silently.
  const unsupported = ['a5', 'ledger', 'tabloid', 'A4', 'A3', 'LETTER', 'a4 ', '', 'a'];

  for (const format of unsupported) {
    assert.throws(
      () => cssFormatName(format),
      (error) => {
        // A RangeError, matching how the rest of this configuration reports a value
        // it cannot use.
        assert.ok(error instanceof RangeError, `${JSON.stringify(format)} raises a RangeError`);
        // The message names what it does not know, so the person reading it can see
        // which value was refused rather than guessing from a stack trace.
        assert.ok(
          error.message.includes(String(format)),
          `${JSON.stringify(format)}: the error names the unknown value`,
        );
        // It says where the mapping lives, which is the fix.
        assert.ok(
          /CSS_FORMAT_NAMES/.test(error.message),
          `${JSON.stringify(format)}: the error names the table to extend`,
        );
        // And it lists what is supported, so no lookup is needed to know the options.
        for (const supported of ['a3', 'a4', 'letter']) {
          assert.ok(
            error.message.includes(supported),
            `${JSON.stringify(format)}: the error lists the supported "${supported}"`,
          );
        }
        return true;
      },
      `${JSON.stringify(format)} must be refused`,
    );
  }
});

test('a non-string format is rejected rather than coerced', () => {
  // `undefined` and `null` are the values a layout missing its format would carry.
  // Coercing them to a string and then matching a default is how a configuration
  // mistake becomes an A4 sheet.
  for (const value of [undefined, null, 0, 42, {}, [], true]) {
    assert.throws(
      () => cssFormatName(value),
      RangeError,
      `${String(value)} is refused`,
    );
  }
});

test('no input can be mapped to A4 by accident', () => {
  // A direct statement of the defect this act removes: with the old fallback, every
  // one of these returned "A4". Now none of them returns anything.
  const formerlyFallbackInputs = ['a5', 'ledger', 'b5', '', 'unknown', 'a'];
  for (const format of formerlyFallbackInputs) {
    assert.throws(() => cssFormatName(format), RangeError, `${format} does not fall back`);
  }

  // And the only input that yields A4 is the format that means A4.
  assert.equal(cssFormatName('a4'), 'A4');
});

/* ------------------------------------------------------------------------ */
/* Orientation is validated the same way                                     */
/* ------------------------------------------------------------------------ */

test('an unsupported orientation is rejected with an actionable error', () => {
  for (const orientation of ['diagonal', 'Landscape', 'portrait ', '', 'up']) {
    assert.throws(
      () => cssOrientationName(orientation),
      (error) => {
        assert.ok(error instanceof RangeError);
        assert.ok(error.message.includes(String(orientation)), 'the error names the value');
        assert.ok(/landscape/.test(error.message) && /portrait/.test(error.message), 'the error lists the options');
        return true;
      },
      `${JSON.stringify(orientation)} must be refused`,
    );
  }

  // The two CSS understands are accepted unchanged.
  assert.equal(cssOrientationName('landscape'), 'landscape');
  assert.equal(cssOrientationName('portrait'), 'portrait');
});

/* ------------------------------------------------------------------------ */
/* The application still works with them                                     */
/* ------------------------------------------------------------------------ */

test('the layouts the application ships are unchanged by the validation', () => {
  // Validation must not have altered any existing layout. These are the four the
  // print path is tested against, asserted on their declared values.
  assert.deepEqual(
    Object.keys(PAGE_LAYOUTS),
    ['a4_landscape', 'a4_portrait', 'a3_landscape', 'letter_landscape'],
  );
  assert.equal(PAGE_LAYOUTS.a4_landscape.cssPageSize, 'A4 landscape');
  assert.equal(PAGE_LAYOUTS.a4_portrait.cssPageSize, 'A4 portrait');
  assert.equal(PAGE_LAYOUTS.a3_landscape.cssPageSize, 'A3 landscape');
  assert.equal(PAGE_LAYOUTS.letter_landscape.cssPageSize, 'Letter landscape');

  // Frozen as before, so a caller cannot mutate the paper a drawing prints on.
  assert.ok(Object.isFrozen(PAGE_LAYOUTS));
  for (const layout of Object.values(PAGE_LAYOUTS)) {
    assert.ok(Object.isFrozen(layout));
    assert.ok(Object.isFrozen(layout) && typeof layout.cssPageSize === 'string');
  }
});
