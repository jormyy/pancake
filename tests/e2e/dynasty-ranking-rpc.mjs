import { createClient } from '@supabase/supabase-js'
import process from 'node:process'
import { cleanMessage, requireEnv, resolvedEnv } from './env.mjs'

const env = resolvedEnv()
requireEnv(env, ['supabaseUrl', 'serviceRoleKey'])

const supabase = createClient(env.supabaseUrl, env.serviceRoleKey, {
  auth: { persistSession: false },
})

const runId = `e2e-dynasty-rpc-${Date.now()}`
const source = runId
const sportsdataPrefix = `${runId}-player`
const fetchedAt = new Date().toISOString()
const scoringFormat = 'points'
const sourceUrl = 'https://example.test/e2e-dynasty-points'
const sourceMetadata = {
  requestedRankingType: 'POINT',
  selectedRankingType: 'POINT',
  requestMethod: 'POST',
}
let playerA
let playerB

const must = async (label, promise) => {
  const { data, error } = await promise
  if (error) throw new Error(`${label}: ${cleanMessage(error.message)}`)
  return data
}

const expect = (condition, message) => {
  if (!condition) throw new Error(message)
}

const rankingRow = (rank, name, playerId, overrides = {}) => ({
  source_rank: rank,
  source_player_id: `${source}-${rank}`,
  source_player_name: name,
  source_team: overrides.source_team ?? 'E2E',
  source_positions: overrides.source_positions ?? ['PG'],
  player_id: playerId ?? null,
  age: overrides.age ?? 24.5,
  rank_change: overrides.rank_change ?? 0,
  games_played: overrides.games_played ?? 70,
  field_goal_pct: overrides.field_goal_pct ?? 0.5,
  free_throw_pct: overrides.free_throw_pct ?? 0.8,
  three_pointers_made: overrides.three_pointers_made ?? 2.1,
  points: overrides.points ?? 20.1,
  rebounds: overrides.rebounds ?? 5.2,
  assists: overrides.assists ?? 6.3,
  steals: overrides.steals ?? 1.1,
  blocks: overrides.blocks ?? 0.5,
  turnovers: overrides.turnovers ?? 2.4,
  comment: overrides.comment ?? `Synthetic ${rank}`,
})

const replaceRankings = (rows) => supabase.rpc('replace_dynasty_rankings', {
  p_source: source,
  p_fetched_at: fetchedAt,
  p_rows: rows,
  p_min_rows: 1,
  p_scoring_format: scoringFormat,
  p_source_url: sourceUrl,
  p_source_metadata: sourceMetadata,
})

const cleanup = async () => {
  await supabase.from('dynasty_rankings').delete().eq('source', source)
  await supabase.from('players').delete().like('sportsdata_id', `${sportsdataPrefix}%`)
}

