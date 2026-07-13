const assert = require('node:assert/strict');
const test = require('node:test');

const { safeOutputExcerpt } = require('../out/safeOutput.js');

test('redacts named credentials and common authorization tokens', () => {
  const excerpt = safeOutputExcerpt([
    '{"clientKey":"EXAMPLE_CLIENT","secretKey":"EXAMPLE_SECRET"}',
    'Authorization: Bearer example-bearer-value',
    'password=example-password',
  ].join('\n'));

  assert.doesNotMatch(excerpt.text, /EXAMPLE_CLIENT|EXAMPLE_SECRET|example-bearer-value|example-password/);
  assert.match(excerpt.text, /"clientKey":"<REDACTED>"/);
  assert.match(excerpt.text, /Authorization: <REDACTED>/);
  assert.equal(excerpt.truncated, false);
});

test('truncates output only after redaction', () => {
  const secret = 'S'.repeat(80);
  const excerpt = safeOutputExcerpt(`secretKey=${secret}\n${'word '.repeat(100)}`, 32);

  assert.doesNotMatch(excerpt.text, new RegExp(secret));
  assert.equal(excerpt.text.length, 32);
  assert.equal(excerpt.truncated, true);
  assert.ok(excerpt.omittedCharacters > 0);
});
