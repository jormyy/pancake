import { reloadWebTarget } from './web-targets-browser.mjs'
import assert from 'node:assert/strict'
import { confirmTradeAcceptance } from './confirm-trade-acceptance.mjs'
import { setupTradeGameplayFixture, createFixtureResourceOwner, findAvailablePlayers } from './trade-fixture.mjs'

export async function auditWebPanelActions({ check, env, season, target, page, press, button, open, signIn, db, wait, inspect }) {
  await check('scoreboard-scheduled-live-final', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    const resources = createFixtureResourceOwner(fixture.admin)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const year = fixture.currentSeason.season_year - 1
    const weeks = await db(fixture.admin.from('season_weeks').select('week_number,week_start,week_end').eq('season_year', year))
    let week = weeks.find((row) => row.week_start <= today && row.week_end >= today)
    if (!week) {
      const start = new Date(`${today}T12:00:00Z`)
      start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7)
      const end = new Date(start)
      end.setUTCDate(end.getUTCDate() + 6)
      week = { week_number: Math.max(0, ...weeks.map((row) => row.week_number)) + 1, week_start: start.toISOString().slice(0, 10), week_end: end.toISOString().slice(0, 10) }
      await db(fixture.admin.from('season_weeks').insert({ season_year: year, ...week }))
      resources.registerCleanup('scoreboard owned week', () => db(fixture.admin.from('season_weeks').delete().eq('season_year', year).eq('week_number', week.week_number)))
    }
    await db(fixture.admin.from('league_seasons').update({ season_year: year }).eq('id', fixture.currentSeason.id))
    await db(fixture.admin.from('matchups').insert({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id,
      week_number: week.week_number, home_member_id: fixture.proposer.id, away_member_id: fixture.recipient.id }))
    const game = await db(fixture.admin.from('nba_games').insert({ nba_game_id: `002${String(year - 1).slice(-2)}${Math.floor(Math.random() * 80000 + 10000)}`,
      season_year: year, game_date: today, week_number: week.week_number, home_team: 'BOS', away_team: 'NYK',
      status: 'Scheduled', game_status_text: 'Audit scheduled', home_score: 0, away_score: 0 }).select('id').single())
    resources.registerCleanup('scoreboard owned game', async () => {
      await db(fixture.admin.from('player_game_stats').delete().eq('game_id', game.id))
      await db(fixture.admin.from('nba_games').delete().eq('id', game.id))
    })
    await signIn(fixture)
    await open('/')
    await page.getByText('Audit scheduled', { exact: true }).waitFor()
    await page.getByText('Audit scheduled', { exact: true }).scrollIntoViewIfNeeded()
    await db(fixture.admin.from('nba_games').update({ status: 'InProgress', game_status_text: 'Audit live Q3', home_score: 65, away_score: 61 }).eq('id', game.id))
    await reloadWebTarget(page)
    const live = page.getByText('Audit live Q3', { exact: true })
    await live.waitFor()
    await live.scrollIntoViewIfNeeded()
    const card = live.locator('../..')
    await card.getByText('65', { exact: true }).waitFor()
    await card.getByText('61', { exact: true }).waitFor()
    await db(fixture.admin.from('nba_games').update({ status: 'Final', game_status_text: 'Audit final', home_score: 99, away_score: 96 }).eq('id', game.id))
    await reloadWebTarget(page)
    const final = page.getByText('Audit final', { exact: true })
    await final.waitFor()
    await final.scrollIntoViewIfNeeded()
    await final.locator('../..').getByText('99', { exact: true }).waitFor()
    await final.locator('../..').getByText('96', { exact: true }).waitFor()
    return { leagueId: fixture.league.id, gameId: game.id, states: ['Scheduled', 'InProgress', 'Final'], scores: [[65, 61], [99, 96]], fixture: 'Owned synthetic game and league season; real clock, API, and database' }
  })
  await check('resolve-recovered-ir-and-full-roster-add', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    const [recovered, incoming] = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 2, fixture.registerCreatedPlayer, { createOnly: true })
    await db(fixture.admin.from('leagues').update({ roster_size: 1, ir_slots: 1, waiver_mode: 'faab', faab_starting_budget: 100 }).eq('id', fixture.league.id))
    await db(fixture.admin.from('players').update({ injury_status: 'Out' }).eq('id', recovered.id))
    await db(fixture.admin.from('roster_players').insert({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id,
      member_id: fixture.proposer.id, player_id: recovered.id, acquired_via: 'draft', is_on_ir: true }))
    await db(fixture.admin.from('players').update({ injury_status: null }).eq('id', recovered.id))
    await signIn(fixture)
    await open('/players')
    await page.getByRole('textbox', { name: 'Search players', exact: true }).fill(incoming.display_name)
    const roster = () => db(fixture.admin.from('roster_players').select('player_id,is_on_ir').eq('league_id', fixture.league.id).eq('member_id', fixture.proposer.id).order('player_id'))
    const beforeCancel = await roster()
    await press(button(`Claim ${incoming.display_name}`))
    const resolution = page.getByRole('dialog', { name: 'Resolve roster', exact: true })
    await resolution.waitFor()
    await press(resolution.getByRole('button', { name: 'Close', exact: true }))
    await resolution.waitFor({ state: 'hidden' })
    assert.deepEqual(await roster(), beforeCancel)
    await press(button(`Claim ${incoming.display_name}`))
    await press(button(`Activate ${recovered.display_name}`))
    const drop = page.getByRole('dialog', { name: 'Drop to activate', exact: true })
    await drop.waitFor()
    await inspect()
    await press(drop.getByRole('button', { name: `Drop ${fixture.proposerPlayer.display_name}`, exact: true }))
    await wait(async () => (await roster()).find((row) => row.player_id === recovered.id)?.is_on_ir === false)
    await wait(async () => !(await roster()).some((row) => row.player_id === fixture.proposerPlayer.id))
    await page.waitForURL((url) => url.pathname === '/claim-player')
    const balance = () => db(fixture.admin.from('faab_balances').select('balance').eq('member_id', fixture.proposer.id).eq('league_season_id', fixture.currentSeason.id).single())
    const claims = () => db(fixture.admin.from('waiver_claims').select('id,status,bid_amount,drop_player_id,process_date').eq('league_id', fixture.league.id).eq('player_id', incoming.id))
    const beforeRoster = await roster()
    const beforeBalance = await balance()
    assert.equal(beforeBalance.balance, 100)
    await press(button(`Select ${recovered.display_name} to drop`))
    await page.getByRole('textbox', { name: 'FAAB bid amount', exact: true }).fill('7')
    await inspect()
    await press(button('Submit waiver claim'))
    await wait(async () => (await claims()).length === 1)
    const claim = (await claims())[0]
    assert.equal(claim.status, 'pending')
    assert.equal(claim.bid_amount, 7)
    assert.equal(claim.drop_player_id, recovered.id)
    const runOffset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
      .formatToParts(new Date(`${claim.process_date}T12:00:00Z`)).find((part) => part.type === 'timeZoneName').value.replace('GMT', '')
    assert.ok(Date.parse(`${claim.process_date}T03:00:00${runOffset}`) > Date.now())
    assert.deepEqual(await roster(), beforeRoster)
    assert.deepEqual(await balance(), beforeBalance)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    assert.equal(await db(fixture.admin.rpc('count_due_waiver_claims', { p_process_date: today })), 0)
    assert.deepEqual(await db(fixture.admin.from('waiver_wire_log').select('id').neq('league_id', fixture.league.id).is('cleared_at', null).lt('clears_at', new Date().toISOString())), [])
    const processClaims = async () => {
      const response = await fetch(`${env.supabaseUrl}/functions/v1/process-waivers`, {
        method: 'POST', headers: { apikey: env.serviceRoleKey, authorization: `Bearer ${env.serviceRoleKey}`, 'x-internal-function-token': process.env.PANCAKE_EDGE_INTERNAL_TOKEN },
        signal: AbortSignal.timeout(30000),
      })
      const result = await response.json()
      assert.equal(response.status, 200, JSON.stringify(result))
      return result
    }
    await processClaims()
    assert.equal((await claims())[0].status, 'pending')
    assert.deepEqual(await roster(), beforeRoster)
    assert.deepEqual(await balance(), beforeBalance)
    const dueDate = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    await db(fixture.admin.from('waiver_claims').update({ process_date: dueDate }).eq('id', claim.id))
    assert.equal(await db(fixture.admin.rpc('count_due_waiver_claims', { p_process_date: today })), 1)
    await processClaims()
    assert.equal((await claims())[0].status, 'succeeded')
    assert.deepEqual((await roster()).map((row) => row.player_id), [incoming.id])
    assert.equal((await balance()).balance, 93)
    await processClaims()
    assert.equal((await balance()).balance, 93)
    assert.equal((await db(fixture.admin.from('roster_transactions').select('id').eq('league_id', fixture.league.id).eq('player_id', incoming.id).eq('transaction_type', 'waiver_add'))).length, 1)
    return { leagueId: fixture.league.id, cancelledWithoutMutation: true, recoveredIrActivated: true, scheduledClaim: claim.id,
      noEarlyOwnershipDropOrDebit: true, actualWorkerAward: true, repeatedWorkerDidNotDebitAgain: true,
      timingFixture: 'Only the owned claim process date moves into the past after the real worker leaves its future claim pending.' }
  })
  await check('activation-overflow-cancel-ir-and-drop', async () => {
    const outcomes = []
    for (const [source, freeAction] of [['ir', 'drop'], ['taxi', 'ir']]) {
      const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
      const [incoming] = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 1, fixture.registerCreatedPlayer, { createOnly: true })
      await db(fixture.admin.from('leagues').update({ roster_size: 1, ir_slots: 2, taxi_slots: 1 }).eq('id', fixture.league.id))
      await db(fixture.admin.from('lineup_slot_templates').delete().eq('league_id', fixture.league.id))
      await db(fixture.admin.from('lineup_slot_templates').insert({ league_id: fixture.league.id, slot_type: 'PG', slot_count: 1 }))
      await db(fixture.admin.from('players').update({ injury_status: 'Out', years_exp: 0, nba_draft_number: 1 }).in('id', [incoming.id, fixture.proposerPlayer.id]))
      if (source === 'ir') {
        await db(fixture.admin.from('roster_players').insert({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id,
          member_id: fixture.proposer.id, player_id: incoming.id, acquired_via: 'draft', is_on_ir: true }))
      } else {
        await db(fixture.admin.from('leagues').update({ status: 'offseason' }).eq('id', fixture.league.id))
        await db(fixture.admin.from('draft_picks').insert([fixture.proposer, fixture.recipient].map((member) => ({ league_id: fixture.league.id,
          season_year: fixture.currentSeason.season_year, round: 1, original_owner_id: member.id, current_owner_id: fixture.proposer.id }))))
        const draft = await db(fixture.admin.rpc('start_rookie_draft_atomic', { p_league_id: fixture.league.id, p_rounds: 1, p_pick_timer_seconds: 3600 }))
        await db(fixture.admin.rpc('make_snake_pick_atomic', { p_draft_id: draft.id, p_member_id: fixture.proposer.id, p_player_id: incoming.id, p_to_taxi: true }))
        await db(fixture.admin.rpc('stop_draft_atomic', { p_draft_id: draft.id, p_actor_user_id: fixture.users[0].id }))
        await db(fixture.admin.from('leagues').update({ status: 'active' }).eq('id', fixture.league.id))
      }
      await signIn(fixture)
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      const week = await db(fixture.admin.from('season_weeks').select('week_number').eq('season_year', fixture.currentSeason.season_year)
        .lte('week_start', today).gte('week_end', today).single())
      await db(fixture.admin.from('matchups').insert({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id,
        week_number: week.week_number, home_member_id: fixture.proposer.id, away_member_id: fixture.recipient.id }))
      await db(fixture.admin.from('players').update({ eligible_positions: ['PG'], position: 'PG' }).eq('id', fixture.recipientPlayer.id))
      await db(fixture.admin.from('weekly_lineups').insert({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id,
        member_id: fixture.recipient.id, player_id: fixture.recipientPlayer.id, week_number: week.week_number, game_date: today, slot_type: 'PG' }))
      await open('/')
      const select = () => button(`Select ${source === 'ir' ? 'IR' : 'TX'} slot, ${incoming.display_name}`)
      const show = async () => { await press(select()); await press(button('Select empty PG slot 1')) }
      const roster = () => db(fixture.admin.from('roster_players').select('player_id,is_on_ir,is_on_taxi').eq('league_id', fixture.league.id).eq('member_id', fixture.proposer.id).order('player_id'))
      const beforeCancel = await roster()
      await show()
      const dialog = page.getByRole('dialog', { name: 'Active roster full', exact: true })
      await dialog.waitFor()
      await inspect()
      await press(dialog.getByRole('button', { name: 'Cancel', exact: true }))
      await dialog.waitFor({ state: 'hidden' })
      assert.deepEqual(await roster(), beforeCancel)
      await show()
      await press(dialog.getByRole('button', { name: `${freeAction === 'ir' ? 'Move' : 'Drop'} ${fixture.proposerPlayer.display_name}${freeAction === 'ir' ? ' to IR' : ''}`, exact: true }))
      await press(button(freeAction === 'ir' ? 'Move and activate' : 'Drop and activate'))
      await dialog.waitFor({ state: 'hidden' })
      await wait(async () => (await roster()).find((row) => row.player_id === incoming.id)?.[source === 'ir' ? 'is_on_ir' : 'is_on_taxi'] === false)
      const outgoing = (await roster()).find((row) => row.player_id === fixture.proposerPlayer.id)
      if (freeAction === 'ir') assert.equal(outgoing?.is_on_ir, true)
      else assert.equal(outgoing, undefined)
      outcomes.push({ source, freeAction, cancelledWithoutMutation: true, activated: true })
    }
    return outcomes
  })
  await check('trade-block-player-pick-and-note', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true })
    const [taxiPlayer] = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 1, fixture.registerCreatedPlayer, { createOnly: true })
    await db(fixture.admin.from('players').update({ injury_status: 'Out', years_exp: 0, nba_draft_number: 1 }).eq('id', taxiPlayer.id))
    await db(fixture.admin.from('leagues').update({ status: 'offseason', taxi_slots: 1, allow_inactive_trades: true }).eq('id', fixture.league.id))
    await db(fixture.admin.from('draft_picks').insert([fixture.proposer, fixture.recipient].map((member) => ({ league_id: fixture.league.id,
      season_year: fixture.currentSeason.season_year, round: 1, original_owner_id: member.id, current_owner_id: fixture.proposer.id }))))
    const draft = await db(fixture.admin.rpc('start_rookie_draft_atomic', { p_league_id: fixture.league.id, p_rounds: 1, p_pick_timer_seconds: 3600 }))
    await db(fixture.admin.rpc('make_snake_pick_atomic', { p_draft_id: draft.id, p_member_id: fixture.proposer.id, p_player_id: taxiPlayer.id, p_to_taxi: true }))
    await db(fixture.admin.rpc('stop_draft_atomic', { p_draft_id: draft.id, p_actor_user_id: fixture.users[0].id }))
    await db(fixture.admin.from('leagues').update({ status: 'active' }).eq('id', fixture.league.id))
    const rows = () => db(fixture.admin.from('trade_block_items').select('id,player_id,pick_id,note').eq('league_id', fixture.league.id).eq('member_id', fixture.proposer.id))
    await signIn(fixture)
    await open('/trades')
    await press(page.getByRole('tab', { name: 'Block', exact: true }))
    await press(button(`List ${fixture.proposerPlayer.display_name} on trade block`))
    await wait(async () => (await rows()).some((row) => row.player_id === fixture.proposerPlayer.id))
    await button(`List ${fixture.proposerPlayer.display_name} on trade block`).waitFor({ state: 'hidden' })
    await button(`Remove ${fixture.proposerPlayer.display_name} from trade block`).waitFor()
    const pick = (await db(fixture.admin.from('draft_picks').select('id,season_year,round').eq('league_id', fixture.league.id).eq('current_owner_id', fixture.proposer.id).eq('original_owner_id', fixture.proposer.id).gt('season_year', fixture.currentSeason.season_year).order('season_year').order('round').limit(1)))[0]
    const listPick = `List ${pick.season_year - 1} Round ${pick.round} pick on trade block`
    const listedPick = page.waitForResponse((response) => response.url().endsWith('/api/trades/block') && response.request().method() === 'POST')
    await press(button(listPick))
    const pickResponse = await listedPick
    assert.equal(pickResponse.request().postDataJSON().pickId, pick.id, `Visible ${listPick} must submit its own pick identity`)
    await wait(async () => (await rows()).some((row) => row.pick_id === pick.id))
    const note = `Saved scouting note ${fixture.runId}`
    await press(button(`Edit trade block note for ${fixture.proposerPlayer.display_name}`))
    const noteInput = page.getByRole('textbox', { name: `Trade block note for ${fixture.proposerPlayer.display_name}`, exact: true })
    await noteInput.fill(note)
    await inspect()
    await button('Save note').focus()
    await page.keyboard.press('Enter')
    await wait(async () => (await rows()).find((row) => row.player_id === fixture.proposerPlayer.id)?.note === note)
    await reloadWebTarget(page)
    await press(page.getByRole('tab', { name: 'Block', exact: true }))
    await button(`Edit trade block note for ${fixture.proposerPlayer.display_name}`).getByText(note, { exact: true }).waitFor()
    await press(button(`List ${taxiPlayer.display_name} on trade block`))
    await wait(async () => (await rows()).some((row) => row.player_id === taxiPlayer.id))
    const listingId = (await rows()).find((row) => row.player_id === taxiPlayer.id).id
    const locationRow = () => db(fixture.admin.from('roster_players').select('id,is_on_ir,is_on_taxi').eq('league_id', fixture.league.id).eq('player_id', taxiPlayer.id).maybeSingle())
    const verifyLocation = async (location) => {
      await open('/trades')
      await press(page.getByRole('tab', { name: 'Block', exact: true }))
      const listing = button(`Remove ${taxiPlayer.display_name} from trade block`).locator('..')
      await listing.getByText(`${fixture.proposer.team_name} · ${location}`, { exact: true }).waitFor()
      assert.equal((await rows()).find((row) => row.player_id === taxiPlayer.id)?.id, listingId)
    }
    await verifyLocation('TAXI')
    await open('/roster')
    await press(button(`Activate ${taxiPlayer.display_name}`))
    await press(button('Confirm'))
    await wait(async () => (await locationRow())?.is_on_taxi === false)
    await verifyLocation('Active')
    await open('/roster')
    await press(button(`Open ${taxiPlayer.display_name}`))
    await press(button('Move to IR'))
    await press(button('Confirm'))
    await wait(async () => (await locationRow())?.is_on_ir === true)
    await verifyLocation('IR')
    await open('/roster')
    await press(button(`Open ${taxiPlayer.display_name}`))
    await press(button('Activate from IR'))
    await press(button('Confirm'))
    await wait(async () => (await locationRow())?.is_on_ir === false)
    await verifyLocation('Active')
    await open('/roster')
    await press(button(`Open ${taxiPlayer.display_name}`))
    await press(button(`Drop ${taxiPlayer.display_name}`))
    await press(button('Drop'))
    await wait(async () => await locationRow() === null)
    await wait(async () => !(await rows()).some((row) => row.player_id === taxiPlayer.id))
    await open('/trades')
    await press(page.getByRole('tab', { name: 'Block', exact: true }))
    assert.equal(await button(`Remove ${taxiPlayer.display_name} from trade block`).count(), 0)
    await signIn(fixture, 1)
    await open('/trades')
    await press(page.getByRole('tab', { name: 'Block', exact: true }))
    await press(button(`Offer for ${fixture.proposerPlayer.display_name}`))
    await page.waitForURL((url) => url.pathname === '/propose-trade')
    assert.equal(new URL(page.url()).searchParams.get('recipientMemberId'), fixture.proposer.id)
    assert.equal(new URL(page.url()).searchParams.get('requestPlayerId'), fixture.proposerPlayer.id)
    const sender = page.getByTestId(`trade-sender-${fixture.proposer.id}`)
    if (target.mobile) await press(sender)
    await page.getByRole('button', { name: `Remove ${fixture.proposerPlayer.display_name} for trade`, exact: true }).waitFor()
    await signIn(fixture)
    await open('/trades')
    await press(page.getByRole('tab', { name: 'Block', exact: true }))
    await press(button(`Remove ${fixture.proposerPlayer.display_name} from trade block`))
    await wait(async () => !(await rows()).some((row) => row.player_id === fixture.proposerPlayer.id))
    const removePick = page.getByRole('button', { name: /^Remove .* pick from trade block$/ })
    await press(removePick)
    await wait(async () => (await rows()).length === 0)
    await reloadWebTarget(page)
    await press(page.getByRole('tab', { name: 'Block', exact: true }))
    await button(`List ${fixture.proposerPlayer.display_name} on trade block`).waitFor()
    return { leagueId: fixture.league.id, playerAndPickAddedAndRemoved: true, noteEditedAndPersisted: true, keyboardSave: true, listingRetainedAcrossTaxiActiveIrMoves: true, ownershipLossRemovedListing: true }
  })
  await check('trade-history-next-page', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    const trades = await db(fixture.admin.from('trades').insert(Array.from({ length: 41 }, (_, index) => ({
      league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, proposer_member_id: fixture.proposer.id,
      recipient_member_id: fixture.recipient.id, status: 'rejected', notes: `History entry ${index + 1} ${fixture.runId}`,
      proposed_at: new Date(Date.now() - index * 1000).toISOString(),
    }))).select('id,proposed_at'))
    await db(fixture.admin.from('trade_participants').insert(trades.flatMap((trade) => [fixture.proposer, fixture.recipient].map((member, index) => ({
      trade_id: trade.id, member_id: member.id, league_id: fixture.league.id, proposed_at: trade.proposed_at, is_initiator: index === 0, sort_order: index,
    })))))
    await db(fixture.admin.from('trade_items').insert(trades.flatMap((trade) => [
      { trade_id: trade.id, side: 'proposer', player_id: fixture.proposerPlayer.id, from_member_id: fixture.proposer.id, to_member_id: fixture.recipient.id },
      { trade_id: trade.id, side: 'recipient', player_id: fixture.recipientPlayer.id, from_member_id: fixture.recipient.id, to_member_id: fixture.proposer.id },
    ])))
    const refs = []
    const capture = async (response) => {
      if (!response.url().includes('/rest/v1/trade_participants?') || !response.url().includes(fixture.league.id)) return
      const rows = await response.json()
      if (Array.isArray(rows)) refs.push({ cursor: new URL(response.url()).searchParams.has('or'), ids: rows.map((row) => row.trade_id) })
    }
    page.on('response', capture)
    try {
      await signIn(fixture)
      await open('/trades')
      await press(page.getByRole('tab', { name: 'History', exact: true }))
      await wait(async () => refs.some((entry) => !entry.cursor && entry.ids.length === 41))
      for (let attempt = 0; attempt < 40 && !refs.some((entry) => entry.cursor); attempt += 1) {
        await page.locator('[role="main"]').evaluate((root) => {
          for (const node of [root, ...root.querySelectorAll('*')]) {
            if (node.scrollHeight > node.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(node).overflowY)) node.scrollTop = node.scrollHeight
          }
        })
        await page.waitForTimeout(150)
      }
      await wait(async () => refs.some((entry) => entry.cursor && entry.ids.length === 1))
      assert.equal(refs.find((entry) => entry.cursor).ids[0], trades.at(-1).id)
      await page.getByTestId(`trade-analyze-${trades.at(-1).id}`).waitFor()
      await press(page.getByTestId(`trade-details-${trades.at(-1).id}`))
      await button('Revalue this trade with current inputs').waitFor()
      const sheet = page.getByRole('dialog').filter({ has: button('Revalue this trade with current inputs') })
      if (await sheet.count()) {
        await inspect()
        await press(sheet.getByRole('button', { name: 'Close', exact: true }))
        await sheet.waitFor({ state: 'hidden' })
        await press(page.getByTestId(`trade-details-${trades.at(-1).id}`))
      }
      await press(button('Revalue this trade with current inputs'))
      await button('Back to trades').waitFor()
      await page.getByLabel('Dynasty trade analysis', { exact: true }).waitFor()
      assert.equal((await db(fixture.admin.from('trades').select('id').eq('league_id', fixture.league.id))).length, 41)
      return { leagueId: fixture.league.id, pageSize: 40, total: 41, cursorRead: refs.find((entry) => entry.cursor), simulatedScroll: true }
    } finally { page.off('response', capture) }
  })
  await check('trade-receive-player-into-taxi', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    await db(fixture.admin.from('leagues').update({ taxi_slots: 1, trade_veto_mode: 'disabled' }).eq('id', fixture.league.id))
    await db(fixture.admin.from('players').update({ years_exp: 0, nba_draft_number: 1 }).in('id', [fixture.proposerPlayer.id, fixture.recipientPlayer.id]))
    const trade = await db(fixture.admin.from('trades').insert({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id,
      proposer_member_id: fixture.proposer.id, recipient_member_id: fixture.recipient.id, status: 'pending', notes: 'Owned taxi destination offer' }).select('id').single())
    await db(fixture.admin.from('trade_participants').insert([fixture.proposer, fixture.recipient].map((member, index) => ({
      trade_id: trade.id, league_id: fixture.league.id, member_id: member.id, sort_order: index, is_initiator: index === 0,
      accepted_at: index === 0 ? new Date().toISOString() : null,
    }))))
    await db(fixture.admin.from('trade_items').insert([
      { trade_id: trade.id, side: 'proposer', player_id: fixture.proposerPlayer.id, from_member_id: fixture.proposer.id, to_member_id: fixture.recipient.id },
      { trade_id: trade.id, side: 'recipient', player_id: fixture.recipientPlayer.id, from_member_id: fixture.recipient.id, to_member_id: fixture.proposer.id },
    ]))
    await signIn(fixture, 1)
    await open('/trades')
    await press(page.getByTestId(`trade-details-${trade.id}`))
    const choice = page.getByRole('radio', { name: `${fixture.proposerPlayer.display_name}: taxi`, exact: true }).first()
    await choice.waitFor()
    await press(choice)
    await wait(async () => (await db(fixture.admin.from('trade_items').select('to_taxi').eq('trade_id', trade.id).eq('player_id', fixture.proposerPlayer.id).single())).to_taxi === true)
    const before = await db(fixture.admin.from('roster_players').select('member_id,is_on_taxi').eq('league_id', fixture.league.id).eq('player_id', fixture.proposerPlayer.id).single())
    assert.equal(before.member_id, fixture.proposer.id)
    assert.equal(before.is_on_taxi, false)
    await press(button(`Accept trade with ${fixture.proposer.team_name}`).last())
    await confirmTradeAcceptance({ page, press })
    await wait(async () => (await db(fixture.admin.from('trades').select('status').eq('id', trade.id).single())).status === 'completed')
    const after = await db(fixture.admin.from('roster_players').select('member_id,is_on_taxi').eq('league_id', fixture.league.id).eq('player_id', fixture.proposerPlayer.id).single())
    assert.equal(after.member_id, fixture.recipient.id)
    assert.equal(after.is_on_taxi, true)
    const sent = await db(fixture.admin.from('roster_players').select('member_id,is_on_taxi').eq('league_id', fixture.league.id).eq('player_id', fixture.recipientPlayer.id).single())
    assert.equal(sent.member_id, fixture.proposer.id)
    assert.equal(sent.is_on_taxi, false)
    return { leagueId: fixture.league.id, destinationSavedBeforeAcceptance: true, noEarlyOwnershipMove: true, receivedIntoTaxi: true, outgoingSettled: true }
  })
  await check('home-breakdown-and-auto-set-controls', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    await signIn(fixture)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const week = await db(fixture.admin.from('season_weeks').select('week_number').eq('season_year', fixture.currentSeason.season_year)
      .lte('week_start', today).gte('week_end', today).single())
    await db(fixture.admin.from('matchups').insert({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id,
      week_number: week.week_number, home_member_id: fixture.proposer.id, away_member_id: fixture.recipient.id }))
    await db(fixture.admin.from('weekly_lineups').insert({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id,
      member_id: fixture.proposer.id, player_id: fixture.proposerPlayer.id, week_number: week.week_number, game_date: today, slot_type: 'PG' }))
    await open('/')
    await press(button(`Score breakdown for ${fixture.proposerPlayer.display_name}`).first())
    const breakdown = page.getByRole('dialog', { name: /slot · Score breakdown$/ })
    await breakdown.getByLabel('Scoring rules', { exact: true }).waitFor()
    await breakdown.getByText('Points', { exact: true }).waitFor()
    assert.equal(await breakdown.getByRole('table', { name: 'Points by stat', exact: true }).count(), 0)
    await inspect()
    await press(breakdown.getByRole('button', { name: 'Close', exact: true }))
    await press(button('Open auto-set lineup options'))
    await press(page.getByRole('dialog', { name: 'Auto-set lineup', exact: true }).getByRole('button', { name: 'Close', exact: true }).last())
    await page.getByRole('dialog', { name: 'Auto-set lineup', exact: true }).waitFor({ state: 'hidden' })
    await open('/roster')
    await press(button('Set lineup automatically'))
    await press(button('Edit lineup manually'))
    await page.waitForURL((url) => url.pathname === '/lineup')
    const toggle = page.getByRole('switch', { name: 'Auto-set daily', exact: true })
    await wait(async () => await toggle.isEnabled())
    const saved = () => db(fixture.admin.from('lineup_optimizer_settings').select('enabled').eq('member_id', fixture.proposer.id).eq('league_season_id', fixture.currentSeason.id).maybeSingle())
    assert.equal(await toggle.isChecked(), true)
    await press(toggle)
    await wait(async () => (await saved())?.enabled === false)
    await press(toggle)
    await wait(async () => (await saved())?.enabled === true)
    await reloadWebTarget(page)
    await wait(async () => await toggle.isEnabled() && await toggle.isChecked())
    await press(toggle)
    await wait(async () => (await saved())?.enabled === false)
    await reloadWebTarget(page)
    await wait(async () => await toggle.isEnabled())
    assert.equal(await toggle.isChecked(), false)
    return { leagueId: fixture.league.id, breakdown: 'rules shown before any stats exist', cancelled: true, manualNavigation: true, dailyEnabledAndDisabled: true }
  })
  await check('league-activity-paging-and-copy', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    await db(fixture.admin.from('roster_transactions').insert(Array.from({ length: 61 }, (_, index) => ({
      league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, member_id: fixture.proposer.id,
      player_id: fixture.proposerPlayer.id, transaction_type: 'fa_add', occurred_at: new Date(Date.now() - index * 1000).toISOString(),
    }))))
    const pages = []
    const capture = async (response) => {
      if (!response.url().endsWith('/rpc/get_league_activity_feed') || response.request().postDataJSON()?.p_league_id !== fixture.league.id) return
      const rows = await response.json()
      pages.push({ offset: response.request().postDataJSON().p_offset, count: rows.length })
    }
    page.on('response', capture)
    try {
      await signIn(fixture)
      await open('/league?tab=history')
      const more = button('Load more league activity')
      await more.waitFor()
      await press(more)
      await wait(async () => pages.some((entry) => entry.offset === 50 && entry.count > 0 && entry.count < 50))
      await more.waitFor({ state: 'hidden' })
      await page.addInitScript(() => {
        Reflect.set(window, '__auditClipboard', [])
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => Reflect.get(window, '__auditClipboard').push(text) } })
      })
      await open('/league?tab=settings')
      await press(button('Copy invite code'))
      await page.getByText('Copied', { exact: true }).waitFor()
      assert.deepEqual(await page.evaluate(() => Reflect.get(window, '__auditClipboard')), [fixture.league.invite_code])
      return { leagueId: fixture.league.id, pages, copiedCode: true, clipboard: 'Simulated clipboard permission and storage; actual copied text is asserted' }
    } finally { page.off('response', capture) }
  })
  await check('dynasty-source-retry-and-news-link', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    const resources = createFixtureResourceOwner(fixture.admin)
    const title = `Owned news ${fixture.runId}`
    const url = new URL(`/audit-news-${fixture.runId}`, env.frontendUrl).href
    const news = await db(fixture.admin.from('dynasty_news').insert({ title, summary: 'Browser audit news', source: 'Local fixture', url,
      player_id: fixture.proposerPlayer.id, published_at: new Date(Date.now() + 60000).toISOString() }).select('id').single())
    resources.registerCleanup('owned news', () => db(fixture.admin.from('dynasty_news').delete().eq('id', news.id)))
    const pattern = '**/rpc/get_dynasty_forecast_inputs'
    await page.route(pattern, (route) => {
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,OPTIONS' }
      return route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers })
        : route.fulfill({ status: 503, headers, json: { message: 'Local audit source failure' } })
    })
    await signIn(fixture)
    await open('/players?section=rankings')
    await page.getByText('Rankings could not load', { exact: true }).waitFor()
    await page.unroute(pattern)
    await press(button('Retry rankings'))
    await page.getByText('Rankings could not load', { exact: true }).waitFor({ state: 'hidden' })
    for (const name of ['3-Year Points', 'Rookies & Picks', '5-Year Points']) await press(page.getByRole('tab', { name, exact: true }))
    const query = page.getByRole('textbox', { name: 'Search dynasty rankings', exact: true })
    await query.fill('No such dynasty audit player')
    await page.getByText('No ranked players match "No such dynasty audit player".', { exact: true }).waitFor()
    await press(button('Clear search'))
    assert.equal(await query.inputValue(), '')
    await open('/players?section=news')
    await press(page.getByRole('tab', { name: /^My players/ }))
    const link = page.getByRole('link', { name: title, exact: true })
    await link.waitFor()
    await page.context().route(url, (route) => route.fulfill({ contentType: 'text/html', body: '<main>Local news destination</main>' }))
    try {
      const popup = page.waitForEvent('popup')
      await press(link)
      const destination = await popup
      try {
        await destination.waitForURL(url)
        await destination.getByText('Local news destination', { exact: true }).waitFor()
      } finally { await destination.close() }
    } finally { await page.context().unroute(url) }
    return { leagueId: fixture.league.id, failedSource: 'Simulated local 503; retry uses the actual local database', rankingViews: 3,
      paging: 'Rankings load a bounded list; no paging action exists', ownedNewsLink: true, destination: 'Loopback fixture; no external site is opened' }
  })
}