try {
  const insertedPlayers = await must('insert synthetic players', supabase
    .from('players')
    .insert([
      {
        sportsdata_id: `${sportsdataPrefix}-a`,
        first_name: 'Dynasty',
        last_name: 'RpcA',
        nba_team: 'E2E',
        status: 'free_agent',
      },
      {
        sportsdata_id: `${sportsdataPrefix}-b`,
        first_name: 'Dynasty',
        last_name: 'RpcB',
        nba_team: 'E2E',
        status: 'free_agent',
      },
    ])
    .select('id, sportsdata_id')
    .order('sportsdata_id', { ascending: true }))

  playerA = insertedPlayers[0]
  playerB = insertedPlayers[1]

  const first = await must('initial replace', replaceRankings([
    rankingRow(1, 'Dynasty RpcA', playerA.id, { points: 31.2 }),
    rankingRow(2, 'Dynasty RpcB', playerB.id, { assists: 8.1 }),
    rankingRow(3, 'Unmatched Synthetic', null),
  ]))

  expect(first.rows === 3, `initial rows=${first.rows}; expected 3`)
  expect(first.scoringFormat === scoringFormat, `initial scoringFormat=${first.scoringFormat}; expected ${scoringFormat}`)
  expect(first.sourceUrl === sourceUrl, `initial sourceUrl=${first.sourceUrl}; expected ${sourceUrl}`)
  expect(first.playersUpdated === 2, `initial playersUpdated=${first.playersUpdated}; expected 2`)

  const initialPlayers = await must('initial player ranks', supabase
    .from('players')
    .select('id, dynasty_rank, dynasty_rank_source')
    .in('id', [playerA.id, playerB.id])
    .order('sportsdata_id', { ascending: true }))

  expect(initialPlayers[0].dynasty_rank === 1, 'player A rank was not set to 1')
  expect(initialPlayers[1].dynasty_rank === 2, 'player B rank was not set to 2')
  expect(initialPlayers.every((row) => row.dynasty_rank_source === source), 'player rank source was not set')

  const second = await must('replacement update/delete/clear', replaceRankings([
    rankingRow(1, 'Dynasty RpcA Updated', playerA.id, { points: 32.4, comment: 'Updated synthetic row' }),
    rankingRow(4, 'New Unmatched Synthetic', null),
  ]))

  expect(second.rows === 2, `replacement rows=${second.rows}; expected 2`)
  expect(second.deleted === 2, `replacement deleted=${second.deleted}; expected stale ranks 2 and 3`)
  expect(second.playersCleared === 1, `replacement playersCleared=${second.playersCleared}; expected 1`)

  const currentRows = await must('current ranking rows', supabase
    .from('dynasty_rankings')
    .select('source_rank, source_player_name, points, scoring_format, source_url, source_metadata')
    .eq('source', source)
    .order('source_rank', { ascending: true }))

  expect(currentRows.length === 2, `current row count=${currentRows.length}; expected 2`)
  expect(currentRows.map((row) => row.source_rank).join(',') === '1,4', 'stale ranking rows were not deleted')
  expect(currentRows[0].source_player_name === 'Dynasty RpcA Updated', 'rank 1 row was not updated')
  expect(Number(currentRows[0].points) === 32.4, 'rank 1 stats were not updated')
  expect(currentRows.every((row) => row.scoring_format === scoringFormat), 'scoring format metadata was not stored')
  expect(currentRows.every((row) => row.source_url === sourceUrl), 'source URL metadata was not stored')
  expect(
    currentRows.every((row) =>
      row.source_metadata?.requestedRankingType === sourceMetadata.requestedRankingType &&
      row.source_metadata?.selectedRankingType === sourceMetadata.selectedRankingType &&
      row.source_metadata?.requestMethod === sourceMetadata.requestMethod),
    'source JSON metadata was not stored',
  )

  const replacementPlayers = await must('replacement player ranks', supabase
    .from('players')
    .select('id, dynasty_rank, dynasty_rank_source')
    .in('id', [playerA.id, playerB.id])
    .order('sportsdata_id', { ascending: true }))

  expect(replacementPlayers[0].dynasty_rank === 1, 'player A rank changed unexpectedly after replacement')
  expect(replacementPlayers[0].dynasty_rank_source === source, 'player A source changed unexpectedly after replacement')
  expect(replacementPlayers[1].dynasty_rank == null, 'player B stale rank was not cleared')
  expect(replacementPlayers[1].dynasty_rank_source == null, 'player B stale source was not cleared')

  const duplicate = await replaceRankings([
    rankingRow(1, 'Duplicate One', playerA.id),
    rankingRow(1, 'Duplicate Two', null),
  ])
  expect(duplicate.error, 'duplicate rank payload unexpectedly succeeded')

  const invalidMetadata = await supabase.rpc('replace_dynasty_rankings', {
    p_source: `${source}-invalid-metadata`,
    p_fetched_at: fetchedAt,
    p_rows: [rankingRow(1, 'Invalid Metadata', null)],
    p_min_rows: 1,
    p_scoring_format: scoringFormat,
    p_source_url: sourceUrl,
    p_source_metadata: ['not', 'an', 'object'],
  })
  expect(invalidMetadata.error, 'invalid source metadata payload unexpectedly succeeded')

  const afterRejectedRows = await must('rows after rejected duplicate payload', supabase
    .from('dynasty_rankings')
    .select('source_rank, source_player_name')
    .eq('source', source)
    .order('source_rank', { ascending: true }))

  expect(
    JSON.stringify(afterRejectedRows) === JSON.stringify(currentRows.map(({ source_rank, source_player_name }) => ({ source_rank, source_player_name }))),
    'duplicate-rank rejection did not preserve existing rows',
  )

  const afterRejectedPlayers = await must('players after rejected duplicate payload', supabase
    .from('players')
    .select('id, dynasty_rank, dynasty_rank_source')
    .in('id', [playerA.id, playerB.id])
    .order('sportsdata_id', { ascending: true }))

  expect(JSON.stringify(afterRejectedPlayers) === JSON.stringify(replacementPlayers), 'duplicate-rank rejection changed player ranks')

  console.log('dynasty ranking RPC behavior PASS')
} catch (error) {
  console.error(cleanMessage(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
} finally {
  await cleanup()
}
