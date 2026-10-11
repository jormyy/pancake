import { strict as assert } from 'node:assert'
const api = Deno.env.get('SUPABASE_URL')!
assert.ok(
  ['127.0.0.1', 'localhost'].includes(new URL(api).hostname),
  'Only an isolated local backend is allowed',
)
const gameId = crypto.randomUUID(),
  jobId = crypto.randomUUID(),
  providerId = `002-status-${crypto.randomUUID()}`
let providerStatus = 1
const provider = Deno.serve(
  { hostname: '127.0.0.1', port: 0, onListen() {} },
  (request) => {
    assert.equal(
      new URL(request.url).pathname,
      `/liveData/boxscore/boxscore_${providerId}.json`,
    )
    return Response.json({
      game: {
        gameId: providerId,
        gameStatus: providerStatus,
        homeTeam: { players: [] },
        awayTeam: { players: [] },
      },
    })
  },
)
const origin = `http://127.0.0.1:${provider.addr.port}`,
  prior = Deno.env.get('NBA_CDN_BASE_URL')
Deno.env.set('NBA_CDN_BASE_URL', origin)
const originalFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.href
      : input.url,
  )
  assert.ok([api, origin].includes(url.origin))
  return originalFetch(input, init)
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { syncStatsGame, findNextStatsGame } = await import(
  '../../functions/_shared/syncStats.ts'
)
const { runStatsSyncJobUnit } = await import(
  '../../functions/_shared/statsSyncJob.ts'
)
const q = async (op: any): Promise<any> => {
  const { data, error } = await op
  if (error) throw Error(error.message)
  return data
}
let date = '', year = 0
try {
  for (let i = 0; i < 100; i++) {
    year = 1800 + crypto.getRandomValues(new Uint32Array(1))[0] % 100
    date = `${year}-06-${String(1 + i % 28).padStart(2, '0')}`
    const g = await q(
      supabase.from('nba_games').select('id').eq('game_date', date),
    )
    const j = await q(
      supabase.from('sync_jobs').select('id').eq(
        'job_type',
        `sync_stats_range:${date}:${date}`,
      ),
    )
    if (!g.length && !j.length) break
    date = ''
  }
  assert.ok(date)
  await q(
    supabase.from('nba_games').insert({
      id: gameId,
      nba_game_id: providerId,
      season_year: year,
      week_number: 1,
      game_date: date,
      status: 'Final',
      home_team: 'XST',
      away_team: 'XSQ',
    }),
  )
  const metadata = { startDate: date, endDate: date, nextDate: date }
  await q(
    supabase.from('sync_jobs').insert({
      id: jobId,
      job_type: `sync_stats_range:${date}:${date}`,
      status: 'pending',
      total_items: 1,
      metadata,
    }),
  )
  const claim =
    (await q(supabase.rpc('claim_stats_sync_job_atomic', { p_job_id: jobId })))[
      0
    ]
  assert.ok(claim?.claim_token)
  let error: string | null = null, result: any = null, selected: any = null
  const transition = (
    rpc:
      | 'checkpoint_stats_sync_job_atomic'
      | 'release_stats_sync_job_atomic'
      | 'complete_stats_sync_job_atomic',
  ) =>
  async (completed: number, next: any) => {
    assert.equal(
      await q(
        supabase.rpc(rpc, {
          p_job_id: jobId,
          p_claim_token: claim.claim_token,
          p_completed_items: completed,
          p_metadata: next,
        }),
      ),
      true,
    )
  }
  try {
    result = await runStatsSyncJobUnit(metadata, 0, {
      findNextGame: async (d, c) => {
        selected = await findNextStatsGame(d, c)
        return selected?.id ?? null
      },
      syncGame: async (id) => {
        assert.equal(selected.id, id)
        await syncStatsGame(selected)
      },
      checkpoint: transition('checkpoint_stats_sync_job_atomic'),
      release: transition('release_stats_sync_job_atomic'),
      complete: transition('complete_stats_sync_job_atomic'),
    })
  } catch (e) {
    error = String(e)
  }
  const stored = await q(
    supabase.from('sync_jobs').select('status,completed_items,metadata').eq(
      'id',
      jobId,
    ).single(),
  )
  const game = await q(
    supabase.from('nba_games').select('status,stats_synced_at').eq('id', gameId)
      .single(),
  )
  console.log(
    JSON.stringify({
      scenario: 'providerScheduledStoredFinalActualJob',
      error,
      result,
      stored,
      game,
    }),
  )
  assert.ok(
    error && stored.completed_items === 0 && !stored.metadata.afterGameId &&
      game.stats_synced_at === null,
    'Stored Final/provider Scheduled must reject without advancing the actual job cursor',
  )
  providerStatus = 2
  await assert.rejects(() => syncStatsGame(selected), /Final.*not final/)
  console.log('PASS stored Final/provider InProgress rejection')
  providerStatus = 1
  await q(
    supabase.from('nba_games').update({ status: 'Scheduled' }).eq('id', gameId),
  )
  assert.equal(await syncStatsGame({ ...selected, status: 'Scheduled' }), 0)
  console.log('PASS legitimate stored Scheduled/provider Scheduled skip')
} finally {
  const cleanupErrors: string[] = []
  for (
    const [table, id] of [['sync_jobs', jobId], ['nba_games', gameId]] as const
  ) {
    try {
      await q(supabase.from(table).delete().eq('id', id))
    } catch (e) {
      cleanupErrors.push(`${table}: ${e}`)
    }
  }
  globalThis.fetch = originalFetch
  if (prior === undefined) Deno.env.delete('NBA_CDN_BASE_URL')
  else Deno.env.set('NBA_CDN_BASE_URL', prior)
  await provider.shutdown()
  console.log(JSON.stringify({ cleanupErrors }))
  assert.equal(cleanupErrors.length, 0)
}
