import { connect } from './request-driver.ts'

const url = Deno.env.get('SUPABASE_DB_URL') ?? 'postgresql://postgres:postgres@127.0.0.1:56322/postgres'
const owner = connect(url)
const manual = connect(url)
const automatic = connect(url)
const user = crypto.randomUUID()
const league = crypto.randomUUID()
const season = crypto.randomUUID()
const member = crypto.randomUUID()
const player = crypto.randomUUID()
const game = crypto.randomUUID()
const token = crypto.randomUUID()
const application = `tipoff-concurrent-${token}`
let applying: Promise<{ error?: unknown }> | undefined
let fixture = false
const [window] = await owner`SELECT now()+interval '110 seconds' AS tipoff,(now() AT TIME ZONE 'America/New_York')::date AS date`
try {
  await owner.begin(async (sql) => {
    const [existing] = await sql`SELECT EXISTS(SELECT 1 FROM public.season_weeks WHERE season_year=2198) AS present`
    if (existing.present) throw new Error('The concurrency fixture year is already in use.')
    await sql`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(${user},${`${user}@example.test`},${sql.json({ username: user })})`
    await sql`INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size) VALUES(${league},'Concurrent lineup',${league},${user},'active',12)`
    await sql`INSERT INTO public.league_members(id,league_id,user_id,role) VALUES(${member},${league},${user},'commissioner')`
    await sql`INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${season},${league},2198,true)`
    await sql`INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(2198,1,${window.date},${window.date}::date+6)`
    await sql`INSERT INTO public.players(id,first_name,last_name,nba_team,position,eligible_positions) VALUES(${player},'Concurrent','Guard','TC1','PG',ARRAY['PG'])`
    await sql`INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(${league},${season},${member},${player},'draft')`
    await sql`DELETE FROM public.lineup_slot_templates WHERE league_id=${league}`
    await sql`INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(${league},'PG',1)`
    await sql`INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
      VALUES(${game},'0029899999',2198,1,${window.date},'TC1','TC2','Scheduled',${window.tipoff})`
    await sql`INSERT INTO public.lineup_optimizer_settings(league_id,league_season_id,member_id,enabled) VALUES(${league},${season},${member},true)
      ON CONFLICT (league_id,league_season_id,member_id) DO NOTHING`
    await sql`INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date,status,token,lease_until)
      VALUES(${window.tipoff},${window.date},'running',${token},now()+interval '45 seconds')`
  })
  fixture = true
  await automatic`SELECT set_config('application_name',${application},false),set_config('statement_timeout','10s',false)`
  const assignments = [{ player_id: player, slot_type: 'PG', week_number: 1, is_auto_set: true }]
  await manual.begin(async (sql) => {
    await sql`SELECT public.assert_current_league_season_for_lineup(${league},${season})`
    await sql`SELECT private.assert_roster_within_active_limit(${league},${season},${member})`
    applying = automatic`SELECT public.apply_pre_tipoff_lineup(${window.tipoff},${token},${league},${season},${member},${automatic.json(assignments)})`
      .then(() => ({}), (error: unknown) => ({ error }))
    let waiting = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const [activity] = await owner`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${application} AND wait_event_type='Lock') AS waiting`
      if (activity.waiting) { waiting = true; break }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (!waiting) throw new Error('The automatic writer never overlaps the manual transaction.')
    await sql`SELECT public.auto_set_lineup_service_atomic(${member},${league},${season},${window.date},${sql.json(assignments)})`
  })
  const result = await applying!
  if (result.error) throw result.error
  const rows = await owner`SELECT player_id,slot_type FROM public.weekly_lineups WHERE member_id=${member} AND game_date=${window.date}`
  const receipts = await owner`SELECT member_id FROM public.lineup_tipoff_members WHERE tipoff_at=${window.tipoff}`
  if (rows.length !== 1 || rows[0].player_id !== player || rows[0].slot_type !== 'PG' || receipts.length !== 1) {
    throw new Error('Concurrent manual and automatic writes lose or duplicate a legal starter.')
  }
  console.log('Concurrent manual and pre-tipoff writes complete without deadlock and preserve one legal starter and one receipt.')
} finally {
  if (applying) await applying
  if (fixture) {
    await owner`DELETE FROM public.lineup_tipoff_members WHERE tipoff_at=${window.tipoff}`
    await owner`DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at=${window.tipoff}`
    await owner`DELETE FROM public.leagues WHERE id=${league}`
    await owner`DELETE FROM public.players WHERE id=${player}`
    await owner`DELETE FROM public.nba_games WHERE id=${game}`
    await owner`DELETE FROM public.season_weeks WHERE season_year=2198`
    await owner`DELETE FROM auth.users WHERE id=${user}`
  }
  await Promise.all([owner.end(), manual.end(), automatic.end()])
}
