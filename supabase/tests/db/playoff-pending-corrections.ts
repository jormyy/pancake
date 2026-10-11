import { strict as assert } from 'node:assert'

const api = Deno.env.get('SUPABASE_URL')
assert.ok(api && ['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.href
      : input.url,
  )
  assert.equal(
    url.origin,
    api,
    'Only the isolated database may receive requests',
  )
  const response = await nativeFetch(input, init)
  return response
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const { runSeasonBoundary } = await import(
  '../../functions/_shared/seasonBoundary.ts'
)
const query = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
const today = new Date().toLocaleDateString('en-CA', {
  timeZone: 'America/New_York',
})
const addDays = (day: string, count: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString()
    .slice(0, 10)
const failures: string[] = []
const reports: unknown[] = []
try {
  for (const span of [1, 2]) {
    for (const phase of ['pending-stats', 'pending-calendar']) {
      const token = crypto.randomUUID().replaceAll('-', '')
      const league = crypto.randomUUID(),
        season = crypto.randomUUID(),
        game = crypto.randomUUID(),
        finalGame = crypto.randomUUID()
      const members = Array.from({ length: 4 }, () => crypto.randomUUID())
      const players = Array.from({ length: 4 }, () => crypto.randomUUID())
      const weekIds = Array.from({ length: 5 }, () => crypto.randomUUID())
      const users: string[] = []
      let year = 0, weeksInserted = false
      const first = addDays(today, -42), gameDate = addDays(first, 2)
      const readSemis = () =>
        query(
          supabase.from('matchups')
            .select(
              'id,home_member_id,away_member_id,home_points,away_points,winner_member_id,is_finalized,finalized_at,score_read_started_at,home_max_possible_points,away_max_possible_points',
            )
            .eq('league_season_id', season).eq(
              'matchup_type',
              'playoff_semifinal',
            ).order('id'),
        )
      try {
        for (let attempt = 0; attempt < 50; attempt++) {
          const candidate = 3000 +
            crypto.getRandomValues(new Uint32Array(1))[0] % 5000
          const rows = await query(
            supabase.from('season_weeks').select('id').in('season_year', [
              candidate,
              candidate + 1,
            ]),
          )
          const seasons = await query(
            supabase.from('league_seasons').select('id').in('season_year', [
              candidate,
              candidate + 1,
            ]),
          )
          if (!rows.length && !seasons.length) {
            year = candidate
            break
          }
        }
        assert.ok(year)
        for (let side = 0; side < 4; side++) {
          const { data, error } = await supabase.auth.admin.createUser({
            email: `playoff-consume-${token}-${side}@example.test`,
            password: `Synthetic-${crypto.randomUUID()}!`,
            email_confirm: true,
            user_metadata: {
              username: `consume_${token.slice(0, 12)}_${side}`,
              display_name: 'Synthetic playoff overlap',
            },
          })
          if (error) throw new Error(error.message)
          assert.ok(data.user)
          users.push(data.user.id)
        }
        await query(
          supabase.from('leagues').insert({
            id: league,
            slug: `consume-${token}`,
            name: 'Synthetic playoff overlap',
            commissioner_id: users[0],
            status: 'active',
            scoring_settings: { points: 1 },
            playoff_start_week: 1,
            ...(span === 2
              ? { playoff_total_weeks: 5, playoff_round_weeks: [2, 3] }
              : {}),
          }),
        )
        await query(
          supabase.from('league_members').insert(
            members.map((id, side) => ({
              id,
              league_id: league,
              user_id: users[side],
              role: side ? 'manager' as const : 'commissioner' as const,
              team_name: `Overlap ${side}`,
            })),
          ),
        )
        await query(
          supabase.from('league_seasons').insert({
            id: season,
            league_id: league,
            season_year: year,
            is_current: true,
          }),
        )
        await query(
          supabase.from('season_weeks').insert(
            weekIds.map((id, index) => ({
              id,
              season_year: year,
              week_number: index + 1,
              week_start: addDays(first, index * 7),
              week_end: addDays(first, index * 7 + 6),
            })),
          ),
        )
        weeksInserted = true
        await query(
          supabase.from('players').insert(
            players.map((id, index) => ({
              id,
              first_name: 'Synthetic',
              last_name: `Consume ${token}-${index}`,
              position: 'PG' as const,
              eligible_positions: ['PG'],
              nba_team: 'XCO',
            })),
          ),
        )
        await query(
          supabase.from('roster_players').insert(
            players.map((id, index) => ({
              player_id: id,
              member_id: members[index],
              league_id: league,
              league_season_id: season,
              acquired_via: 'draft',
              acquired_at: `${addDays(first, -7)}T12:00:00Z`,
            })),
          ),
        )
        await query(
          supabase.from('weekly_lineups').delete().eq('league_id', league),
        )
        await query(
          supabase.from('nba_games').insert({
            id: game,
            nba_game_id: `002-consume-${token}`,
            season_year: year,
            week_number: 1,
            game_date: gameDate,
            game_time: `${gameDate}T19:00:00Z`,
            home_team: 'XCO',
            away_team: 'XCP',
            status: 'Final',
            stats_synced_at: new Date().toISOString(),
          }),
        )
        await query(
          supabase.rpc('generate_playoff_bracket_atomic', {
            p_league_id: league,
          }),
        )
        if (span === 1) {
          await query(
            supabase.from('matchups').update({ end_week_number: null }).eq(
              'league_season_id',
              season,
            ),
          )
        }
        const initial = await readSemis()
        const homes = new Set(initial.map((row: any) => row.home_member_id))
        await query(
          supabase.from('player_game_stats').insert(
            players.map((id, index) => ({
              player_id: id,
              game_id: game,
              season_year: year,
              week_number: 1,
              game_date: gameDate,
              points: homes.has(members[index]) ? 10 : 5,
              did_not_play: false,
            })),
          ),
        )
        await query(
          supabase.from('weekly_lineups').insert(
            players.map((id, index) => ({
              player_id: id,
              member_id: members[index],
              league_id: league,
              league_season_id: season,
              week_number: 1,
              game_date: gameDate,
              slot_type: 'PG' as const,
              is_auto_set: false,
            })),
          ),
        )
        await syncScores(league)
        assert.ok(
          (await readSemis()).every((row: any) =>
            row.winner_member_id === row.home_member_id &&
            Number(row.home_points) === 10 && Number(row.away_points) === 5
          ),
        )
        // Elapsed grace is a fixture; the correction and replay use actual writes/scoring.
        await query(
          supabase.from('matchups').update({
            finalized_at: new Date(Date.now() - 49 * 3600000).toISOString(),
          }).eq('league_season_id', season),
        )
        if (phase === 'pending-stats') {
          await query(
            supabase.from('player_game_stats').update({ points: 20 }).eq(
              'game_id',
              game,
            ).in('player_id', players.filter((_, i) => !homes.has(members[i]))),
          )
        } else {
          await query(
            supabase.from('nba_games').update({ game_date: addDays(first, -1) })
              .eq('id', game),
          )
        }
        const before = await readSemis()
        const boundary = await runSeasonBoundary(new Date(), league)
        const finals = await query(
          supabase.from('matchups').select('id').eq('league_season_id', season)
            .eq('matchup_type', 'playoff_final'),
        )
        const report = {
          span,
          phase,
          finalsCreated: finals.length,
          boundary,
          scoreRead: before[0]?.score_read_started_at,
        }
        reports.push(report)
        console.log(JSON.stringify(report))
        assert.ok(
          boundary.every((row: any) => !row.error),
          JSON.stringify(boundary),
        )
        if (finals.length) {
          failures.push(
            `span${span}/${phase}: saved correction consumed before replay`,
          )
        } else {
          await syncScores(league)
          const after = await readSemis()
          if (phase === 'pending-stats') {
            assert.ok(
              after.every((m: any) =>
                m.winner_member_id === m.away_member_id &&
                Number(m.away_points) === 20
              ),
              'actual stat correction changes winner',
            )
          } else {assert.ok(
              after.every((m: any) =>
                Number(m.home_points) === 0 && Number(m.away_points) === 0
              ),
              'actual moved-game replay removes old scores',
            )}
          const renewed = await runSeasonBoundary(new Date(), league)
          assert.ok(
            !renewed[0]?.actions.includes('final-created'),
            'replay renews decision grace',
          )
          const settled = await runSeasonBoundary(
            new Date(Date.now() + 49 * 3600000),
            league,
          )
          assert.ok(
            settled[0]?.actions.includes('final-created'),
            JSON.stringify(settled),
          )
          console.log(
            JSON.stringify({ span, phase, replayed: true, renewed, settled }),
          )
        }
      } finally {
        await query(supabase.from('leagues').delete().eq('id', league))
        await query(
          supabase.from('player_game_stats').delete().in('game_id', [
            game,
            finalGame,
          ]),
        )
        await query(
          supabase.from('nba_games').delete().in('id', [game, finalGame]),
        )
        await query(supabase.from('players').delete().in('id', players))
        if (weeksInserted) {
          await query(supabase.from('season_weeks').delete().in('id', weekIds))
        }
        for (const user of users) {
          const { error } = await supabase.auth.admin.deleteUser(user)
          if (error) throw new Error(error.message)
        }
        console.log(JSON.stringify({ span, phase, cleanup: 'complete' }))
      }
    }
  }
} finally {
  globalThis.fetch = nativeFetch
}
console.log(JSON.stringify({ scenarios: reports.length, failures }))
assert.deepEqual(failures, [])
