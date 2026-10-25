import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'local-calendar-test')
const { syncScores } = await import('./syncScores.ts')

Deno.test('score planning shares one calendar read per year and reloads on the next cycle', async () => {
  const nativeFetch = globalThis.fetch
  let calendarReads = 0
  let seasonYear = 2101
  let week = 1
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    let data: unknown = []
    if (url.pathname === '/rest/v1/league_seasons') {
      data = Array.from({ length: 20 }, (_, n) => ({
        id: `season-${n}`, league_id: `league-${n}`, season_year: seasonYear, is_current: false,
        leagues: { scoring_settings: {} },
      }))
    } else if (url.pathname === '/rest/v1/season_weeks') {
      calendarReads++
      data = [{ week_number: week, week_start: '2101-01-01', week_end: '2101-01-07' }]
    } else if (url.pathname === '/rest/v1/rpc/get_stale_score_weeks') {
      const body = await request.json()
      assert.equal(body.p_through_week, week)
    } else {
      assert.fail(`Unexpected request ${url.pathname}`)
    }
    return Response.json(data)
  }
  try {
    await syncScores(undefined, new Date('2101-01-07T18:00:00Z'), { recoverStats: false })
    assert.equal(calendarReads, 1, 'Twenty seasons in one year must share one calendar read')
    week = 2
    await syncScores(undefined, new Date('2101-01-07T18:00:00Z'), { recoverStats: false })
    assert.equal(calendarReads, 2, 'A new cycle must observe calendar corrections')
    seasonYear++
    await syncScores(undefined, new Date('2101-01-07T18:00:00Z'), { recoverStats: false })
    assert.equal(calendarReads, 3, 'Another season year must receive its own calendar')
  } finally {
    globalThis.fetch = nativeFetch
  }
})

Deno.test('game dates follow all fourteen stored merged-week days and the next week boundary', async () => {
  const { weekNumberForGameDate } = await import('./scoreShared.ts')
  const weeks = [
    { week_number: 17, week_start: '2026-02-09', week_end: '2026-02-22' },
    { week_number: 18, week_start: '2026-02-23', week_end: '2026-03-01' },
  ]
  for (let day = 9; day <= 22; day++) {
    assert.equal(weekNumberForGameDate(`2026-02-${String(day).padStart(2, '0')}`, weeks), 17)
  }
  assert.equal(weekNumberForGameDate('2026-02-23', weeks), 18)
  assert.equal(weekNumberForGameDate('2026-03-01', weeks), 18)
  assert.equal(weekNumberForGameDate('2026-03-02', weeks), null)
})
