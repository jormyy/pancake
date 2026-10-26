import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fixtureStore } from './fixtures.mjs'
import { fixtureDirectory, sha256 } from './common.mjs'
import { orderedActions, gameEndTime } from './snapshots.mjs'
import { sqlJson } from './local-stack.mjs'

const queueGuards = {
  'league-inventory-hint-drain': ['inventory', 'SELECT private.flush_league_inventory_hints(1000)'],
  'player-stats-hints': ['scores', 'SELECT private.flush_player_stats_hints()'],
  'nba-close-expired-nominations': ['drafts', 'SELECT public.invoke_close_expired_nominations_if_due()'],
  'nba-dispatch-stats-sync-jobs': ['stats', 'SELECT public.invoke_stats_sync_dispatch_if_due()'],
}

const normalize = value => value.replace(/[\s;]/g, '').toLowerCase()
const inspectedSources = {
  'public/invoke_process_trades_if_due.sql': 'e6104d557087d8a1ffdf9d3083af431433b01e904ff5e200b009c51e4850133e',
  'public/notif_scan_due_atomic.sql': 'ba6b8347b6b3b1dca62a8002bb61ba1be6fa418c238c7e10056a4d7700975f03',
  'private/notif_lineup_candidates.sql': '5ed18c3f1f12b13bb6eb062bf44ff785ec2c83e5dd0f917ac314c1a69338d179',
  'public/invoke_pre_tipoff_optimizer_if_due.sql': 'ee0b908bfe3c65cbcc58e610a4dc69f236d1b7f9cc37b51bc86d7a0c84da41f8',
  'public/invoke_close_expired_nominations_if_due.sql': '2538f48bff4d2c99e0b884747808f658217ee4931c2b3c6b9d894383e7ad536b',
  'public/invoke_stats_sync_dispatch_if_due.sql': '93369814de3cfa0abcbbb7ce47e8035fbe2b890aaeb59c99b7a90fb6746dd67c',
  'private/flush_player_stats_hints.sql': '7f253399400edc6b66d561e2d5fb1d330c3d1e64f10b5b49acf3590534aade4e',
  'private/flush_league_inventory_hints.sql': '3c3ccd941f5361932885bfbed999080bad3bcb2f6eeb286ba1ff43271e5178d0',
}

export function materialLiveTicks(games) {
  const ticks = new Set()
  const add = at => ticks.add(Math.ceil(at / 120000) * 120000)
  for (const game of games) {
    assert.ok(Number.isFinite(game.start) && Number.isFinite(game.end) && game.end >= game.start)
    for (const offset of [-240000, -120000, 0, 120000, 240000]) add(game.start + offset)
    for (const frame of game.frames) add(frame)
    for (const offset of [0, 120000, 1800000]) add(game.end + offset)
  }
  return ticks
}

export function compressionPolicy(ticks, receipt, readState) {
  let queues
  let notifyDirty = true
  let selected = []
  receipt.mode = 'material-frames-with-empty-queue-coalescing'
  receipt.scope = 'Reconstructed PBP frames, not archived live-provider telemetry; full final boxes and daily correction jobs remain required'
  receipt.coalesced = {}
  receipt.queueProofs = 0
  receipt.materialTicks = ticks.size
  return {
    begin() { notifyDirty = true; selected = [] },
    async refresh(at, workers) {
      queues = workers.nextAt == null ? await readState(at) : null
      if (queues) receipt.queueProofs++
      if (workers.nextAt != null || selected.some(job => !['notification-dispatch-minute', 'edge-invocation-reconcile', 'league-inventory-hint-drain', 'player-stats-hints'].includes(job.jobname))) notifyDirty = true
      else if (selected.some(job => job.jobname === 'notification-dispatch-minute')) notifyDirty = false
      selected = []
    },
    select(jobs, at, workers) {
      selected = jobs.filter(job => {
        let reason
        if (job.jobname === 'nba-live-poll' && normalize(job.command) === normalize('SELECT public.invoke_live_poll_if_due()') && !ticks.has(at) && at % 1800000 !== 0) reason = 'reconstructed-live-frame-sampling'
        const guard = queueGuards[job.jobname]
        if (guard && queues && workers.nextAt == null && queues[guard[0]] === false && normalize(job.command) === normalize(guard[1])) reason = 'empty-source-queue'
        if (queues && workers.nextAt == null && job.jobname === 'matchup-forecasts' && normalize(job.command) === normalize('SELECT public.invoke_matchup_forecasts_if_due()') && queues.forecasts === false && (queues.forecastExpires == null || at < queues.forecastExpires) && at % 900000 !== 0) reason = 'unchanged-unexpired-forecast-inputs'
        if (queues && workers.nextAt == null && Array.isArray(queues.tips)) {
          const tips = queues.tips.map(value => Date.parse(value))
          if (job.jobname === 'nba-lineup-optimizer' && normalize(job.command) === normalize('SELECT public.invoke_pre_tipoff_optimizer_if_due()') && tips.every(tip => at < tip - 120000 || at > tip + 60000)) reason = 'outside-tipoff-window'
          const clockBoundary = tips.some(tip => [tip - 7200000, tip, tip + 60000].some(value => Math.ceil(value / 60000) * 60000 === at))
          if (job.jobname === 'notification-dispatch-minute' && normalize(job.command) === normalize('SELECT public.invoke_process_trades_if_due()') && !notifyDirty && queues.notifications === false && queues.trades === false && queues.drafts === false && at % 900000 !== 0 && !clockBoundary) reason = 'unchanged-notification-inputs'
        }
        if (!reason) return true
        const key = `${job.jobname}:${reason}`
        receipt.coalesced[key] = (receipt.coalesced[key] ?? 0) + 1
        return false
      })
      return selected
    },
  }
}

