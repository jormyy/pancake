import { strict as assert } from 'node:assert'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect } from './request-driver.ts'
import { guardTarget } from './profile.ts'

const api = Deno.env.get('SUPABASE_URL') ?? ''
const db = Deno.env.get('SUPABASE_DB_URL') ?? ''
guardTarget(api, '56321')
guardTarget(db, '56322')
const beforeIndex = Deno.args.indexOf('--before')
assert.ok(beforeIndex >= 0 && Deno.args[beforeIndex + 1], 'Pass --before with the unchanged backend directory')
const beforeRoot = await Deno.realPath(Deno.args[beforeIndex + 1])
const afterRoot = await Deno.realPath(new URL('../..', import.meta.url))
assert.equal(await Deno.realPath(`${beforeRoot}/..`), await Deno.realPath(`${afterRoot}/..`))
assert.notEqual(beforeRoot, afterRoot)
const sourceHash = async (root: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  await Deno.readFile(`${root}/supabase/functions/_shared/syncScores.ts`))), value => value.toString(16).padStart(2, '0')).join('')
const hashes = { before: await sourceHash(beforeRoot), after: await sourceHash(afterRoot) }
assert.equal(hashes.before, 'd3aabb7c87747934aa2c1f77c98de945e6e60c91f13171a2b0518ce0cf294187', 'BEFORE must be the scorer at 16a12e89')
const outIndex = Deno.args.indexOf('--out')
const out = outIndex >= 0 ? Deno.args[outIndex + 1] : undefined
if (outIndex >= 0) {
  assert.ok(out)
  const directory = await Deno.realPath(dirname(resolve(out)))
  for (const root of [beforeRoot, afterRoot]) assert.ok(directory !== root && !directory.startsWith(root + '/'), 'Keep evidence outside source copies')
  await assert.rejects(() => Deno.stat(out), Deno.errors.NotFound)
}
const nativeFetch = globalThis.fetch.bind(globalThis)
let maxRosterReads = 0
let publications: Record<string, unknown>[] = []
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  assert.equal(url.origin, new URL(api).origin, 'The regression must use only its isolated local API')
  if (url.pathname === '/rest/v1/roster_players' && url.searchParams.get('select')?.includes('acquired_at')) maxRosterReads++
  if (url.pathname === '/rest/v1/rpc/finalize_score_week_atomic') {
    const body = init && 'body' in init ? init.body : input instanceof Request ? await input.clone().text() : undefined
    publications.push(JSON.parse(String(body)))
  }
  return await nativeFetch(input, init)
}
const { supabase } = await import('../../supabase/functions/_shared/supabase.ts')
const after = await import('../../supabase/functions/_shared/syncScores.ts')
const before = await import(pathToFileURL(`${beforeRoot}/supabase/functions/_shared/syncScores.ts`).href) as typeof after
const sql = connect(db)
const query = async <T>(operation: PromiseLike<{ data: T; error: { message: string } | null }>) => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data as NonNullable<T>
}
const token = crypto.randomUUID().replaceAll('-', '')
const users: string[] = []
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const first = addDays(today, -35)
const referenceDate = new Date(`${today}T12:00:00Z`)
const results: unknown[] = []

