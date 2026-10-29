const databaseUrl = Deno.env.get('SUPABASE_DB_URL') ?? ''
if (databaseUrl !== 'postgresql://postgres:postgres@127.0.0.1:61522/postgres') throw new Error('Private revaluation stack required')
const command = async (name: string, args: string[]) => {
  const output = await new Deno.Command(name, { args, stdout: 'piped', stderr: 'piped' }).output()
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr))
  return new TextDecoder().decode(output.stdout).trim()
}
const sql = (query: string) => command('psql', [databaseUrl, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', query])
const status = JSON.parse(await command('supabase', ['status', '-o', 'json']))
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:61521')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', status.SECRET_KEY ?? status.SERVICE_ROLE_KEY)
const { refreshViews } = await import('../../supabase/functions/refresh-views/work.ts')
const seasonId = '95b790d1-ffda-436b-ac7d-875e198dc6d9'
const leagueId = await sql(`SELECT league_id FROM public.league_seasons WHERE id='${seasonId}'`)
if (!leagueId) throw new Error('Production-shaped season missing')
await sql(`UPDATE private.screen_refresh_queue SET dirty=false,claimed_at=NULL,claim_token=NULL,claimed_version=NULL,available_at=now();
  SELECT private.refresh_queue_screen_views('${leagueId}');`)
await refreshViews()
const rows = []
const after = Deno.args.includes('--after')
const tradeModulePath = '../../supabase/functions/refresh-views/trades.ts'
const tradeWorker = after ? await import(tradeModulePath) : null
const drainTrades = async () => {
  let revalued = 0
  for (let batches = 0; batches < 100; batches++) {
    const jobs = JSON.parse(await sql(`SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'payload',payload) ORDER BY id),'[]')
      FROM private.work_items WHERE kind IN ('trade-revaluation-scan','trade-revaluation-check','trade-revaluation')
        AND status='pending' AND (league_id='${leagueId}' OR payload->>'seasonId'='${seasonId}')`))
    if (!jobs.length) return revalued
    for (const job of jobs) {
      const result = await tradeWorker.refreshTradeWork(job.payload)
      if (job.kind === 'trade-revaluation') revalued += result.rowsAffected
      await sql(`UPDATE private.work_items SET status='succeeded',completed_at=now() WHERE id=${job.id}`)
    }
  }
  throw new Error('Trade work did not drain')
}
if (after) await drainTrades()
for (const sample of [1, 2, 3]) for (const change of ['lineup', 'stat', 'proposal']) {
  let cleanup: string
  if (change === 'lineup') {
    const row = JSON.parse(await sql(`SELECT to_jsonb(row) FROM public.weekly_lineups row WHERE league_season_id='${seasonId}' ORDER BY id LIMIT 1`))
    await sql(`SET session_replication_role=replica; UPDATE public.weekly_lineups SET slot_type=CASE WHEN slot_type='BE' THEN 'UTIL'::public.roster_slot_type ELSE 'BE'::public.roster_slot_type END WHERE id='${row.id}'; SET session_replication_role=origin;`)
    cleanup = `SET session_replication_role=replica; UPDATE public.weekly_lineups SET slot_type='${row.slot_type}' WHERE id='${row.id}'; SET session_replication_role=origin;`
  } else if (change === 'stat') {
    const row = JSON.parse(await sql(`SELECT to_jsonb(stat) FROM public.player_game_stats stat JOIN public.trade_items item ON item.player_id=stat.player_id JOIN public.trades trade ON trade.id=item.trade_id WHERE trade.league_season_id='${seasonId}' AND trade.status='pending' AND stat.season_year=(SELECT season_year FROM public.league_seasons WHERE id='${seasonId}') ORDER BY stat.id LIMIT 1`))
    await sql(`UPDATE public.player_game_stats SET points=COALESCE(points,0)+1 WHERE id='${row.id}'`)
    cleanup = `UPDATE public.player_game_stats SET points=${row.points ?? 'NULL'} WHERE id='${row.id}'`
  } else {
    const tradeId = await sql(`SET session_replication_role=replica;
      WITH source AS (SELECT * FROM public.trades WHERE league_season_id='${seasonId}' AND status='pending' ORDER BY id LIMIT 1),
      added AS (INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status)
        SELECT league_id,league_season_id,proposer_member_id,recipient_member_id,'pending' FROM source RETURNING id)
      INSERT INTO public.trade_items(league_id,trade_id,from_member_id,to_member_id,player_id,pick_id,faab_amount,side)
        SELECT source.league_id,added.id,item.from_member_id,item.to_member_id,item.player_id,item.pick_id,item.faab_amount,item.side
        FROM added,source JOIN public.trade_items item ON item.trade_id=source.id RETURNING trade_id;
      SET session_replication_role=origin;`)
    cleanup = `SET session_replication_role=replica; DELETE FROM public.trade_items WHERE trade_id='${tradeId.split('\n')[0]}'; DELETE FROM public.trades WHERE id='${tradeId.split('\n')[0]}'; SET session_replication_role=origin;`
  }
  await sql(`UPDATE private.screen_refresh_queue SET dirty=false,claimed_at=NULL,claim_token=NULL,claimed_version=NULL,available_at=now() WHERE league_season_id='${seasonId}'; SELECT private.refresh_queue_screen_views('${leagueId}'); SELECT extensions.pg_stat_statements_reset();`)
  const started = performance.now()
  const result = await refreshViews()
  const durationMs = performance.now() - started
  if (result.rowsAffected !== 1 || result.failure) throw new Error(`Refresh failed: ${JSON.stringify(result)}`)
  const screenDatabaseMs = Number(await sql(`SELECT COALESCE(sum(total_exec_time),0) FROM extensions.pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%'`))
  const revaluations = after ? await drainTrades() : Number(await sql(`SELECT COALESCE(sum(calls),0) FROM extensions.pg_stat_statements WHERE query LIKE '%get_trade_revaluation_inputs%'`))
  const databaseMs = Number(await sql(`SELECT COALESCE(sum(total_exec_time),0) FROM extensions.pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%'`))
  rows.push({ change, sample, durationMs, screenDatabaseMs, databaseMs, revaluations, result })
  await sql(cleanup)
  if (after) {
    await sql(`UPDATE private.screen_refresh_queue SET dirty=false,available_at=now() WHERE league_season_id='${seasonId}'; SELECT private.refresh_queue_screen_views('${leagueId}')`)
    const restored = await refreshViews()
    if (restored.rowsAffected !== 1 || restored.failure) throw new Error('Restoring the benchmark baseline failed')
    await drainTrades()
  }
}
const median = (values: number[]) => [...values].sort((left, right) => left - right)[1]
console.log(JSON.stringify(['lineup', 'stat', 'proposal'].map(change => {
  const samples = rows.filter(row => row.change === change)
  if (new Set(samples.map(row => row.revaluations)).size !== 1) throw new Error('Revaluation counts vary between samples')
  return { change, sampleCount: samples.length, durationMs: median(samples.map(row => row.durationMs)),
    screenDatabaseMs: median(samples.map(row => row.screenDatabaseMs)), databaseMs: median(samples.map(row => row.databaseMs)),
    revaluations: samples[0].revaluations, result: samples[0].result, samples }
}), null, 2))