export async function officialCompression(input, receipt) {
  receipt.inspectedSources = []
  for (const [file, expected] of Object.entries(inspectedSources)) {
    const actual = sha256(await readFile(`supabase/sql/functions/by-name/${file}`))
    assert.equal(actual, expected, `Reinspect changed idle gate before compression: ${file}`)
    receipt.inspectedSources.push({ file, sha256: actual })
  }
  const hasForecast = await sqlJson("SELECT to_regprocedure('public.invoke_matchup_forecasts_if_due()') IS NOT NULL", 'Forecast compression availability')
  if (hasForecast) {
    const file = 'public/invoke_matchup_forecasts_if_due.sql'
    const actual = sha256(await readFile(`supabase/sql/functions/by-name/${file}`))
    assert.equal(actual, '3e44f082368c6bebed58405db33892fb57e5c19e79d71df8043dbe85b1566d48', 'Reinspect changed forecast expiry gate before compression')
    receipt.inspectedSources.push({ file, sha256: actual })
  }
  const store = await fixtureStore(fixtureDirectory)
  const games = []
  for (const game of input.games.filter(game => game.date >= input.bounds.firstStart && game.date <= input.bounds.secondThrough)) {
    const actions = orderedActions(await store.json(`playbyplay-${game.id}`))
    const end = gameEndTime(actions)
    const periods = [...new Set(actions.filter(action => Date.parse(action.timeActual) <= end).map(action => action.period))]
    const frames = periods.map(period => {
      const rows = actions.filter(action => action.period === period && Date.parse(action.timeActual) <= end)
      return Date.parse(rows[Math.floor(rows.length / 2)].timeActual)
    })
    games.push({ id: game.id, start: Date.parse(game.time), end, frames, source: store.manifest.get(`playbyplay-${game.id}`).sha256 })
  }
  receipt.games = games
  return compressionPolicy(materialLiveTicks(games), receipt, () => sqlJson(`SELECT json_build_object(
    'inventory',EXISTS(SELECT 1 FROM private.league_hint_pending),
    'scores',EXISTS(SELECT 1 FROM private.player_stats_hint_pending),
    'tips',(SELECT coalesce(json_agg(game_time),'[]') FROM nba_games WHERE game_date BETWEEN (now() AT TIME ZONE 'America/New_York')::date AND (now() AT TIME ZONE 'America/New_York')::date+1),
    'notifications',EXISTS(SELECT 1 FROM notification_outbox WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND suppressed_at IS NULL),
    'trades',EXISTS(SELECT 1 FROM trades WHERE status IN ('pending','accepted')),
    ${hasForecast ? `'forecasts',EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty) OR EXISTS(SELECT 1 FROM matchups m JOIN league_seasons s ON s.id=m.league_season_id AND s.is_current JOIN season_weeks w ON w.season_year=s.season_year AND w.week_number=m.week_number JOIN season_weeks e ON e.season_year=s.season_year AND e.week_number=coalesce(m.end_week_number,m.week_number) WHERE NOT m.is_voided AND e.week_end>=(now() AT TIME ZONE 'America/New_York')::date-1 AND w.week_start<=(now() AT TIME ZONE 'America/New_York')::date+14 AND NOT EXISTS(SELECT 1 FROM private.matchup_forecast_queue q WHERE q.matchup_id=m.id)),
    'forecastExpires',(SELECT min(extract(epoch FROM f.valid_until)*1000) FROM matchup_forecasts f JOIN matchups m ON m.id=f.matchup_id JOIN league_seasons s ON s.id=m.league_season_id AND s.is_current JOIN season_weeks e ON e.season_year=s.season_year AND e.week_number=coalesce(m.end_week_number,m.week_number) WHERE NOT m.is_voided AND e.week_end>=(now() AT TIME ZONE 'America/New_York')::date-1),` : ''}
    'drafts',EXISTS(SELECT 1 FROM drafts d WHERE d.status IN ('in_progress','paused') OR (d.draft_type='snake' AND d.status='completed' AND EXISTS(SELECT 1 FROM snake_draft_picks p WHERE p.draft_id=d.id AND p.player_id IS NULL AND p.skipped_at IS NOT NULL))),
    'stats',EXISTS(SELECT 1 FROM sync_jobs WHERE job_type LIKE 'sync_stats_range:%' AND (status IN ('pending','running') OR (status='failed' AND failed_items<3)))
  )`, 'Empty-queue compression proof'))
}
