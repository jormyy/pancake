import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publishedWeekNumber } from './calendar.mjs'

test('the All-Star calendar gap has no fantasy week and must not become week zero', () => {
  assert.equal(publishedWeekNumber(''), null)
  assert.equal(publishedWeekNumber('17'), 17)
  assert.equal(publishedWeekNumber('18'), 18)
  for (const value of ['0', '-1', '1.5', 'unknown']) assert.throws(() => publishedWeekNumber(value), /published week/)
})
