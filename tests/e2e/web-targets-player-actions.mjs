import assert from 'node:assert/strict'
import { setupTradeGameplayFixture, createFixtureResourceOwner } from './trade-fixture.mjs'

export async function auditWebPlayerActions({ check, env, season, target, page, press, button, open, signIn, db, wait, inspect }) {
  await check('player-game-and-history-pages', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    const resources = createFixtureResourceOwner(fixture.admin)
    const year = fixture.currentSeason.season_year
    let ids
    do {
      const offset = Math.floor(Math.random() * 89_000) + 1000
      ids = Array.from({ length: 31 }, (_, index) => `002${String(year - 1).slice(-2)}${String(offset + index).padStart(5, '0')}`)
    } while ((await db(fixture.admin.from('nba_games').select('id').in('nba_game_id', ids))).length)
    const games = await db(fixture.admin.from('nba_games').insert(ids.map((nba_game_id, index) => ({
      nba_game_id, season_year: year, game_date: new Date(Date.UTC(year - 1, 10, index + 1)).toISOString().slice(0, 10),
      week_number: 1, home_team: 'BOS', away_team: 'NYK', status: 'Final',
    }))).select('id,game_date'))
    resources.registerCleanup('player paging games', async () => {
      await db(fixture.admin.from('player_game_stats').delete().eq('player_id', fixture.proposerPlayer.id).in('game_id', games.map((game) => game.id)))
      await db(fixture.admin.from('nba_games').delete().in('id', games.map((game) => game.id)))
    })
    await db(fixture.admin.from('player_game_stats').insert(games.map((game, index) => ({
      game_id: game.id, game_date: game.game_date, player_id: fixture.proposerPlayer.id, season_year: year,
      week_number: 1, points: index + 100, minutes_played: 30, rebounds: 5, assists: 5,
    }))))
    await db(fixture.admin.from('roster_transactions').insert(Array.from({ length: 41 }, (_, index) => ({
      league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, member_id: fixture.proposer.id,
      player_id: fixture.proposerPlayer.id, transaction_type: 'fa_add', occurred_at: new Date(Date.now() - index * 1000).toISOString(),
    }))))
    await signIn(fixture)
    await open(`/player/${fixture.proposerPlayer.id}`)
    const log = page.getByText('Game Log', { exact: true }).locator('..')
    const rows = () => log.getByText('@ BOS', { exact: true }).count()
    await wait(async () => await rows() === 15)
    await press(button('Load more games'))
    await wait(async () => await rows() === 30)
    await press(button('Load more games'))
    await wait(async () => await rows() === 31)
    assert.equal(await button('Load more games').count(), 0)
    const history = page.getByText('League History', { exact: true }).locator('..')
    const transactions = () => history.getByText(fixture.proposer.team_name, { exact: true }).count()
    await wait(async () => await transactions() === 20)
    await press(history.getByText('Load More', { exact: true }))
    await wait(async () => await transactions() === 40)
    await press(history.getByText('Load More', { exact: true }))
    await wait(async () => await transactions() === 41)
    assert.equal(await history.getByText('Load More', { exact: true }).count(), 0)
    await inspect()
    return { leagueId: fixture.league.id, gamePages: [15, 30, 31], transactionPages: [20, 40, 41], exhausted: true }
  })
  await check('player-filter-sheets-and-clear', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    await signIn(fixture)
    await open('/players')
    await page.getByRole('textbox', { name: 'Search players', exact: true }).fill(fixture.proposerPlayer.display_name)
    if (target.mobile) await press(button('Show filters'))
    const selected = []
    for (const label of ['Availability', 'Position', 'Health', 'Game today', 'Experience', 'Season', ...(target.mobile ? ['Sort'] : [])]) {
      const trigger = page.getByRole('button', { name: new RegExp(`^${label}:`) }).last()
      await press(trigger)
      const dialog = page.getByRole('dialog', { name: label, exact: true })
      await wait(async () => await dialog.getByRole('button').count() > 2)
      const choices = []
      for (const option of await dialog.getByRole('button').all()) {
        if (await option.getAttribute('aria-label') === 'Close') continue
        const name = (await option.textContent()).trim()
        if (name && name !== 'Close') choices.push(name)
      }
      assert.ok(choices.length > 1, `${label} must expose choices`)
      await press(dialog.getByRole('button', { name: choices[1], exact: true }))
      await inspect()
      await press(page.getByRole('button', { name: new RegExp(`^${label}:`) }).last())
      const reopened = page.getByRole('dialog', { name: label, exact: true })
      await wait(async () => await reopened.getByRole('button', { name: choices[1], exact: true }).getAttribute('aria-pressed') === 'true')
      assert.equal(await reopened.getByRole('button', { name: choices[0], exact: true }).getAttribute('aria-pressed'), 'false')
      await press(reopened.getByRole('button', { name: choices[0], exact: true }))
      selected.push({ label, selected: choices[1], reset: choices[0] })
    }
    await press(page.getByRole('button', { name: /^Team:/ }).last())
    const teams = page.getByRole('dialog', { name: 'Team', exact: true })
    const first = teams.getByRole('checkbox').first()
    await press(first)
    await wait(async () => await first.isChecked())
    await press(button('Clear teams'))
    await wait(async () => !await first.isChecked())
    await press(teams.getByRole('button', { name: 'Done', exact: true }))
    await press(page.getByRole('button', { name: /^Position:/ }).last())
    await press(page.getByRole('dialog', { name: 'Position', exact: true }).getByRole('button', { name: selected.find((filter) => filter.label === 'Position').selected, exact: true }))
    if (target.mobile) {
      await press(page.getByRole('dialog', { name: 'Filters', exact: true }).getByRole('button', { name: /Highest first|Lowest first/ }))
      await press(button('Clear all filters'))
      await press(page.getByRole('dialog', { name: 'Filters', exact: true }).getByRole('button', { name: 'Close', exact: true }))
      await page.getByRole('dialog', { name: 'Filters', exact: true }).waitFor({ state: 'hidden' })
    } else {
      const sort = page.getByRole('button', { name: /^Sort by / }).first()
      await press(sort)
      await press(sort)
      await press(button('Clear all filters'))
    }
    const search = page.getByRole('textbox', { name: 'Search players', exact: true })
    await wait(async () => await search.inputValue() === '')
    await search.fill('No such player web audit')
    assert.equal(await search.inputValue(), 'No such player web audit')
    await page.getByText('No players match "No such player web audit".', { exact: true }).waitFor()
    await press(button('Clear search'))
    assert.equal(await page.getByRole('textbox', { name: 'Search players', exact: true }).inputValue(), '')
    return { leagueId: fixture.league.id, filters: selected, teamsCleared: true, searchCleared: true }
  })
}
