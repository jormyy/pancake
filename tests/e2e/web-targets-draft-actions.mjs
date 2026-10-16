import { ensureWebActionCalendar } from './web-targets-action-calendar.mjs'
import assert from 'node:assert/strict'
import { setupTradeGameplayFixture, findAvailablePlayers } from './trade-fixture.mjs'

export async function auditWebDraftActions({ check, env, season, page, press, button, open, signIn, db, wait, inspect }) {
  await check('draft-launcher-empty-and-retry', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    await signIn(fixture)
    await open('/draft')
    await page.getByText('No active draft', { exact: true }).waitFor()
    await press(button('Open Mock Rooms'))
    await page.waitForURL((url) => url.pathname === '/league' && url.searchParams.get('tab') === 'mockRooms')
    const pattern = '**/rest/v1/drafts?**'
    await page.route(pattern, (route) => {
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,OPTIONS' }
      return route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers })
        : route.fulfill({ status: 503, headers, json: { message: 'Local audit draft lookup failure' } })
    })
    try {
      await open('/draft')
      await page.getByText('Could not check draft room', { exact: true }).waitFor()
      await inspect()
    } finally { await page.unroute(pattern) }
    await press(button('Try Again'))
    await page.getByText('No active draft', { exact: true }).waitFor()
    await press(button('Back'))
    await page.waitForURL((url) => url.pathname === '/league')
    return { leagueId: fixture.league.id, emptyAction: true, failedRead: 'Simulated local 503', retryUsesLocalDatabase: true, inAppBack: true }
  })
  const run = (name, action) => check(name, async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    await ensureWebActionCalendar(fixture)
    await signIn(fixture)
    return { leagueId: fixture.league.id, ...await action(fixture) }
  })
  const confirm = async (control, confirmation) => {
    await press(button(control))
    await press(button(confirmation))
  }
  const checkPendingAdmin = async (draftId, admin) => {
    const draft = () => db(admin.from('drafts').select('status').eq('id', draftId).single())
    let pauseRequests = 0
    let release = () => {}
    const held = new Promise((resolve) => { release = () => resolve(undefined) })
    const pausePattern = `**/api/draft/${draftId}/pause`
    await page.route(pausePattern, async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      pauseRequests += 1
      await held
      await route.continue()
    })
    try {
      await confirm('Pause draft', 'Pause Draft')
      await wait(async () => pauseRequests === 1)
      for (const name of ['Pause draft', 'Reset draft', 'Stop draft']) assert.equal(await button(name).isDisabled(), true, `${name} must wait for the pending admin command`)
      assert.equal(pauseRequests, 1)
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
    await wait(async () => (await draft()).status === 'paused')
    await wait(async () => await button('Resume draft').isEnabled())
    return pauseRequests
  }
  await run('draft-admin-pending', async (fixture) => {
    const draft = await db(fixture.admin.from('drafts').insert({ league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id, draft_type: 'auction', status: 'in_progress',
      budget_per_team: 200, started_at: new Date().toISOString(), current_nomination_order: 1,
    }).select('id').single())
    const members = [fixture.proposer, fixture.recipient]
    await db(fixture.admin.from('draft_orders').insert(members.map((member, index) => ({ draft_id: draft.id, member_id: member.id, position: index + 1 }))))
    await db(fixture.admin.from('draft_budgets').insert(members.map((member) => ({ draft_id: draft.id, member_id: member.id, initial_budget: 200, remaining: 200 }))))
    await open(`/draft-room?draftId=${draft.id}`)
    const pauseRequests = await checkPendingAdmin(draft.id, fixture.admin)
    await confirm('Resume draft', 'Resume Draft')
    await wait(async () => (await db(fixture.admin.from('drafts').select('status').eq('id', draft.id).single())).status === 'in_progress')
    return { draftId: draft.id, pauseRequests, blockedConflictingControls: true, resumed: true }
  })
  await run('auction-nominate-withdraw-admin', async (fixture) => {
    await db(fixture.admin.from('leagues').update({ status: 'setup', playoff_total_weeks: 2, playoff_round_weeks: [1, 1] }).eq('id', fixture.league.id))
    await open('/league?tab=auctions')
    await press(page.getByRole('button', { name: /^Start auction draft/i }))
    await press(button('Start Auction'))
    await page.waitForURL((url) => url.pathname === '/draft-room')
    const draftId = new URL(page.url()).searchParams.get('draftId')
    assert.ok(draftId)
    const draft = () => db(fixture.admin.from('drafts').select('status,current_nomination_order,paused_at').eq('id', draftId).single())
    const room = `/draft-room?draftId=${draftId}`
    const asCommissioner = async () => { await signIn(fixture); await open(room) }
    const asNominator = async () => {
      const position = (await draft()).current_nomination_order
      const order = await db(fixture.admin.from('draft_orders').select('member_id').eq('draft_id', draftId).eq('position', position).single())
      const member = [fixture.proposer, fixture.recipient].find((member) => member.id === order.member_id)
      assert.ok(member)
      await signIn(fixture, fixture.users.findIndex((user) => user.id === member.user_id))
      await open(room)
    }
    const pauseRequests = await checkPendingAdmin(draftId, fixture.admin)
    await confirm('Resume draft', 'Resume Draft')
    await wait(async () => (await draft()).status === 'in_progress')
    const [player] = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 1, fixture.registerCreatedPlayer, { createOnly: true })
    const nominate = async () => {
      await press(button('Search and nominate a player'))
      await page.getByRole('textbox', { name: 'Search player name', exact: true }).fill(player.display_name)
      await inspect()
      await press(button(`Nominate ${player.display_name}`))
      await wait(async () => (await db(fixture.admin.from('nominations').select('id').eq('draft_id', draftId).eq('status', 'open'))).length === 1)
    }
    await asNominator()
    await press(button('Search and nominate a player'))
    await page.getByRole('textbox', { name: 'Search player name', exact: true }).fill(player.display_name)
    await inspect()
    await press(button('Cancel nomination search'))
    await nominate()
    await press(button('Withdraw nomination'))
    await wait(async () => (await db(fixture.admin.from('nominations').select('id').eq('draft_id', draftId))).length === 0)
    await nominate()
    await asCommissioner()
    await confirm('Reset draft', 'Reset Draft')
    await wait(async () => (await db(fixture.admin.from('nominations').select('id').eq('draft_id', draftId))).length === 0)
    await asNominator()
    await wait(async () => await button('Search and nominate a player').isEnabled())
    await nominate()
    const bid = page.getByRole('textbox', { name: 'Bid amount', exact: true })
    await bid.fill('5')
    await inspect()
    const nomination = await db(fixture.admin.from('nominations').select('id').eq('draft_id', draftId).eq('status', 'open').single())
    await press(button('Bid $5'))
    await wait(async () => (await db(fixture.admin.from('bids').select('id').eq('nomination_id', nomination.id).eq('amount', 5))).length === 1)
    await asCommissioner()
    await confirm('Stop draft', 'Stop Draft')
    await page.waitForURL((url) => url.pathname === '/league')
    assert.equal((await draft()).status, 'cancelled')
    assert.equal((await db(fixture.admin.from('roster_players').select('id').eq('league_id', fixture.league.id).eq('player_id', player.id))).length, 0)
    return { draftId, pauseRequests, nominated: true, withdrew: true, bidAmount: 5, reset: true, stopped: true }
  })
  await run('rookie-pick-taxi-admin', async (fixture) => {
    const rookies = await db(fixture.admin.from('players').insert(Array.from({ length: 3 }, (_, index) => ({
      first_name: 'Web Rookie', last_name: `${fixture.runId} ${index}`, years_exp: 0, nba_draft_number: index + 1,
      nba_team: 'FA', position: 'PG', eligible_positions: ['PG'], status: 'Active',
    }))).select('id,display_name'))
    rookies.forEach((rookie) => fixture.registerCreatedPlayer(rookie.id))
    await db(fixture.admin.from('draft_picks').insert([fixture.proposer, fixture.recipient].flatMap((member) =>
      [1, 2, 3].map((round) => ({ league_id: fixture.league.id, season_year: fixture.currentSeason.season_year,
        round, original_owner_id: member.id, current_owner_id: member.id })))))
    await db(fixture.admin.from('leagues').update({ status: 'offseason', taxi_slots: 2, ir_slots: 2 }).eq('id', fixture.league.id))
    await open('/league?tab=draftBoard')
    await press(page.getByRole('button', { name: /^Start rookie draft,/i }))
    await press(button('Start Rookie'))
    await page.waitForURL((url) => url.pathname === '/rookie-draft-room')
    const draftId = new URL(page.url()).searchParams.get('draftId')
    assert.ok(draftId)
    const room = `/rookie-draft-room?draftId=${draftId}`
    await open('/league?tab=draftBoard')
    await press(button('Sync traded picks'))
    await page.getByText('Pick slots updated to reflect traded picks.', { exact: true }).waitFor()
    await open(room)
    const picks = () => db(fixture.admin.from('snake_draft_picks').select('member_id,player_id,overall_pick').eq('draft_id', draftId).order('overall_pick'))
    const first = (await picks())[0]
    const index = fixture.users.findIndex((user) => user.id === [fixture.proposer, fixture.recipient].find((member) => member.id === first.member_id).user_id)
    if (index !== 0) { await signIn(fixture, index); await open(room) }
    const taxi = page.getByRole('switch', { name: 'Draft this pick directly into taxi', exact: true })
    await press(taxi)
    await page.getByRole('textbox', { name: 'Search prospects', exact: true }).fill(rookies[0].display_name)
    await inspect()
    await press(button(`Pick ${rookies[0].display_name}`))
    const roster = () => db(fixture.admin.from('roster_players').select('id,is_on_taxi').eq('league_id', fixture.league.id).eq('player_id', rookies[0].id))
    await wait(async () => (await roster())[0]?.is_on_taxi === true)
    if (index !== 0) { await signIn(fixture); await open(room) }
    await confirm('Pause draft', 'Pause Draft')
    await wait(async () => (await db(fixture.admin.from('drafts').select('status').eq('id', draftId).single())).status === 'paused')
    await confirm('Resume draft', 'Resume Draft')
    await wait(async () => (await db(fixture.admin.from('drafts').select('status').eq('id', draftId).single())).status === 'in_progress')
    await confirm('Reset draft', 'Reset Draft')
    await wait(async () => (await roster()).length === 0 && (await picks()).every((pick) => pick.player_id === null))
    await db(fixture.admin.from('drafts').update({ timer_expiry_behavior: 'commissioner_pick' }).eq('id', draftId))
    await db(fixture.admin.from('snake_draft_picks').update({ timer_expires_at: new Date(Date.now() - 1000).toISOString() }).eq('draft_id', draftId).eq('overall_pick', 1))
    await db(fixture.admin.rpc('process_expired_snake_pick_atomic', { p_draft_id: draftId }))
    await page.reload({ waitUntil: 'load' })
    await page.getByText('Commissioner Pick Needed', { exact: true }).waitFor()
    const choice = page.getByRole('switch', { name: 'Draft this pick directly into taxi', exact: true })
    if (await choice.isChecked()) await press(choice)
    assert.equal(await choice.isChecked(), false)
    await press(choice)
    assert.equal(await choice.isChecked(), true)
    await page.getByRole('textbox', { name: 'Search prospects', exact: true }).fill(rookies[1].display_name)
    await press(button(`Commish Pick ${rookies[1].display_name}`))
    await wait(async () => (await picks())[0]?.player_id === rookies[1].id)
    const acquired = await db(fixture.admin.from('roster_players').select('is_on_taxi').eq('league_id', fixture.league.id).eq('player_id', rookies[1].id).single())
    assert.equal(acquired.is_on_taxi, true)
    await confirm('Stop draft', 'Stop Draft')
    await page.waitForURL((url) => url.pathname === '/league')
    assert.equal((await db(fixture.admin.from('drafts').select('status').eq('id', draftId).single())).status, 'cancelled')
    assert.equal((await db(fixture.admin.from('roster_players').select('id').eq('league_id', fixture.league.id).eq('player_id', rookies[1].id))).length, 1)
    const beneficiary = (await picks())[0].member_id
    const owner = [fixture.proposer, fixture.recipient].find((member) => member.id === beneficiary)
    await db(fixture.admin.from('players').update({ injury_status: 'Out' }).eq('id', rookies[1].id))
    await signIn(fixture, fixture.users.findIndex((user) => user.id === owner.user_id))
    await open('/roster')
    const playerName = rookies[1].display_name
    const row = () => db(fixture.admin.from('roster_players').select('id,is_on_ir,is_on_taxi').eq('league_id', fixture.league.id).eq('player_id', rookies[1].id).maybeSingle())
    await press(button(`Activate ${playerName}`))
    await press(button('Confirm'))
    await wait(async () => (await row())?.is_on_taxi === false)
    await press(button(`Open ${playerName}`))
    await press(button('Move to IR'))
    await press(button('Confirm'))
    await wait(async () => (await row())?.is_on_ir === true)
    await press(button(`Open ${playerName}`))
    await press(button('Activate from IR'))
    await press(button('Confirm'))
    await wait(async () => (await row())?.is_on_ir === false)
    await press(button(`Open ${playerName}`))
    await inspect()
    await press(button(`Drop ${playerName}`))
    await press(button('Drop'))
    await wait(async () => await row() === null)
    const wire = await db(fixture.admin.from('waiver_wire_log').select('clears_at').eq('league_id', fixture.league.id).eq('player_id', rookies[1].id).single())
    assert.ok(Date.parse(wire.clears_at) > Date.now() + 47 * 60 * 60 * 1000)
    return { draftId, taxiPick: rookies[0].id, commissionerPick: rookies[1].id, resetClearsPick: true,
      stoppedKeepsPick: true, taxiActivated: true, irMovedAndActivated: true, droppedToWaivers: true }
  })
}
