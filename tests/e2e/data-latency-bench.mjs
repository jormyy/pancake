import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { describeEndpoint, resolvedEnv, requireEnv } from './env.mjs'
import { resolveSchemaProvenance } from './schema-provenance.mjs'
import { resolveReleaseProvenance } from './release-provenance.mjs'
import { DATA_LATENCY_STEP_KEYS } from './data-latency-contract.mjs'

const ROOT = process.cwd()
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-data-latency-report.md')
const PERFORMANCE_BUDGETS = JSON.parse(readFileSync(path.join(ROOT, 'tests/e2e/performance-budgets.json'), 'utf8')).globalBudgets

const DATA_REQUEST_BUDGET_MS = PERFORMANCE_BUDGETS.maxDbQueryMs
const WORKFLOW_TOTAL_BUDGET_MS = PERFORMANCE_BUDGETS.fullWorkflowMs
const SAMPLE_COUNT = Math.max(1, Number(process.env.E2E_DATA_LATENCY_SAMPLES ?? 3))
const PLAYER_SEARCH_PAGE_SIZE = 20

const currentSeasonYear = (now = new Date()) => {
  return now.getUTCMonth() >= 9 ? now.getUTCFullYear() + 1 : now.getUTCFullYear()
}

const todayET = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const get = (type) => parts.find((part) => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

const roundMs = (value) => Math.round(value * 10) / 10

const countRows = (data) => {
  if (Array.isArray(data)) return data.length
  if (data == null) return 0
  return 1
}

const unwrap = async (query) => {
  const result = await query
  if (result?.error) throw result.error
  return result?.data ?? null
}

const timedStep = async (workflowId, label, fn) => {
  const durations = []
  let rowCount = 0
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const started = performance.now()
    const data = await fn()
    durations.push(performance.now() - started)
    rowCount = countRows(data)
  }

  const medianMs = roundMs(median(durations))
  const maxMs = roundMs(Math.max(...durations))
  return {
    workflowId,
    label,
    samples: SAMPLE_COUNT,
    medianMs,
    maxMs,
    rowCount,
    status: maxMs <= DATA_REQUEST_BUDGET_MS ? 'PASS' : 'FAIL',
  }
}

const skipStep = (workflowId, label, reason) => ({
  workflowId,
  label,
  samples: 0,
  medianMs: 0,
  maxMs: 0,
  rowCount: 0,
  status: 'SKIP',
  reason,
})

