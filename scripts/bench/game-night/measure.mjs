import assert from 'node:assert/strict'
import { command, id, quote } from './common.mjs'
import { stateAt } from './fixture.mjs'

export const graderVersion = 'game-night-v4'

export async function counters(stack) {
  const output = (await command('docker', ['exec', stack.container, 'sh', '-c', 'cat /proc/vmstat; echo MEMINFO; cat /proc/meminfo; echo CGROUP; cat /sys/fs/cgroup/memory.stat; echo CURRENT; cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.swap.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events /proc/swaps; echo IO; cat /sys/fs/cgroup/io.stat'])).stdout
  const [host, rest] = output.split('CGROUP\n')
  const [vm,meminfo]=host.split('MEMINFO\n')
  const [cg, current] = rest.split('CURRENT\n')
  const fields = text => Object.fromEntries(text.trim().split('\n').map(line => line.trim().split(/\s+/)).filter(row => row.length === 2).map(([key, value]) => [key, Number(value)]))
  const [memory,ioText] = current.split('IO\n')
  const lines = memory.split('\n')
  const io = Object.fromEntries(['rbytes','wbytes','rios','wios'].map(key=>[key,0]))
  for(const line of (ioText ?? '').trim().split('\n')) for(const field of line.split(/\s+/).slice(1)) {
    const [key,value]=field.split('=')
    if(Object.hasOwn(io,key))io[key]+=Number(value)
  }
  const inventory = (await command('docker', ['ps', '--format', '{{json .}}'])).stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const foreignContainers = inventory.filter(row => !row.Labels?.includes(`com.supabase.cli.project=${stack.project}`)).map(row => ({ id: row.ID, name: row.Names, status: row.Status }))
  const memoryValue=name=>Number(meminfo.match(new RegExp(`^${name}:\\s+(\\d+) kB`,'m'))?.[1])*1024
  return { at: Date.now(), vm: fields(vm), vmMemory:{availableBytes:memoryValue('MemAvailable'),freeBytes:memoryValue('MemFree'),totalBytes:memoryValue('MemTotal')}, cgroup: fields(cg), io, current: Number(lines[0]), swapCurrent: Number(lines[1]), peak: Number(lines[2]), events: fields(lines.slice(3).join('\n')), swaps: lines.filter(line => line.includes('/var/lib/swap')), foreignContainers }
}

export async function snapshot(stack) {
  return JSON.parse(await stack.sql(`SELECT json_build_object(
    'at',clock_timestamp(),'database',(SELECT row_to_json(d) FROM (SELECT sessions,xact_commit,xact_rollback,blks_read,blks_hit,temp_bytes,stats_reset FROM pg_stat_database WHERE datname=current_database())d),
    'storage',json_build_object('databaseBytes',pg_database_size(current_database()),'tables',(SELECT json_agg(t) FROM (SELECT schemaname,relname,pg_total_relation_size(relid) bytes,n_live_tup,n_dead_tup,n_tup_ins,n_tup_upd,n_tup_del FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 25)t)),
    'wal',(SELECT row_to_json(w) FROM pg_stat_wal w),
    'statementInfo',(SELECT row_to_json(i) FROM extensions.pg_stat_statements_info i),
    'settings',(SELECT json_agg(s) FROM (SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','max_connections','effective_cache_size','huge_pages','jit','max_parallel_workers_per_gather','wal_buffers','pg_stat_statements.track','track_functions'))s),
    'indexes',(SELECT json_agg(i) FROM (SELECT indexrelname,relname,idx_scan,idx_tup_read,idx_tup_fetch,pg_relation_size(indexrelid) bytes FROM pg_stat_user_indexes WHERE relname LIKE 'player_game_stats%')i),
    'statements',(SELECT coalesce(json_agg(s),'[]') FROM (SELECT queryid::text,userid::text,dbid::text,toplevel,query,calls,total_exec_time,shared_blks_read,shared_blks_hit,shared_blks_dirtied,wal_bytes::text,rows FROM extensions.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()))s),
    'functions',(SELECT coalesce(json_agg(f),'[]') FROM (SELECT schemaname,funcname,calls,total_time,self_time FROM pg_stat_user_functions)f),
    'connections',(SELECT coalesce(json_agg(c),'[]') FROM (SELECT application_name,usename,client_addr::text,backend_type,count(*) FROM pg_stat_activity GROUP BY 1,2,3,4)c),
    'work',(SELECT coalesce(json_agg(w),'[]') FROM (SELECT id,kind,status,attempts,created_at,completed_at,last_error FROM private.work_items)w),
    'liveForecasts',(SELECT coalesce(json_agg(f),'[]') FROM (SELECT cache.matchup_id,cache.calculated_at,cache.valid_until FROM public.matchup_forecasts cache JOIN public.matchups matchup ON matchup.id=cache.matchup_id WHERE matchup.league_id='ab000000-0000-4000-8000-000000000001' AND matchup.week_number=2)f),
    'cron',(SELECT coalesce(json_agg(c),'[]') FROM (SELECT runid,jobid,status,start_time,end_time,return_message FROM cron.job_run_details)c),
    'invocations',(SELECT coalesce(json_agg(i),'[]') FROM (SELECT inv.id,inv.function_name,coalesce(work.kind,inv.function_name) kind,inv.queued_at,inv.worker_started_at,inv.worker_finished_at,inv.worker_status,inv.error_message FROM public.edge_invocations inv LEFT JOIN private.work_items work ON work.id=inv.work_item_id)i)
  )`))
}

