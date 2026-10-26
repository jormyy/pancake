import { ensureWebActionCalendar } from './web-targets-action-calendar.mjs'
import assert from 'node:assert/strict'
import { setupTradeGameplayFixture } from './trade-fixture.mjs'
import { setupScoredPlayoffFixture } from './scored-playoff-fixture.mjs'

export async function auditWebCommissionerActions({ check, env, season, page, press, button, open, signIn, db, wait, inspect }) {
  const field = (label) => page.getByText(label, { exact: true }).locator('..').locator('input')
  const run = (name, action, beforeSeason = false) => check(name, async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    if (beforeSeason) {
      fixture.currentSeason.season_year = 2198
      await db(fixture.admin.from('league_seasons').update({ season_year: 2198 }).eq('id', fixture.currentSeason.id))
    }
    await ensureWebActionCalendar(fixture)
    await signIn(fixture)
    return { leagueId: fixture.league.id, ...await action(fixture) }
  })
  await run('manager-settings-authorization', async (fixture) => {
    const before = await db(fixture.admin.from('leagues').select('name,auction_budget,scoring_settings').eq('id', fixture.league.id).single())
    await signIn(fixture, 1)
    await open('/commissioner-settings')
    await page.getByText('Only league commissioners can manage these settings.', { exact: true }).waitFor()
    assert.equal(await button('Save league settings').count(), 0)
    const rejection = await page.evaluate(async ({ url, key, leagueId }) => {
      const session = JSON.parse(localStorage.getItem(`sb-${new URL(url).hostname.split('.')[0]}-auth-token`))
      const response = await fetch(`${url}/rest/v1/rpc/update_league_configuration_atomic`, {
        method: 'POST', headers: { apikey: key, authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ p_league_id: leagueId, p_settings: { auction_budget: 999 }, p_slots: null }),
      })
      return { status: response.status, body: await response.json() }
    }, { url: env.supabaseUrl, key: env.anonKey, leagueId: fixture.league.id })
    assert.ok(rejection.status >= 400)
    assert.match(rejection.body.message, /commissioner|permission|authorized/i)
    const after = await db(fixture.admin.from('leagues').select('name,auction_budget,scoring_settings').eq('id', fixture.league.id).single())
    assert.deepEqual(after, before)
    return { managerControlsHidden: true, forgedStatus: rejection.status, forgedMessage: rejection.body.message, settingsUnchanged: true }
  })
  await run('commissioner-save-and-overrides', async (fixture) => {
    await db(fixture.admin.from('leagues').update({ status: 'setup' }).eq('id', fixture.league.id))
    await open('/commissioner-settings')
    await wait(async () => await button('Save league settings').isEnabled())
    for (const [label, value] of [
      ['Points', '2'], ['Active Roster Size', '21'], ['IR Slots', '3'], ['Taxi Squad Slots', '4'],
      ['Auction Budget ($)', '250'], ['Weekly Add Limit (0 = unlimited)', '9'], ['FAAB Starting Budget', '120'],
      ['Veto Window Hours', '12'], ['Member Threshold %', '60'],
    ]) await field(label).fill(value)
    await press(button('Increase BE slots'))
    await press(page.getByText('Rolling', { exact: true }))
    await press(page.getByText('Commish', { exact: true }))
    await page.getByRole('textbox', { name: 'Trade deadline, month and day', exact: true }).fill('03/01')
    await inspect()
    await press(button('Save league settings'))
    const saved = await db(fixture.admin.from('leagues').select('*').eq('id', fixture.league.id).single())
    for (const [key, value] of Object.entries({ roster_size: 21, ir_slots: 3, taxi_slots: 4, auction_budget: 250,
      weekly_add_limit: 9, faab_starting_budget: 120, waiver_mode: 'rolling', trade_veto_mode: 'commissioner',
      trade_veto_window_hours: 12, trade_veto_threshold_percent: 60 })) assert.equal(saved[key], value, key)
    assert.equal(saved.scoring_settings.points, 2)
    await page.waitForURL((url) => url.pathname === '/league')
    await open('/commissioner-settings')
    await wait(async () => await button('Save league settings').isEnabled())
    await press(page.getByText('FAAB', { exact: true }))
    await press(page.getByText('Veto Mode', { exact: true }).locator('..').getByText('Off', { exact: true }))
    await press(button('Save league settings'))
    await page.waitForURL((url) => url.pathname === '/league')
    const modes = await db(fixture.admin.from('leagues').select('waiver_mode,trade_veto_mode').eq('id', fixture.league.id).single())
    assert.deepEqual(modes, { waiver_mode: 'faab', trade_veto_mode: 'disabled' })
    await open('/commissioner-settings')
    await page.getByPlaceholder('FAAB balance').fill('123')
    await press(page.getByText('Set FAAB', { exact: true }))
    await wait(async () => (await db(fixture.admin.from('faab_balances').select('balance').eq('league_id', fixture.league.id).eq('member_id', fixture.proposer.id).maybeSingle()))?.balance === 123)
    await page.getByPlaceholder('Weekly adds used').fill('2')
    await press(page.getByText('Set Adds', { exact: true }))
    await wait(async () => (await db(fixture.admin.from('weekly_add_counts').select('add_count').eq('league_id', fixture.league.id).eq('member_id', fixture.proposer.id))).some((row) => row.add_count === 2))
    return { settingsPersisted: true, waiverModes: ['rolling', 'faab'], vetoModes: ['commissioner', 'disabled'], faab: 123, weeklyAdds: 2 }
  })
  await run('commissioner-schedule-and-access-errors', async (fixture) => {
    await open('/commissioner-settings')
    await press(page.getByRole('button', { name: /^Generate Season Schedule/ }))
    const rows = () => db(fixture.admin.from('matchups').select('id').eq('league_id', fixture.league.id))
    await wait(async () => (await rows()).length > 0)
    const original = new Set((await rows()).map((row) => row.id))
    await press(page.getByRole('button', { name: /^Reset & Regenerate Schedule/ }))
    await press(button('Reset'))
    await wait(async () => (await rows()).length === original.size && (await rows()).every((row) => !original.has(row.id)))
    const errors = []
    for (const [label, endpoint] of [['Process Waiver Claims', '/waivers/process'], ['Sync Player Stats', '/sync/stats'], ['Sync Scores Now', '/sync/scores'], ['Sync Dynasty Rankings', '/sync/rankings'], ['Sync Projections', '/sync/projections'], ['Sync NBA Game Schedule', '/sync/schedule']]) {
      assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0, 'Global maintenance controls are not commissioner actions')
      const receipt = await page.evaluate(async ({ url, supabaseUrl, key, leagueId }) => {
        const session = JSON.parse(localStorage.getItem(`sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`))
        const response = await fetch(url, { method: 'POST',
          headers: { apikey: key, authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ leagueId }),
        })
        return { status: response.status, body: await response.json() }
      }, { url: `${env.apiBaseUrl}${endpoint}`, supabaseUrl: env.supabaseUrl, key: env.anonKey, leagueId: fixture.league.id })
      assert.ok([403, 503].includes(receipt.status), `${label}: local admin allowlist must gate this action`)
      assert.match(receipt.body.error ?? receipt.body.message ?? '', /Admin access (?:not configured|required)|Internal server error/i)
      errors.push({ label, status: receipt.status, controlsAbsent: true, forgedRequestRejected: true })
    }
    return { scheduleRows: (await rows()).length, regenerated: true, adminGate: errors,
      limitation: 'Global sync happy paths need a local admin allowlist and controlled provider responses. These checks prove hidden controls and denied forged requests.' }
  }, true)
  await run('commissioner-utility-success-feedback', async () => {
    await open('/commissioner-settings')
    const operations = []
    for (const [label, endpoint] of [['Process Waiver Claims', '/waivers/process'], ['Sync Player Stats', '/sync/stats'], ['Sync Scores Now', '/sync/scores'], ['Sync Dynasty Rankings', '/sync/rankings'], ['Sync Projections', '/sync/projections'], ['Sync NBA Game Schedule', '/sync/schedule']]) {
      let release = () => {}
      const held = new Promise((resolve) => { release = () => resolve(undefined) })
      const pattern = `**/api${endpoint}`
      let requests = 0
      await page.context().route(pattern, async (route) => {
        const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,OPTIONS' }
        if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return }
        requests += 1
        await held
        await route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
      })
      try {
        await press(button(label))
        await wait(async () => requests === 1)
        assert.equal(await button(label).isDisabled(), true)
      } finally { release(); await page.context().unrouteAll({ behavior: 'wait' }) }
      await page.getByText('Done', { exact: true }).last().waitFor()
      await press(button('Dismiss').last())
      await wait(async () => await button(label).isEnabled())
      operations.push({ label, requests, simulatedSuccess: true, disabledWhilePending: true, recovered: true })
    }
    return { operations, limitation: 'Success responses are simulated. The real local API denies these global operations without an admin allowlist. External provider jobs and global sync writes are not exercised here.' }
  })
  await check('commissioner-playoffs-rollover-archive', async () => {
    const fixture = await setupScoredPlayoffFixture(env, season)
    const scoring = [await fixture.scoreThrough(17)]
    await signIn(fixture)
    await open('/commissioner-settings')
    const rounds = round => db(fixture.admin.from('matchups').select('id,home_member_id,away_member_id,is_finalized,home_points,away_points,winner_member_id')
      .eq('league_season_id', fixture.currentSeason.id).eq('playoff_round', round))
    await press(page.getByRole('button', { name: /^Generate Playoff Bracket/ }))
    await wait(async () => (await rounds(1)).length === 2)
    await press(page.getByRole('button', { name: /^Advance Playoff Round/ }))
    await page.getByText(/not yet finalized|not finalized|not complete/i).last().waitFor()
    await press(button('Dismiss').last())
    assert.equal((await rounds(2)).length, 0)
    scoring.push(await fixture.scoreThrough(19))
    await press(page.getByRole('button', { name: /^Advance Playoff Round/ }))
    await wait(async () => (await rounds(2)).length === 1)
    scoring.push(await fixture.scoreThrough(21))
    const final = await rounds(2)
    assert.equal(final[0].is_finalized, true)
    await press(page.getByRole('button', { name: /^Advance to Next Season/ }))
    await press(button('Advance'))
    const current = () => db(fixture.admin.from('league_seasons').select('id,season_year').eq('league_id', fixture.league.id).eq('is_current', true).single())
    await wait(async () => (await current()).id !== fixture.currentSeason.id)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const calendarYear = Number(today.slice(0, 4)) + (Number(today.slice(5, 7)) >= 10 ? 1 : 0)
    assert.equal((await current()).season_year, Math.max(fixture.currentSeason.season_year + 1, calendarYear))
    await press(page.getByRole('button', { name: /^Archive League\./ }))
    await press(button('Archive League'))
    await wait(async () => Boolean((await db(fixture.admin.from('leagues').select('deleted_at').eq('id', fixture.league.id).single())).deleted_at))
    await wait(async () => new URL(page.url()).pathname === '/league')
    assert.deepEqual(await rounds(2), final)
    await button('Create a League').waitFor()
    await button('Join with Invite Code').waitFor()
    while (await button('Dismiss').count()) await press(button('Dismiss').last())
    return { leagueId: fixture.league.id, generated: true, prematureAdvanceBlocked: true, advanced: true, rolledOver: true, archivedWithHistory: true, emptyLeagueActionsVisible: true,
      scoring, fixture: 'Ten fictional teams, one scoring player each, four playoff teams, two weeks per round. Synthetic historical stats pass through the real scoring worker; no expected winner is written.' }
  })
}