const runWorkflow = async (id, steps) => {
  const stepKeys = DATA_LATENCY_STEP_KEYS[id]
  if (!stepKeys || stepKeys.length !== steps.length) {
    throw new Error(`${id} executable steps do not match the canonical data latency contract`)
  }
  const results = []
  for (const [index, step] of steps.entries()) {
    try {
      results.push({ ...await step(), key: stepKeys[index] })
    } catch (error) {
      results.push({
        workflowId: id,
        key: stepKeys[index],
        label: step.label ?? 'unnamed step',
        samples: 0,
        medianMs: 0,
        maxMs: 0,
        rowCount: 0,
        status: 'FAIL',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const measured = results.filter((step) => step.status !== 'SKIP')
  const totalMedianMs = roundMs(measured.reduce((sum, step) => sum + step.medianMs, 0))
  const status = measured.every((step) => step.status === 'PASS') && totalMedianMs <= WORKFLOW_TOTAL_BUDGET_MS
    ? 'PASS'
    : 'FAIL'
  return { id, status, totalMedianMs, steps: results }
}

const readState = async () => {
  if (!existsSync(STATE_PATH)) {
    throw new Error('tests/e2e-state.json is missing; run npm run e2e:seed before the data latency bench')
  }
  return JSON.parse(await readFile(STATE_PATH, 'utf8'))
}

const firstRow = (rows) => Array.isArray(rows) ? rows[0] ?? null : rows ?? null

const findContext = async (client, state) => {
  const user = state.users?.[0]
  if (!user) throw new Error('seed state has no user at index 0')

  const member = await unwrap(
    client
      .from('league_members')
      .select('id, user_id, team_name')
      .eq('league_id', state.leagueId)
      .eq('user_id', user.id)
      .single(),
  )
  const season = await unwrap(
    client
      .from('league_seasons')
      .select('id, season_year')
      .eq('league_id', state.leagueId)
      .eq('is_current', true)
      .single(),
  )
  const members = await unwrap(
    client
      .from('league_members')
      .select('id, user_id, team_name')
      .eq('league_id', state.leagueId)
      .order('joined_at', { ascending: true }),
  )
  const matchup = firstRow(await unwrap(
    client
      .from('matchups')
      .select('id, league_season_id, week_number, home_member_id, away_member_id, home_points, away_points')
      .eq('league_id', state.leagueId)
      .eq('league_season_id', season.id)
      .order('week_number', { ascending: false })
      .limit(1),
  ))
  const player = firstRow(await unwrap(
    client
      .from('players')
      .select('id, display_name, nba_team')
      .like('sportsdata_id', 'e2e-player-%')
      .order('display_name', { ascending: true })
      .limit(1),
  ))
  const auctionDraft = firstRow(await unwrap(
    client
      .from('drafts')
      .select('id')
      .eq('league_id', state.leagueId)
      .eq('draft_type', 'auction')
      .eq('is_mock', false)
      .order('created_at', { ascending: false })
      .limit(1),
  ))
  const rookieDraft = firstRow(await unwrap(
    client
      .from('drafts')
      .select('id')
      .eq('league_id', state.leagueId)
      .eq('draft_type', 'snake')
      .eq('is_mock', false)
      .order('created_at', { ascending: false })
      .limit(1),
  ))

  const opponentMemberId = matchup
    ? (matchup.home_member_id === member.id ? matchup.away_member_id : matchup.home_member_id)
    : members.find((candidate) => candidate.id !== member.id)?.id

  return {
    member,
    opponentMemberId,
    season,
    matchup,
    player,
    auctionDraft,
    rookieDraft,
    today: todayET(),
    seasonYear: season?.season_year ?? currentSeasonYear(),
  }
}

const step = (workflowId, label, fn) => Object.assign(
  () => timedStep(workflowId, label, fn),
  { label },
)

const optionalStep = (workflowId, label, condition, reason, fn) => Object.assign(
  () => condition ? timedStep(workflowId, label, fn) : skipStep(workflowId, label, reason),
  { label },
)

const buildWorkflows = (client, state, context) => {
  const leagueId = state.leagueId
  const memberId = context.member.id
  const seasonId = context.season.id
  const playerId = context.player?.id
  const matchup = context.matchup
  const weekNumber = matchup?.week_number ?? 1

  return [
    runWorkflow('home-live-lineup', [
      optionalStep('home-live-lineup', 'current matchup row', Boolean(matchup), 'no matchup fixture found', () =>
        unwrap(client.from('matchups').select('id, home_points, away_points, winner_member_id, is_finalized, home_member_id, away_member_id').eq('id', matchup.id).single())),
      optionalStep('home-live-lineup', 'league week matchup rows', Boolean(matchup), 'no matchup fixture found', () =>
        unwrap(client.from('matchups').select('id, home_member_id, away_member_id, home_points, away_points, is_finalized').eq('league_id', leagueId).eq('league_season_id', seasonId).eq('week_number', weekNumber))),
      step('home-live-lineup', 'my roster for lineup render', () =>
        unwrap(client.from('roster_players').select('id, player_id, is_on_ir, is_on_taxi, players(display_name, position, eligible_positions, nba_team, injury_status)').eq('member_id', memberId).eq('league_id', leagueId).eq('league_season_id', seasonId))),
      optionalStep('home-live-lineup', 'opponent roster for lineup render', Boolean(context.opponentMemberId), 'no opponent member found', () =>
        unwrap(client.from('roster_players').select('id, player_id, is_on_ir, is_on_taxi, players(display_name, position, eligible_positions, nba_team, injury_status)').eq('member_id', context.opponentMemberId).eq('league_id', leagueId).eq('league_season_id', seasonId))),
      step('home-live-lineup', 'today NBA games', () =>
        unwrap(client.from('nba_games').select('id, home_team, away_team, status, game_time').eq('game_date', context.today))),
    ]),
    runWorkflow('lineup-day-change', [
      step('lineup-day-change', 'lineup slot templates', () =>
        unwrap(client.from('lineup_slot_templates').select('slot_type, slot_count').eq('league_id', leagueId))),
      step('lineup-day-change', 'weekly lineup assignment rows', () =>
        unwrap(client.from('weekly_lineups').select('player_id, slot_type').eq('member_id', memberId).eq('league_id', leagueId).eq('league_season_id', seasonId).eq('game_date', context.today))),
      step('lineup-day-change', 'same-day lock context games', () =>
        unwrap(client.from('nba_games').select('home_team, away_team, status, game_time').eq('game_date', context.today))),
    ]),
    runWorkflow('player-search-filter', [
      step('player-search-filter', 'search_players first page RPC', () =>
        unwrap(client.rpc('search_players', {
          p_query: '',
          p_position: 'ALL',
          p_teams: [],
          p_league_id: leagueId,
          p_playing_teams: undefined,
          p_excluded_teams: [],
          p_include_player_ids: undefined,
          p_exclude_player_ids: [],
          p_rookies_only: false,
          p_health: 'all',
          p_sort_by: 'fpts',
          p_sort_dir: 'desc',
          p_season_year: context.seasonYear,
          p_limit: PLAYER_SEARCH_PAGE_SIZE,
          p_offset: 0,
        }))),
      step('player-search-filter', 'availability owned players', () =>
        unwrap(client.from('roster_players').select('player_id, member_id, league_members(team_name)').eq('league_id', leagueId).eq('league_season_id', seasonId))),
      step('player-search-filter', 'availability waiver players', () =>
        unwrap(client.from('waiver_wire_log').select('player_id').eq('league_id', leagueId).eq('league_season_id', seasonId).is('cleared_at', null))),
    ]),
    runWorkflow('player-detail-open', [
      optionalStep('player-detail-open', 'player row', Boolean(playerId), 'no player fixture found', () =>
        unwrap(client.from('players').select('*').eq('id', playerId).single())),
      optionalStep('player-detail-open', 'available seasons', Boolean(playerId), 'no player fixture found', () =>
        unwrap(client.from('mv_player_season_averages').select('season_year').eq('player_id', playerId).order('season_year', { ascending: false }))),
      optionalStep('player-detail-open', 'season averages view', Boolean(playerId), 'no player fixture found', () =>
        unwrap(client.from('mv_player_season_averages').select('*').eq('player_id', playerId).eq('season_year', context.seasonYear).maybeSingle())),
      optionalStep('player-detail-open', 'game log first page', Boolean(playerId), 'no player fixture found', () =>
        unwrap(client.from('player_game_stats').select('id, points, rebounds, assists, did_not_play, minutes_played, nba_games!inner(id, nba_game_id, game_date, home_team, away_team)').eq('player_id', playerId).eq('season_year', context.seasonYear).like('nba_games.nba_game_id', '002%').order('game_date', { ascending: false }).range(0, 15))),
      optionalStep('player-detail-open', 'projection row RPC', Boolean(playerId), 'no player fixture found', () =>
        unwrap(client.rpc('get_league_projection_rows', {
          p_league_id: leagueId,
          p_season_year: context.seasonYear,
          p_game_date: context.today,
          p_view: 'today',
          p_player_ids: [playerId],
          p_limit: 1,
          p_offset: 0,
        }))),
    ]),
    runWorkflow('roster-review-manage', [
      step('roster-review-manage', 'roster players with player rows', () =>
        unwrap(client.from('roster_players').select('id, is_on_ir, is_on_taxi, acquired_via, players(id, display_name, nba_team, position, eligible_positions, injury_status, nba_id, nba_draft_number, years_exp)').eq('member_id', memberId).eq('league_season_id', seasonId).order('is_on_taxi').order('is_on_ir'))),
      step('roster-review-manage', 'member draft picks', () =>
        unwrap(client.from('draft_picks').select('id, season_year, round, original_owner:league_members!draft_picks_original_owner_id_fkey(team_name)').eq('current_owner_id', memberId).eq('league_id', leagueId).eq('is_used', false).order('season_year', { ascending: true }).order('round', { ascending: true }))),
      step('roster-review-manage', 'my waiver claims', () =>
        unwrap(client.from('waiver_claims').select('id, player_id, drop_player_id, status, submitted_at, process_date, priority_at_submission, bid_amount, claim_order, failure_reason').eq('member_id', memberId).eq('league_season_id', seasonId).in('status', ['pending', 'succeeded', 'failed_priority', 'failed_roster']).order('claim_order', { ascending: true }).order('submitted_at', { ascending: false }).limit(20))),
      step('roster-review-manage', 'my waiver priority', () =>
        unwrap(client.from('waiver_priorities').select('priority').eq('member_id', memberId).eq('league_season_id', seasonId).maybeSingle())),
    ]),
    runWorkflow('waiver-add-claim', [
      step('waiver-add-claim', 'active waiver wire entries', () =>
        unwrap(client.from('waiver_wire_log').select('id, player_id, clears_at, players(display_name, position, nba_team, injury_status)').eq('league_id', leagueId).eq('league_season_id', seasonId).is('cleared_at', null).order('clears_at', { ascending: true }))),
      step('waiver-add-claim', 'member transaction state', () =>
        unwrap(client.rpc('get_member_transaction_state', {
          p_member_id: memberId,
          p_league_id: leagueId,
        }))),
      step('waiver-add-claim', 'claim modal roster choices', () =>
        unwrap(client.from('roster_players').select('id, player_id, players(display_name, position, nba_team)').eq('member_id', memberId).eq('league_id', leagueId).eq('league_season_id', seasonId))),
    ]),
    runWorkflow('trade-review-act', [
      step('trade-review-act', 'trades involving member', () =>
        unwrap(client.from('trades').select('id, status, proposed_at, accepted_at, veto_window_expires_at, proposer_member_id, recipient_member_id, trade_items(id, side, player_id, pick_id)').eq('league_id', leagueId).or(`proposer_member_id.eq.${memberId},recipient_member_id.eq.${memberId}`).order('proposed_at', { ascending: false }).limit(50))),
      step('trade-review-act', 'tradeable roster players', () =>
        unwrap(client.from('roster_players').select('id, player_id, players(display_name, position, nba_team)').eq('member_id', memberId).eq('league_id', leagueId).eq('league_season_id', seasonId))),
      step('trade-review-act', 'tradeable draft picks', () =>
        unwrap(client.from('draft_picks').select('id, season_year, round').eq('current_owner_id', memberId).eq('league_id', leagueId).eq('is_used', false).order('season_year', { ascending: true }).order('round', { ascending: true }))),
    ]),
    runWorkflow('auction-draft-room', [
      optionalStep('auction-draft-room', 'auction draft row', Boolean(context.auctionDraft?.id), 'no auction draft found', () =>
        unwrap(client.from('drafts').select('id, league_id, status, draft_type, current_nomination_order, budget_per_team, started_at').eq('id', context.auctionDraft.id).single())),
      optionalStep('auction-draft-room', 'auction draft order', Boolean(context.auctionDraft?.id), 'no auction draft found', () =>
        unwrap(client.from('draft_orders').select('position, member_id, league_members(team_name)').eq('draft_id', context.auctionDraft.id).order('position'))),
      optionalStep('auction-draft-room', 'auction budgets', Boolean(context.auctionDraft?.id), 'no auction draft found', () =>
        unwrap(client.from('draft_budgets').select('member_id, remaining, initial_budget, league_members(team_name)').eq('draft_id', context.auctionDraft.id))),
      optionalStep('auction-draft-room', 'auction nominations', Boolean(context.auctionDraft?.id), 'no auction draft found', () =>
        unwrap(client.from('nominations').select('id, status, current_bid_amount, current_bidder_id, countdown_expires_at, winning_member_id, final_price, nominating_member_id, nominated_at, nomination_order, player_id, players(display_name, nba_team, position)').eq('draft_id', context.auctionDraft.id).order('nomination_order'))),
    ]),
    runWorkflow('rookie-draft-room', [
      optionalStep('rookie-draft-room', 'rookie draft row', Boolean(context.rookieDraft?.id), 'no rookie draft found', () =>
        unwrap(client.from('drafts').select('id, league_id, status, draft_type, current_nomination_order, rounds, started_at').eq('id', context.rookieDraft.id).single())),
      optionalStep('rookie-draft-room', 'snake pick board', Boolean(context.rookieDraft?.id), 'no rookie draft found', () =>
        unwrap(client.from('snake_draft_picks').select('id, overall_pick, round, pick_in_round, member_id, player_id, picked_at, draft_pick_id').eq('draft_id', context.rookieDraft.id).order('overall_pick'))),
      step('rookie-draft-room', 'rookie player board', () =>
        unwrap(client.from('players').select('id, display_name, nba_team, position, nba_draft_number').not('nba_draft_number', 'is', null).order('nba_draft_number', { ascending: true }).limit(100))),
    ]),
    runWorkflow('dynasty-hub', [
      step('dynasty-hub', 'dynasty rankings first page', () =>
        unwrap(client.from('dynasty_rankings').select('id, source, scoring_format, source_url, source_metadata, source_rank, source_player_name, source_team, source_positions, age, rank_change, games_played, field_goal_pct, free_throw_pct, three_pointers_made, points, rebounds, assists, steals, blocks, turnovers, comment, fetched_at, player:players!dynasty_rankings_player_id_fkey(id, display_name, nba_team, position, eligible_positions, injury_status, years_exp, headshot_url, nba_id)').eq('source', 'hashtagbasketball.com').order('source_rank', { ascending: true }).range(0, 50))),
      step('dynasty-hub', 'dynasty news first page', () =>
        unwrap(client.from('dynasty_news').select('id, player_id, source, title, summary, url, published_at').order('published_at', { ascending: false }).limit(30))),
      step('dynasty-hub', 'my roster news scope', () =>
        unwrap(client.from('roster_players').select('player_id').eq('member_id', memberId).eq('league_id', leagueId).eq('league_season_id', seasonId))),
    ]),
  ]
}

const main = async () => {
  const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'anonKey'])
  const state = await readState()
  const user = state.users?.[0]
  if (!user) throw new Error('seed state has no user at index 0')

  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { error: signInError } = await client.auth.signInWithPassword({
    email: user.email,
    password: state.password,
  })
  if (signInError) throw signInError

  const context = await findContext(client, state)
  const schemaProvenance = await resolveSchemaProvenance()
  const provenance = await resolveReleaseProvenance()
  const workflowPromises = buildWorkflows(client, state, context)
  const workflows = []
  for (const workflowPromise of workflowPromises) workflows.push(await workflowPromise)

  const failures = []
  if (schemaProvenance.schemaVersion !== schemaProvenance.repositorySchemaVersion) {
    failures.push(`applied schema ${schemaProvenance.schemaVersion} does not match repository head ${schemaProvenance.repositorySchemaVersion}`)
  }
  for (const workflow of workflows) {
    if (workflow.status !== 'PASS') {
      failures.push(`${workflow.id} total ${workflow.totalMedianMs}ms exceeded ${WORKFLOW_TOTAL_BUDGET_MS}ms or has failing steps`)
    }
    for (const stepResult of workflow.steps) {
      if (stepResult.status === 'FAIL') {
        failures.push(`${workflow.id} / ${stepResult.label}: ${stepResult.error ?? `max ${stepResult.maxMs}ms exceeded ${DATA_REQUEST_BUDGET_MS}ms`}`)
      }
    }
  }

  const report = {
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(),
    endpoint: describeEndpoint(env.supabaseUrl),
    runId: state.runId,
    leagueId: state.leagueId,
    user: user.email,
    provenance,
    ...schemaProvenance,
    budgets: {
      dataRequestMs: DATA_REQUEST_BUDGET_MS,
      workflowTotalMs: WORKFLOW_TOTAL_BUDGET_MS,
      samples: SAMPLE_COUNT,
    },
    context: {
      memberId: context.member.id,
      seasonId: context.season.id,
      matchupId: context.matchup?.id ?? null,
      playerId: context.player?.id ?? null,
      auctionDraftId: context.auctionDraft?.id ?? null,
      rookieDraftId: context.rookieDraft?.id ?? null,
    },
    workflows,
    failures,
  }

  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`${report.status} ${path.relative(ROOT, REPORT_PATH)}`)
  if (failures.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
