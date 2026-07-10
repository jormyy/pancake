import {
  parseStatsSyncJobMetadata,
  runStatsSyncJobUnit,
  statsSyncRange,
  type StatsSyncJobMetadata,
} from './statsSyncJob.ts'

const GAME_A = '00000000-0000-4000-8000-000000000001'
const GAME_B = '00000000-0000-4000-8000-000000000002'

Deno.test('stats sync ranges enforce valid ISO dates and the 365-day boundary', () => {
  const range = statsSyncRange('2026-07-10', 365)
  if (range.startDate !== '2025-07-11' || range.endDate !== '2026-07-10') {
    throw new Error(`unexpected range: ${JSON.stringify(range)}`)
  }
  for (const input of [
    () => statsSyncRange('2026-02-30', 1),
    () => statsSyncRange('2026-07-10', 0),
    () => statsSyncRange('2026-07-10', 366),
  ]) {
    try {
      input()
      throw new Error('accepted invalid stats range')
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
    }
  }
})

Deno.test('stats sync cursor accepts one-past-end only without a game cursor', () => {
  const completed = parseStatsSyncJobMetadata({
    startDate: '2026-07-09',
    endDate: '2026-07-10',
    nextDate: '2026-07-11',
  })
  if (completed.nextDate !== '2026-07-11') throw new Error('completed cursor was not preserved')

  try {
    parseStatsSyncJobMetadata({ ...completed, afterGameId: GAME_A })
    throw new Error('accepted a game cursor after the date range')
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('cannot retain')) throw error
  }
})

Deno.test('stats sync unit performs only one slow upstream game before checkpoint and release', async () => {
  const synced: string[] = []
  const transitions: string[] = []
  const started = performance.now()
  const result = await runStatsSyncJobUnit(statsSyncRange('2026-07-10', 5), 0, {
    findNextGame: (_date, afterGameId) => Promise.resolve(afterGameId ? GAME_B : GAME_A),
    syncGame: async (gameId) => {
      synced.push(gameId)
      await new Promise((resolve) => setTimeout(resolve, 40))
    },
    checkpoint: (_completedItems, metadata) => {
      transitions.push(`checkpoint:${metadata.afterGameId}`)
      return Promise.resolve()
    },
    release: (_completedItems, metadata) => {
      transitions.push(`release:${metadata.afterGameId}`)
      return Promise.resolve()
    },
    complete: () => {
      transitions.push('complete')
      return Promise.resolve()
    },
  })

  if (performance.now() - started < 35 || synced.length !== 1 || synced[0] !== GAME_A) {
    throw new Error(`slow work was not bounded to one game: ${JSON.stringify({ synced, result })}`)
  }
  if (transitions.join(',') !== `checkpoint:${GAME_A},release:${GAME_A}` || result.completedItems !== 1) {
    throw new Error(`unexpected transitions: ${JSON.stringify({ transitions, result })}`)
  }
})

Deno.test('stats sync unit leaves a failed game uncheckpointed for fenced failure handling', async () => {
  let transitioned = false
  try {
    await runStatsSyncJobUnit(statsSyncRange('2026-07-10', 1), 4, {
      findNextGame: () => Promise.resolve(GAME_A),
      syncGame: () => Promise.reject(new Error('injected upstream failure')),
      checkpoint: () => { transitioned = true; return Promise.resolve() },
      release: () => { transitioned = true; return Promise.resolve() },
      complete: () => { transitioned = true; return Promise.resolve() },
    })
    throw new Error('upstream failure was swallowed')
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'injected upstream failure') throw error
  }
  if (transitioned) throw new Error('failed game advanced the durable cursor')
})

Deno.test('stats sync retry resumes strictly after the durable game cursor', async () => {
  let durableMetadata: StatsSyncJobMetadata | null = null
  let durableCompleted = 0
  const first = await runStatsSyncJobUnit(statsSyncRange('2026-07-10', 1), 0, {
    findNextGame: (_date, afterGameId) => Promise.resolve(afterGameId ? GAME_B : GAME_A),
    syncGame: () => Promise.resolve(),
    checkpoint: (completedItems, metadata) => {
      durableCompleted = completedItems
      durableMetadata = metadata
      return Promise.resolve()
    },
    release: () => Promise.resolve(),
    complete: () => Promise.resolve(),
  })
  if (!durableMetadata || first.metadata.afterGameId !== GAME_A) throw new Error('first cursor was not durable')

  const resumedGames: string[] = []
  await runStatsSyncJobUnit(durableMetadata, durableCompleted, {
    findNextGame: (_date, afterGameId) => Promise.resolve(afterGameId === GAME_A ? GAME_B : GAME_A),
    syncGame: (gameId) => { resumedGames.push(gameId); return Promise.resolve() },
    checkpoint: () => Promise.resolve(),
    release: () => Promise.resolve(),
    complete: () => Promise.resolve(),
  })
  if (resumedGames.join(',') !== GAME_B) throw new Error(`retry replayed a completed game: ${resumedGames}`)
})

Deno.test('stats sync unit bounds empty-date scans before releasing its claim', async () => {
  let scans = 0
  let releases = 0
  await runStatsSyncJobUnit(statsSyncRange('2026-07-10', 365), 0, {
    findNextGame: () => { scans += 1; return Promise.resolve(null) },
    syncGame: () => Promise.reject(new Error('unexpected game')),
    checkpoint: () => Promise.reject(new Error('unexpected checkpoint')),
    release: () => { releases += 1; return Promise.resolve() },
    complete: () => Promise.reject(new Error('unexpected completion')),
  })
  if (scans !== 31 || releases !== 1) {
    throw new Error(`empty date scan was not bounded: ${JSON.stringify({ scans, releases })}`)
  }
})
