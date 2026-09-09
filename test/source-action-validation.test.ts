import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundedTrimmedText,
  positiveInteger,
} from '../lib/source-action-validation.ts';

void test('source governance action fields share the OpenAPI integer and text bounds', () => {
  assert.equal(positiveInteger(1), 1);
  assert.equal(positiveInteger(0), null);
  assert.equal(positiveInteger(1.5), null);
  assert.equal(positiveInteger('1'), null);

  assert.equal(
    boundedTrimmedText('  valid reason  ', { minimum: 10, maximum: 20 }),
    'valid reason',
  );
  assert.equal(
    boundedTrimmedText('short', { minimum: 10, maximum: 20 }),
    null,
  );
  assert.equal(
    boundedTrimmedText('x'.repeat(21), { minimum: 10, maximum: 20 }),
    null,
  );
  assert.equal(
    boundedTrimmedText('x'.repeat(20), { minimum: 10, maximum: 20 }),
    'x'.repeat(20),
  );
  assert.equal(
    boundedTrimmedText(undefined, { minimum: 1, maximum: 500 }),
    null,
  );
});
