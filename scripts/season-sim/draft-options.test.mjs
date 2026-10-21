import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { rookieDraftOptions } from './draft-options.mjs'

test('the launched rookie draft never requests a timer below sixty seconds', async () => {
  const source = await readFile(new URL('./season-end.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /start-rookie[^\n]*timerSeconds:\s*(?:[0-5]?\d)\b/)
})

test('rookie requests accept both limits and refuse every shorter or longer timer', () => {
  assert.equal(rookieDraftOptions().timerSeconds, 60)
  assert.equal(rookieDraftOptions(604800).timerSeconds, 604800)
  for (const value of [0, 5, 59, 604801, 60.5, NaN]) assert.throws(() => rookieDraftOptions(value))
})
