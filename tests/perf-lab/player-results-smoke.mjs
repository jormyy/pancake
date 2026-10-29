import assert from 'node:assert/strict'
import { webkit } from 'playwright'
import { playerViewReady } from '../../scripts/perf-lab/player-results.mjs'
import { expectContent } from '../../scripts/perf-lab/actions.mjs'

const browser = await webkit.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await page.route('http://127.0.0.1:57295/**', route => route.fulfill({ contentType: 'text/html', body: '<main id="players-section-panel"></main>' }))
  await page.goto('http://127.0.0.1:57295/fixture')
  const contract = { memberId: 'member', leagueId: 'league', params: { position: 'PG', query: '' } }
  const show = async (visible, stored, offset = 0, position = 'PG') => page.evaluate(({ visible, stored, offset, position, contract }) => {
    localStorage.clear()
    localStorage.setItem('pancake:screen-view:v1:fixture', JSON.stringify({
      lookupScope: { screen: 'players', ...contract, params: { ...contract.params, position, offset } },
      value: { players: stored.map(display_name => ({ display_name })) },
    }))
    document.querySelector('#players-section-panel').replaceChildren(...visible.map(name => {
      const button = document.createElement('button')
      button.setAttribute('aria-label', `Open ${name}`)
      const row = document.createElement('span')
      row.setAttribute('data-testid', 'player-row-content')
      row.textContent = name
      button.append(row)
      return button
    }))
  }, { visible, stored, offset, position, contract })
  await show(['Old center'], ['New guard'])
  assert.equal(await page.evaluate(playerViewReady, contract), false)
  await show(['New guard'], ['New guard'], 0, 'C')
  assert.equal(await page.evaluate(playerViewReady, contract), false)
  await show(['New guard'], ['New guard'])
  await expectContent(page, { playerView: contract }, page.url())
  await show(['Second guard', 'First guard'], ['First guard', 'Second guard'])
  assert.equal(await page.evaluate(playerViewReady, contract), false)
  await show(['First guard', 'Second guard'], ['First guard', 'Second guard'])
  await expectContent(page, { playerView: contract }, page.url())
  await show(['New guard'], ['New guard'], 0)
  assert.equal(await page.evaluate(playerViewReady, { ...contract, minOffset: 20 }), false)
  await show(['Next guard'], ['Next guard'], 20)
  await expectContent(page, { playerView: { ...contract, minOffset: 20 } }, page.url())
  await show([], [])
  assert.equal(await page.evaluate(playerViewReady, contract), false)
  await page.locator('#players-section-panel').evaluate(element => { element.textContent = 'No players match these filters' })
  await expectContent(page, { playerView: contract }, page.url())
  console.log(JSON.stringify({ passed: 9, failed: 0, scope: 'WebKit rendered filter, sort and pagination contracts; no application route coverage' }))
} finally { await browser.close() }