Deno.test('last-week span corrections invalidate certified maxima and match the unchanged scorer, with single-week controls', async () => {
  try {
    for (let side = 0; side < 2; side++) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: `span-certificate-${token}-${side}@example.test`, password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
        user_metadata: { username: `cert_${token.slice(0, 15)}_${side}`, display_name: 'Synthetic certificate proof' },
      })
      if (error) throw new Error(error.message)
      assert.ok(data.user)
      users.push(data.user.id)
    }
    for (const weeks of [2, 1]) {
      for (const correction of ['stat', 'ir'] as const) {
        const players = Array.from({ length: 3 }, () => crypto.randomUUID())
        const games = Array.from({ length: weeks }, () => crypto.randomUUID())
        const weekIds = Array.from({ length: weeks }, () => crypto.randomUUID())
        const variants = [before, after].map((module, index) => ({
          module, label: index ? 'after' : 'before', league: crypto.randomUUID(), season: crypto.randomUUID(),
          matchup: crypto.randomUUID(), members: [crypto.randomUUID(), crypto.randomUUID()],
        }))
        let year = 0
        try {
          for (let attempt = 0; attempt < 50; attempt++) {
            const candidate = 3000 + crypto.getRandomValues(new Uint32Array(1))[0] % 5000
            const [{ count }] = await sql`SELECT (SELECT count(*) FROM public.season_weeks WHERE season_year=${candidate})
              +(SELECT count(*) FROM public.league_seasons WHERE season_year=${candidate})
              +(SELECT count(*) FROM public.nba_games WHERE season_year=${candidate}) AS count`
            if (Number(count) === 0) { year = candidate; break }
          }
          assert.ok(year)
          await query(supabase.from('season_weeks').insert(weekIds.map((id, index) => ({ id, season_year: year, week_number: index + 1,
            week_start: addDays(first, index * 7), week_end: addDays(first, index * 7 + 6) }))))
          await query(supabase.from('players').insert(players.map((id, index) => ({ id, first_name: 'Synthetic',
            last_name: `Certificate ${token}-${weeks}-${correction}-${index}`, position: 'PG' as const, eligible_positions: ['PG'], nba_team: 'XCT' }))))
          await query(supabase.from('nba_games').insert(games.map((id, index) => ({ id, nba_game_id: `002-cert-${token}-${weeks}-${correction}-${index}`,
            season_year: year, week_number: index + 1, game_date: addDays(first, index * 7 + 2), game_time: `${addDays(first, index * 7 + 2)}T19:00:00Z`,
            home_team: 'XCT', away_team: 'XCU', status: 'Final', stats_synced_at: new Date().toISOString() }))))
          await query(supabase.from('player_game_stats').insert(games.flatMap((game, index) => players.map((player, side) => ({
            game_id: game, player_id: player, season_year: year, week_number: index + 1, game_date: addDays(first, index * 7 + 2),
            points: [10, 30, 20][side], did_not_play: false,
          })))))
          for (const variant of variants) {
            await query(supabase.from('leagues').insert({ id: variant.league, slug: `cert-${token}-${weeks}-${correction}-${variant.label}`,
              name: 'Synthetic certificate proof', commissioner_id: users[0], status: 'active', scoring_settings: { points: 1 },
              playoff_start_week: weeks === 2 ? 1 : 3, playoff_total_weeks: 4, playoff_round_weeks: [2, 2] }))
            await query(supabase.from('league_members').insert(variant.members.map((id, side) => ({ id, league_id: variant.league,
              user_id: users[side], role: side ? 'manager' as const : 'commissioner' as const, team_name: `Certificate side ${side}` }))))
            await query(supabase.from('league_seasons').insert({ id: variant.season, league_id: variant.league, season_year: year, is_current: true }))
            await query(supabase.from('lineup_slot_templates').delete().eq('league_id', variant.league))
            await query(supabase.from('lineup_slot_templates').insert({ league_id: variant.league, slot_type: 'PG', slot_count: 1 }))
            await query(supabase.from('roster_players').insert(players.map((player, index) => ({ player_id: player,
              league_id: variant.league, league_season_id: variant.season, member_id: variant.members[index === 2 ? 1 : 0],
              acquired_via: 'draft', acquired_at: `${addDays(first, -7)}T12:00:00Z` }))))
            await query(supabase.from('roster_transactions').insert(players.map((player, index) => ({ player_id: player,
              league_id: variant.league, league_season_id: variant.season, member_id: variant.members[index === 2 ? 1 : 0],
              transaction_type: 'draft_won', occurred_at: `${addDays(first, -7)}T12:00:00Z` }))))
            await query(supabase.from('weekly_lineups').delete().eq('league_id', variant.league))
            await query(supabase.from('weekly_lineups').insert(games.flatMap((_, index) => players.map((player, side) => ({
              player_id: player, league_id: variant.league, league_season_id: variant.season, member_id: variant.members[side === 2 ? 1 : 0],
              week_number: index + 1, game_date: addDays(first, index * 7 + 2), slot_type: side === 1 ? 'BE' as const : 'PG' as const, is_auto_set: false,
            })))))
            await query(supabase.from('matchups').insert({ id: variant.matchup, league_id: variant.league, league_season_id: variant.season,
              week_number: 1, end_week_number: weeks === 2 ? 2 : null, matchup_type: weeks === 2 ? 'playoff_final' : 'regular_season',
              playoff_round: weeks === 2 ? 1 : null, home_member_id: variant.members[0], away_member_id: variant.members[1] }))
          }
          const snapshot = async (variant: typeof variants[number]) => {
            const matchup = await query(supabase.from('matchups').select('home_points,away_points,home_max_possible_points,away_max_possible_points,is_finalized,winner_member_id')
              .eq('id', variant.matchup).single())
            const standings = await query(supabase.from('standings').select('member_id,week_number,wins,losses,ties,points_for,points_against,max_possible_points')
              .eq('league_season_id', variant.season).order('week_number'))
            return { ...matchup, winner_member_id: variant.members.findIndex(id => id === matchup.winner_member_id),
              standings: standings.map(row => ({ ...row, member_id: variant.members.findIndex(id => id === row.member_id) }))
                .sort((a, b) => a.week_number - b.week_number || a.member_id - b.member_id) }
          }
          const stale = (variant: typeof variants[number]) => query(supabase.rpc('get_stale_score_weeks', { p_league_season_id: variant.season, p_through_week: 1 }))
          const capture = (variant: typeof variants[number]) => query(supabase.rpc('capture_score_inputs', { p_league_season_id: variant.season, p_week_number: 1 }))
          const run = async (variant: typeof variants[number]) => {
            maxRosterReads = 0
            publications = []
            await variant.module.syncScores(variant.league, referenceDate, { recoverStats: false })
            const publication = publications.flatMap(payload => payload.p_matchups as Record<string, unknown>[])
              .find(row => row.id === variant.matchup)
            assert.ok(publication, `${variant.label} must publish through the actual atomic finalizer`)
            return { maxRosterReads, publication: { home_points: publication.home_points, away_points: publication.away_points,
              home_max_possible_points: publication.home_max_possible_points, away_max_possible_points: publication.away_max_possible_points,
              winner: variant.members.findIndex(id => id === publication.winner_member_id) }, snapshot: await snapshot(variant) }
          }
          const initial = []
          const tokens = []
          const warm = []
          for (const variant of variants) {
            const scored = await run(variant)
            assert.equal(scored.snapshot.is_finalized, true)
            assert.equal(Number(scored.snapshot.home_max_possible_points), 30 * weeks)
            assert.equal(Number(scored.snapshot.away_max_possible_points), 20 * weeks)
            assert.deepEqual(await stale(variant), [])
            const captured = await capture(variant)
            assert.ok(captured && typeof captured === 'object' && !Array.isArray(captured))
            assert.ok(`nba:${year}:${weeks}` in captured)
            assert.ok(`lineup:${variant.season}:${weeks}` in captured)
            tokens.push(captured)
            initial.push(scored.snapshot)
            const replay = await run(variant)
            if (variant.label === 'after') assert.equal(replay.maxRosterReads, 0, 'Fresh certificate must exercise the reuse path')
            assert.deepEqual(replay.snapshot, scored.snapshot)
            warm.push(replay.maxRosterReads)
          }
          assert.deepEqual(initial[0], initial[1])
          const lastDate = addDays(first, (weeks - 1) * 7 + 2)
          if (correction === 'stat') {
            await query(supabase.from('player_game_stats').update({ points: 50 }).eq('game_id', games.at(-1)!).eq('player_id', players[1]))
          } else {
            for (const variant of variants) {
              await query(supabase.from('roster_transactions').insert({ league_id: variant.league, league_season_id: variant.season,
                member_id: variant.members[0], player_id: players[1], transaction_type: 'ir_designate', occurred_at: `${lastDate}T12:00:00Z` }))
              await query(supabase.from('roster_players').update({ is_on_ir: true }).eq('league_season_id', variant.season).eq('player_id', players[1]))
            }
          }
          const corrected = []
          const changedScopes = []
          for (const [index, variant] of variants.entries()) {
            const changedToken = await capture(variant)
            assert.notDeepEqual(changedToken, tokens[index], 'A last-week input changes the start-week token')
            assert.ok(changedToken && typeof changedToken === 'object' && !Array.isArray(changedToken))
            const priorToken = tokens[index]
            const changed = Object.keys(changedToken).filter(key => JSON.stringify(changedToken[key]) !== JSON.stringify(priorToken[key])).sort()
            if (correction === 'stat') assert.ok(changed.includes(`nba:${year}:${weeks}`))
            changedScopes.push(changed)
            assert.deepEqual(await stale(variant), [{ week_number: 1 }], 'The span is returned under its START week')
            const scored = await run(variant)
            assert.equal(scored.maxRosterReads, weeks, 'The scorer must recompute maxima for every covered week')
            const expected = 30 * (weeks - 1) + (correction === 'stat' ? 50 : 10)
            assert.equal(Number(scored.snapshot.home_max_possible_points), expected)
            assert.equal(Number(scored.snapshot.away_max_possible_points), 20 * weeks)
            assert.equal(Number(scored.snapshot.home_points), 10 * weeks)
            assert.equal(Number(scored.snapshot.away_points), 20 * weeks)
            assert.equal(Number(scored.publication.home_max_possible_points), expected)
            assert.deepEqual(await stale(variant), [])
            corrected.push(scored)
          }
          assert.deepEqual(corrected[0].snapshot, corrected[1].snapshot)
          assert.deepEqual(corrected[0].publication, corrected[1].publication)
          const result = { weeks, correction, correctionDate: lastDate, tokenCoversLastWeek: true, staleStartWeek: 1,
            initialHomeMax: 30 * weeks, correctedHomeMax: corrected[1].snapshot.home_max_possible_points,
            changedScopes,
            warmMaxRosterReads: warm, correctedMaxRosterReads: corrected.map(value => value.maxRosterReads),
            publishedValuesMatchBefore: true, corrected }
          results.push(result)
          console.log(JSON.stringify(result))
        } finally {
          for (const variant of variants) await query(supabase.from('leagues').delete().eq('id', variant.league))
          await query(supabase.from('player_game_stats').delete().in('game_id', games))
          await query(supabase.from('nba_games').delete().in('id', games))
          await query(supabase.from('players').delete().in('id', players))
          await query(supabase.from('season_weeks').delete().in('id', weekIds))
        }
      }
    }
    if (out) await Deno.writeTextFile(out, JSON.stringify({ recordedAt: new Date().toISOString(), hashes, results }, null, 2) + '\n')
  } finally {
    for (const user of users) {
      const { error } = await supabase.auth.admin.deleteUser(user)
      if (error) throw new Error(error.message)
    }
    globalThis.fetch = nativeFetch
    await sql.end()
  }
})
