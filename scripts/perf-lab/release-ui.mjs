import assert from 'node:assert/strict'

async function dailyBand(page) {
  const band = page.getByTestId('matchup-daily-total').filter({ visible: true }).last()
  assert.equal(await band.count(), 1, 'Daily Total is visible')
  const position = await band.evaluate(element => ({
    starters: element.parentElement.textContent.includes('Starters'),
    bench: element.parentElement.nextElementSibling?.textContent.includes('Bench'),
    last: element === element.parentElement.lastElementChild,
  }))
  assert.deepEqual(position, { starters: true, bench: true, last: true }, 'Daily Total separates starters and bench')
  for (const side of ['left', 'right']) assert.match(await band.getByTestId(`matchup-daily-total-${side}`).innerText(), /^(?:—|-?\d+\.\d)$/)
}

async function matchupNavigation(page, teamName, navigate) {
  const strip = () => page.getByTestId('other-matchups').filter({ visible: true }).last()
  const card = () => page.getByTestId('matchup-score-card').filter({ visible: true }).last()
  const labels = await strip().getByRole('button').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
  assert.ok(labels.length > 1 && labels[0].includes(teamName), 'Own matchup is first')
  const initial = await strip().locator('[aria-current="true"]').getAttribute('aria-label')
  const selectedDay = await card().locator('..').locator('[aria-current="date"]').getAttribute('aria-label')
  for (const label of ['Previous matchup', 'Next matchup']) {
    const box = await card().getByRole('button', { name: label, exact: true }).boundingBox()
    assert.ok(box && box.width >= 44 && box.height >= 44, 'Matchup arrows have a full touch target')
  }
  if (!navigate) return { choices: labels.length, navigated: false }
  const wait = async label => {
    await page.waitForFunction(expected => [...document.querySelectorAll('[data-testid="other-matchups"] [aria-current="true"]')].at(-1)?.getAttribute('aria-label') === expected, label)
    await dailyBand(page)
    assert.equal(await card().locator('..').locator('[aria-current="date"]').getAttribute('aria-label'), selectedDay, 'Navigation preserves the selected day')
    assert.equal(await strip().getByRole('button').first().getAttribute('aria-label'), labels[0])
  }
  await strip().getByRole('button', { name: labels[0], exact: true }).click()
  await wait(labels[0])
  await card().getByRole('button', { name: 'Previous matchup', exact: true }).click()
  await wait(labels.at(-1))
  await card().getByRole('button', { name: 'Next matchup', exact: true }).click()
  await wait(labels[0])
  await card().getByRole('button', { name: 'Next matchup', exact: true }).click()
  await wait(labels[1])
  await strip().getByRole('button', { name: initial, exact: true }).click()
  await wait(initial)
  return { choices: labels.length, navigated: true, wrapped: true, selectedDay }
}

export async function verifyReleaseUi(page, surface, variables) {
  if (['matchup-home', 'other-matchup'].includes(surface.id)) {
    await dailyBand(page)
    return { dailyTotal: true, ...await matchupNavigation(page, variables.teamName, surface.id === 'other-matchup') }
  }
  if (surface.id === 'lineup-editor') {
    const controls = page.getByLabel('Auto lineup', { exact: true })
    await controls.getByRole('switch', { name: 'Keep lineup updated automatically', exact: true }).waitFor()
    for (const name of ['Today', 'This week', 'ROS']) assert.equal(await controls.getByText(name, { exact: true }).count(), 0)
    return { selectedDayControls: true }
  }
  if (surface.id === 'roster') {
    await page.getByRole('button', { name: 'Open auto-set lineup options', exact: true }).click()
    const modal = page.getByRole('dialog', { name: 'Auto-set lineup', exact: true })
    await modal.getByRole('button', { name: 'Edit lineup manually', exact: true }).waitFor()
    for (const name of ['Today', 'This week', 'ROS']) assert.equal(await modal.getByText(name, { exact: true }).count(), 0)
    await modal.getByRole('button', { name: 'Close', exact: true }).click()
    return { rosterAutoSet: true }
  }
  if (surface.id === 'league-dashboard.schedule') {
    const schedule = page.getByRole('list', { name: 'Your season schedule', exact: true })
    assert.ok(await schedule.getByRole('listitem').count() > 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    return { scheduleRows: await schedule.getByRole('listitem').count() }
  }
  return null
}