export function statementDeltas(before, after) {
  const key = row => `${row.queryid}/${row.userid}/${row.dbid}/${row.toplevel}`
  const old = new Map(before.map(row => [key(row), row]))
  return after.map(row => {
    const previous = old.get(key(row)) ?? {}
    const delta = Object.fromEntries(['calls','total_exec_time','shared_blks_read','shared_blks_hit','shared_blks_dirtied','wal_bytes','rows'].map(name => [name, Number(row[name] ?? 0) - Number(previous[name] ?? 0)]))
    assert.ok(Object.values(delta).every(value => value >= -0.001), 'Statement counters reset inside the timed window')
    const normalized = row.query.replaceAll('"', '')
    const functionCall = [...normalized.matchAll(/\b(?:public|private)\.([a-z_0-9]+)\s*\(/ig)].find(match => !/\b(?:INTO|UPDATE)\s*$/i.test(normalized.slice(0, match.index)))
    const functionName = functionCall?.[1] ?? (/\b(?:INSERT|UPDATE|DELETE)\b/i.test(normalized) ? 'unattributed-write' : 'unattributed-read')
    return { queryid: row.queryid, userid: row.userid, toplevel: row.toplevel, query: row.query, function: functionName, ...delta }
  }).filter(row => row.calls > 0)
}

export function groupStatements(rows, minutes) {
  const groups = new Map()
  for (const row of rows) {
    const group = groups.get(row.function) ?? { function: row.function, calls: 0, execSecondsPerMinute: 0, walBytesPerMinute: 0, reads: 0, queryids: new Set() }
    group.calls += row.calls
    group.execSecondsPerMinute += row.total_exec_time / 1000 / minutes
    group.walBytesPerMinute += row.wal_bytes / minutes
    group.reads += row.shared_blks_read
    group.queryids.add(row.queryid)
    groups.set(row.function, group)
  }
  return [...groups.values()].map(group => ({ ...group, queryids: [...group.queryids] })).sort((a, b) => b.execSecondsPerMinute - a.execSecondsPerMinute)
}

export const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] : null

export async function readScores(stack) {
  return JSON.parse(await stack.sql("SELECT coalesce(json_agg(g),'[]') FROM (SELECT id,home_score,away_score,status,stats_synced_at FROM public.nba_games WHERE nba_game_id LIKE '00299%')g"))
}

export function fantasyAt(slate, seconds) {
  const players = new Map(stateAt(slate, seconds).flatMap(game => [...game.homeTeam.players, ...game.awayTeam.players]).map(player => [player.player_id, player.statistics]))
  const points = member => Math.round(Array.from({ length: 8 }, (_, i) => players.get(id(1000 + (member - 1) * 20 + i + 1))).filter(Boolean).reduce((sum, row) => sum + row.points + row.reboundsTotal * 1.2 + row.assists * 1.5 + row.steals * 3 + row.blocks * 3 - row.turnovers, 0) * 100) / 100
  return Array.from({ length: 5 }, (_, i) => ({ home_member_id: id(201 + i), away_member_id: id(206 + i), home_points: points(i + 1), away_points: points(i + 6) }))
}

export async function readFantasy(stack) {
  return JSON.parse(await stack.sql("SELECT coalesce(json_agg(m),'[]') FROM (SELECT home_member_id,away_member_id,home_points,away_points FROM public.matchups WHERE league_id='ab000000-0000-4000-8000-000000000001' AND week_number=2)m"))
}

