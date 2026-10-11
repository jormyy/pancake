import { strict as assert } from 'node:assert'

const api = Deno.env.get('SUPABASE_URL')
assert.ok(api && ['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  assert.equal(url.origin, api, 'Only the isolated database may receive requests')
  return await nativeFetch(input, init)
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const query = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10)
try {
  const token = crypto.randomUUID().replaceAll('-', '')
  const league = crypto.randomUUID(), season = crypto.randomUUID(), game = crypto.randomUUID()
  const members = Array.from({ length: 4 }, () => crypto.randomUUID())
  const players = Array.from({ length: 4 }, () => crypto.randomUUID())
  const weekIds = Array.from({ length: 5 }, () => crypto.randomUUID())
  const users: string[] = []
  let year = 0, weeksInserted = false
  const first = addDays(today, -42), gameDate = addDays(first, 2)

  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = 3000 + crypto.getRandomValues(new Uint32Array(1))[0] % 5000
      const rows = await query(supabase.from('season_weeks').select('id').eq('season_year', candidate))
      const seasons = await query(supabase.from('league_seasons').select('id').eq('season_year', candidate))
      if (!rows.length && !seasons.length) { year = candidate; break }
    }
    assert.ok(year)
    for (let side = 0; side < 4; side++) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: `rollover-standings-${token}-${side}@example.test`, password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
        user_metadata: { username: `standings_${token.slice(0, 12)}_${side}`, display_name: 'Synthetic rollover standings' },
      })
      if (error) throw new Error(error.message)
      assert.ok(data.user); users.push(data.user.id)
    }
    await query(supabase.from('leagues').insert({ id: league, slug: `rollover-${token}`, name: 'Synthetic rollover standings',
      commissioner_id: users[0], status: 'active', scoring_settings: { points: 1 }, playoff_start_week: 2, }))
    await query(supabase.from('league_members').insert(members.map((id, side) => ({ id, league_id: league,
      user_id: users[side], role: side ? 'manager' as const : 'commissioner' as const, team_name: `Overlap ${side}` }))))
    await query(supabase.from('league_seasons').insert({ id: season, league_id: league, season_year: year, is_current: true }))
    await query(supabase.from('season_weeks').insert(weekIds.map((id, index) => ({ id, season_year: year, week_number: index + 1,
      week_start: addDays(first, index * 7), week_end: addDays(first, index * 7 + 6) }))))
    weeksInserted = true
    await query(supabase.from('players').insert(players.map((id, index) => ({ id, first_name: 'Synthetic',
      last_name: `Consume ${token}-${index}`, position: 'PG' as const, eligible_positions: ['PG'], nba_team: 'XCO' }))))
    await query(supabase.from('roster_players').insert(players.map((id, index) => ({ player_id: id,
      member_id: members[index], league_id: league, league_season_id: season, acquired_via: 'draft', acquired_at: `${addDays(first, -7)}T12:00:00Z` }))))
    await query(supabase.from('weekly_lineups').delete().eq('league_id', league))
    await query(supabase.from('nba_games').insert({ id: game, nba_game_id: `002-consume-${token}`, season_year: year,
      week_number: 1, game_date: gameDate, game_time: `${gameDate}T19:00:00Z`, home_team: 'XCO', away_team: 'XCP', status: 'Final', stats_synced_at: new Date().toISOString() }))
    await query(supabase.from('matchups').insert([0,2].map(i=>({league_id:league,league_season_id:season,week_number:1,matchup_type:'regular_season' as const,home_member_id:members[i],away_member_id:members[i+1]}))))
    await query(supabase.from('matchups').update({ end_week_number: null }).eq('league_season_id', season))
    const homes = new Set([members[0],members[2]])
    await query(supabase.from('player_game_stats').insert(players.map((id, index) => ({ player_id: id, game_id: game,
      season_year: year, week_number: 1, game_date: gameDate, points: homes.has(members[index]) ? 10 : 5, did_not_play: false }))))
    await query(supabase.from('weekly_lineups').insert(players.map((id, index) => ({ player_id: id,
      member_id: members[index], league_id: league, league_season_id: season, week_number: 1, game_date: gameDate, slot_type: 'PG' as const, is_auto_set: false }))))
    await syncScores(league)
    assert.equal((await query(supabase.from('standings').select('member_id').eq('league_season_id',season))).length,4)
    await query(supabase.rpc('generate_playoff_bracket_atomic',{p_league_id:league}))
    // The production generate boundary sets this status after creating the bracket.
    await query(supabase.from('leagues').update({status:'playoffs'}).eq('id',league))
    await syncScores(league)
    await query(supabase.rpc('advance_playoff_bracket_atomic',{p_league_id:league}))
    await syncScores(league)
    await query(supabase.from('matchups').update({finalized_at:new Date(Date.now()-49*3600000).toISOString()}).eq('league_season_id',season).eq('matchup_type','playoff_final'))
    const oldStandings=await query(supabase.from('standings').select('member_id,wins,losses,points_for,points_against').eq('league_season_id',season).eq('week_number',1))
    const finalBefore=await query(supabase.from('matchups').select('*').eq('league_season_id',season).eq('matchup_type','playoff_final').single())
    await query(supabase.from('player_game_stats').update({points:0}).eq('game_id',game).eq('player_id',players[0]))
    const result=await query(supabase.rpc('apply_season_boundary_after_grace',{p_league_id:league,p_league_season_id:season,p_action:'rollover'}))
    const beforeReplay=result.applied?await query(supabase.from('waiver_priorities').select('member_id,priority').eq('league_id',league).neq('league_season_id',season).order('priority')):[]
    await syncScores(league)
    const corrected=await query(supabase.from('standings').select('member_id,wins,losses,points_for,points_against').eq('league_season_id',season).eq('week_number',1))
    const expected=[...corrected].sort((a:any,b:any)=>Number(a.wins)-Number(b.wins)||Number(a.points_for)-Number(b.points_for)||Number(b.losses)-Number(a.losses)||Number(b.points_against)-Number(a.points_against)||a.member_id.localeCompare(b.member_id)).map((row:any)=>row.member_id)
    console.log(JSON.stringify({rolloverBeforeReplay:result,oldStandings,corrected,beforeReplay,expected,limit:'49-hour final grace age is an explicit synthetic timestamp'}))
    assert.equal(result.applied,false,'Rollover must wait for changed regular standings used by waiver priority')
    const finalAfter = await query(supabase.from('matchups').select('*').eq('id',finalBefore.id).single())
    const { score_read_started_at: readBefore, ...decisionBefore } = finalBefore
    const { score_read_started_at: readAfter, ...decisionAfter } = finalAfter
    assert.deepEqual(decisionAfter,decisionBefore,'Regular correction must preserve every final field except refreshed read provenance')
    assert.ok(Date.parse(readAfter) >= Date.parse(readBefore), 'A no-op final score pass may refresh read provenance')
    const afterReplay=await query(supabase.rpc('apply_season_boundary_after_grace',{p_league_id:league,p_league_season_id:season,p_action:'rollover'}))
    assert.equal(afterReplay.applied,true)
    const priorities=await query(supabase.from('waiver_priorities').select('member_id,priority').eq('league_id',league).neq('league_season_id',season).order('priority'))
    assert.deepEqual(priorities.map((row:any)=>row.member_id),expected)
    console.log(JSON.stringify({ blockedBeforeReplay: true, correctedPriority: true, finalDecisionAndGraceUnchanged: true }))
  } finally {
    await query(supabase.from('leagues').delete().eq('id', league))
    await query(supabase.from('player_game_stats').delete().eq('game_id', game))
    await query(supabase.from('nba_games').delete().eq('id', game))
    await query(supabase.from('players').delete().in('id', players))
    if (weeksInserted) await query(supabase.from('season_weeks').delete().in('id', weekIds))
    for (const user of users) {
      const { error } = await supabase.auth.admin.deleteUser(user)
      if (error) throw new Error(error.message)
    }
    console.log(JSON.stringify({ cleanup: 'complete' }))
  }
} finally {
  globalThis.fetch = nativeFetch
}
