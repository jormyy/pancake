import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { readFile } from 'node:fs/promises'
import { ensureSweepDrafts } from './browser-smoke.mjs'
import { createDisposableLeagueFromSeedUsers, ensureSyntheticSeasonWeeks } from './soak-fixtures.mjs'
import { requireSweepStack, resolveSweepPorts } from './layout-stability-ports.mjs'
export { requireSweepLocal } from './layout-stability-ports.mjs'

const checked = async (operation) => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}

export async function prepareSweepFixtures({ env, statePath, resourceOwner, ports = resolveSweepPorts({}, env) }) {
  requireSweepStack(env, ports)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  const admin = createClient(env.E2E_SUPABASE_URL, env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const members = await checked(admin.from('league_members').select('id,user_id,team_name').eq('league_id', state.leagueId))
  members.sort((a, b) => state.users.findIndex((user) => user.id === a.user_id) - state.users.findIndex((user) => user.id === b.user_id))
  const me = members.find((member) => member.user_id === state.users[0].id)
  const other = members.find((member) => member.user_id !== me.user_id)
  const season = await checked(admin.from('league_seasons').select('id,season_year').eq('league_id', state.leagueId).eq('is_current', true).single())
  await ensureSyntheticSeasonWeeks(admin, season.season_year, 26, 'layout sweep', resourceOwner)
  const weeks = await checked(admin.from('season_weeks').select('week_number,week_start,week_end').eq('season_year', season.season_year).order('week_number'))
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const currentWeek = weeks.find((week) => week.week_end >= today)?.week_number
  assert.ok(currentWeek, 'The fixture season has no current or future week')
  const empty = await createDisposableLeagueFromSeedUsers({ supabase: admin, state, season: 0, label: 'layout empty matchup', userCount: 2, seasonYear: season.season_year, resourceOwner })
  const players = await checked(admin.from('players').select('id,position').like('sportsdata_id', 'e2e-player-%').order('sportsdata_id'))
  assert.ok(players.length >= 30, 'Seed requires at least 30 players')
  const existing = await checked(admin.from('roster_players').select('player_id').eq('league_id', state.leagueId))
  const used = new Set(existing.map((row) => row.player_id))
  const rosterRows = members.slice(0, 2).flatMap((member, index) => players.slice(index * 10, index * 10 + 10)
    .filter((player) => !used.has(player.id)).map((player) => ({ league_id: state.leagueId, league_season_id: season.id, member_id: member.id, player_id: player.id, acquired_via: 'e2e_layout_sweep', acquisition_cost: 1 })))
  if (rosterRows.length) await checked(admin.from('roster_players').insert(rosterRows))
  const lineups = await checked(admin.from('weekly_lineups').select('member_id,player_id').eq('league_id', state.leagueId).eq('game_date', today))
  const lineupRows = members.slice(0, 2).flatMap((member, index) => ['PG', 'SG', 'SF', 'PF', 'C'].flatMap((position) => {
    const player = players.slice(index * 10, index * 10 + 10).find((player) => player.position === position)
    return !player || lineups.some((row) => row.member_id === member.id && row.player_id === player.id) ? [] : [{ league_id: state.leagueId, league_season_id: season.id, member_id: member.id, player_id: player.id, week_number: currentWeek, game_date: today, slot_type: position }]
  }))
  if (lineupRows.length) await checked(admin.from('weekly_lineups').insert(lineupRows))
  const { auctionDraft, rookieDraft } = await ensureSweepDrafts(admin, state, members)
  const matchups = await checked(admin.from('matchups').select('id').eq('league_id', state.leagueId).eq('week_number', currentWeek).eq('home_member_id', me.id))
  if (!matchups.length) await checked(admin.from('matchups').insert({ league_id: state.leagueId, league_season_id: season.id, week_number: currentWeek, home_member_id: me.id, away_member_id: other.id, home_points: 123, away_points: 117 }))
  else await checked(admin.from('matchups').update({ home_points: 123, away_points: 117 }).eq('id', matchups[0].id))
  const playoff = await checked(admin.from('matchups').select('id').eq('league_id', state.leagueId).eq('week_number', 20))
  if (!playoff.length) await checked(admin.from('matchups').insert({ league_id: state.leagueId, league_season_id: season.id, week_number: 20, home_member_id: me.id, away_member_id: other.id, matchup_type: 'playoff_final', playoff_round: 1, playoff_position: 1 }))
  const news = await checked(admin.from('dynasty_news').select('id').eq('source', 'layout-sweep'))
  if (!news.length) await checked(admin.from('dynasty_news').insert({ player_id: players[0].id, source: 'layout-sweep', title: 'E2E Player001 returns to the starting lineup', summary: 'The synthetic player completes practice and starts this week.', published_at: new Date().toISOString() }))
  const activity = await checked(admin.from('league_activity').select('id').eq('league_id', state.leagueId).limit(1))
  if (!activity.length) await checked(admin.from('league_activity').insert({ league_id: state.leagueId, league_season_id: season.id, actor_member_id: me.id, event_type: 'commissioner_note', title: 'Season preparation is complete', body: 'Managers review their rosters before opening week.' }))
  const pending = await checked(admin.from('trades').select('id').eq('league_id', state.leagueId).eq('status', 'pending').limit(1))
  if (!pending.length) await checked(admin.rpc('propose_trade_atomic', { p_league_id: state.leagueId, p_league_season_id: season.id, p_proposer_member_id: me.id, p_recipient_member_id: other.id, p_offer_player_ids: [players[0].id], p_request_player_ids: [players[10].id], p_offer_pick_ids: [], p_request_pick_ids: [] }))
  const mock = await checked(admin.from('drafts').select('id').eq('league_id', state.leagueId).eq('is_mock', true).limit(1))
  if (!mock.length) await checked(admin.rpc('create_mock_draft_room_atomic', { p_league_id: state.leagueId, p_member_id: me.id, p_user_id: me.user_id, p_room_name: 'Layout sweep practice', p_draft_type: 'snake', p_rounds: 2 }))
  const auth = createClient(env.E2E_SUPABASE_URL, env.E2E_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  let session = (await checked(auth.auth.signInWithPassword({ email: state.users[0].email, password: state.password }))).session
  let renewing = null
  const sessionForBrowser = async () => {
    if (session.expires_at * 1000 - Date.now() > 600000) return session
    renewing ??= checked(auth.auth.signInWithPassword({ email: state.users[0].email, password: state.password }))
    session = (await renewing).session
    renewing = null
    return session
  }
  return { state, me, other, season, currentWeek, empty, sessionForBrowser, player: players[25].id, rosterPlayer: players[0].id, auction: auctionDraft.id, rookie: rookieDraft.id }
}

export function sweepSurfaces(fixture = {}) {
  /** @param {{ empty?: boolean, expected?: string, expectedRoute?: string, expectedRoutes?: string[], noAppLink?: string, origin?: string, control?: string, textControl?: string, followControl?: string, auth?: boolean }} [options] */
  const row = (id, route, options = {}) => ({ id, route, auth: true, ...options })
  return [
    row('home', '/', { expected: 'E2E Team' }), row('home-empty', '/', { empty: true, expected: 'No matchup this week yet' }),
    row('players', '/players', { expected: 'E2E' }), row('rankings', '/players?section=rankings', { expected: 'E2E' }), row('news', '/players?section=news', { expected: 'returns to the starting lineup' }),
    row('dynasty', '/dynasty', { expectedRoute: '/players?section=rankings', noAppLink: 'Legacy bookmark redirects to Players rankings; the app has no Dynasty navigation control' }), row('roster', '/roster', { expected: 'E2E' }), row('trades', '/trades', { expected: 'E2E' }),
    row('league', '/league'),
    ...['results', 'history', 'draftBoard', 'auctions', 'mockRooms', 'settings'].map((tab) => row(`league-${tab}`, `/league?tab=${tab}`)),
    row('profile', '/profile'), row('draft', '/draft', { noAppLink: 'Draft Room navigation opens the active room directly; /draft is the fallback bookmark', expectedRoutes: ['/draft', `/rookie-draft-room?draftId=${fixture.rookie ?? 'fixture'}`, `/draft-room?draftId=${fixture.auction ?? 'fixture'}`] }), row('bracket', '/bracket', { expected: 'E2E' }), row('change-password', '/change-password', { origin: '/profile', control: 'Change password' }),
    row('claim-player', `/claim-player?playerId=${fixture.player ?? 'fixture'}`, { expected: 'E2E', origin: `/player/${fixture.player ?? 'fixture'}`, control: 'Claim E2E Player026' }),
    row('commissioner-settings', '/commissioner-settings'), row('create-league', '/create-league', { origin: '/profile', control: 'Create a league' }),
    row('draft-room', `/draft-room?draftId=${fixture.auction ?? 'fixture'}`, { origin: '/league?tab=auctions', control: 'Join Auction Draft' }), row('join-league', '/join-league', { origin: '/profile', control: 'Join a league' }), row('lineup', '/lineup', { expected: 'E2E', origin: '/roster' }),
    row('propose-trade', `/propose-trade?recipientMemberId=${fixture.other?.id ?? 'fixture'}`, { expected: 'E2E', origin: `/team-roster?memberId=${fixture.other?.id ?? 'fixture'}`, control: 'Propose trade with this team' }),
    row('rookie-draft-room', `/rookie-draft-room?draftId=${fixture.rookie ?? 'fixture'}`, { origin: '/league?tab=draftBoard', control: 'Join Rookie Draft' }),
    row('team-roster', `/team-roster?memberId=${fixture.other?.id ?? 'fixture'}`, { expected: 'E2E', origin: '/league', textControl: fixture.other?.team_name ?? 'E2E Team 2' }),
    row('player', `/player/${fixture.rosterPlayer ?? 'fixture'}`, { expected: 'E2E', origin: '/roster', control: 'Open E2E Player001', followControl: 'View E2E Player001 player page' }),
    row('sign-in', '/sign-in', { auth: false, origin: '/sign-up' }), row('sign-up', '/sign-up', { auth: false }), row('not-found', '/layout-sweep-missing', { expected: 'Page not found', noAppLink: 'Unmatched URLs have no in-app navigation control' }),
  ]
}