const fields = { points: 'points', rebounds: 'reboundsTotal', offensive_rebounds: 'reboundsOffensive', defensive_rebounds: 'reboundsDefensive', assists: 'assists', steals: 'steals', blocks: 'blocks', turnovers: 'turnovers', personal_fouls: 'foulsPersonal', field_goals_made: 'fieldGoalsMade', field_goals_attempted: 'fieldGoalsAttempted', three_pointers_made: 'threePointersMade', three_pointers_attempted: 'threePointersAttempted', free_throws_made: 'freeThrowsMade', free_throws_attempted: 'freeThrowsAttempted', plus_minus: 'plusMinusPoints' }

function compareGames(expected,scores,stats) {
  const failures = []
  for (const game of expected) {
    const actual = scores.find(row => row.id === game.id)
    for (const [key, value] of Object.entries({ home_score: game.homeTeam.score, away_score: game.awayTeam.score, status: game.gameStatus === 3 ? 'Final' : 'InProgress' })) if (actual?.[key] !== value) failures.push({ game: game.nba_game_id, field: key, expected: value, actual: actual?.[key] ?? null })
    for (const player of [...game.homeTeam.players, ...game.awayTeam.players]) {
      const row = stats.find(row => row.game_id === game.id && row.player_id === player.player_id)
      for (const [column, key] of Object.entries(fields)) if (Number(row?.[column]) !== player.statistics[key]) failures.push({ game: game.nba_game_id, player: player.personId, field: column, expected: player.statistics[key], actual: row?.[column] ?? null })
      if (!row || Number(row.minutes_played) !== 25 || row.did_not_play !== false) failures.push({ game: game.nba_game_id, player: player.personId, field: 'appearance', actual: row ?? null })
      const doubles = ['points','reboundsTotal','assists','steals','blocks'].filter(key => player.statistics[key] >= 10).length
      if (row && (row.double_double !== (doubles >= 2) || row.triple_double !== (doubles >= 3))) failures.push({ game: game.nba_game_id, player: player.personId, field: 'double/triple double' })
    }
  }
  if (stats.length !== expected.length * 24) failures.push({ field: 'statRowCount', expected: expected.length * 24, actual: stats.length })
  return failures
}

export async function finalGameCheck(stack,slate,seconds,gameIds) {
  assert.ok(gameIds.length>0)
  const expected=stateAt(slate,seconds).filter(game=>gameIds.includes(game.id))
  assert.ok(expected.length===gameIds.length && expected.every(game=>game.gameStatus===3))
  const scores=await readScores(stack)
  const stats=JSON.parse(await stack.sql(`SELECT coalesce(json_agg(s),'[]') FROM public.player_game_stats s WHERE s.game_id IN (${gameIds.map(quote).join(',')})`))
  const failures=compareGames(expected,scores,stats)
  return {passed:failures.length===0,games:expected.length,statRows:stats.length,failures}
}

export async function finalCheck(stack, slate, seconds) {
  const scores = await readScores(stack)
  const stats = JSON.parse(await stack.sql("SELECT coalesce(json_agg(s),'[]') FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id WHERE g.nba_game_id LIKE '00299%'"))
  const expected = stateAt(slate, seconds)
  const failures = compareGames(expected,scores,stats)
  const fantasy = await readFantasy(stack)
  for (const expected of fantasyAt(slate, seconds)) {
    const actual = fantasy.find(row => row.home_member_id === expected.home_member_id && row.away_member_id === expected.away_member_id)
    for (const key of ['home_points','away_points']) if (!actual || Number(actual[key]) !== expected[key]) {
      const failure={ field: `fantasy.${key}`, member: expected.home_member_id, expected: expected[key], actual: actual?.[key] ?? null }
      failures.push(failure)
    }
  }
  return { passed: failures.length === 0, games: expected.length, statRows: stats.length, fantasyMatchups: fantasy.length, failures }
}

export function workCheck({ statements, observedScoreChanges, workerStarts, cronRuns, minutes }) {
  const calls = name => statements.filter(row => row.function === name).reduce((sum, row) => sum + row.calls, 0)
  const saved = calls('save_live_feed_snapshot_atomic') + calls('save_live_game_stats_atomic') + calls('save_live_scoreboard_atomic') + calls('save_game_stats_atomic')
  const liveTicks = calls('get_live_poll_work')
  return { passed: saved >= minutes * 2 && observedScoreChanges >= minutes && workerStarts > 0, saved, liveTicks, observedScoreChanges, workerStarts, cronRuns, required: { saved: minutes * 2, observedScoreChanges: minutes, workerStarts: 1 }, diagnostic: { cronRuns } }
}
