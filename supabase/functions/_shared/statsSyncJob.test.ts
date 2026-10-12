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

Deno.test('stats sync unit bounds empty-date batches and checkpoints before continuing', async () => {
  let scans = 0
  let releases = 0
  const checkpoints: number[] = []
  await runStatsSyncJobUnit(statsSyncRange('2026-07-10', 365), 0, {
    findNextGame: () => { scans += 1; return Promise.resolve(null) },
    syncGame: () => Promise.reject(new Error('unexpected game')),
    checkpoint: () => { checkpoints.push(scans); return Promise.resolve() },
    release: () => { releases += 1; return Promise.resolve() },
    complete: () => Promise.reject(new Error('unexpected completion')),
  })
  if (scans !== 124 || releases !== 1 || checkpoints.join(',') !== '31,62,93') {
    throw new Error(`empty date scan was not bounded: ${JSON.stringify({ scans, releases, checkpoints })}`)
  }
})

Deno.test('stats sync unit stops at a rejected empty-date checkpoint', async () => {
  let scans = 0
  let transitioned = false
  try {
    await runStatsSyncJobUnit(statsSyncRange('2026-07-10', 365), 4, {
      findNextGame: () => { scans += 1; return Promise.resolve(null) },
      syncGame: () => Promise.reject(new Error('unexpected game')),
      checkpoint: () => Promise.reject(new Error('claim superseded')),
      release: () => { transitioned = true; return Promise.resolve() },
      complete: () => { transitioned = true; return Promise.resolve() },
    })
    throw new Error('checkpoint failure was swallowed')
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'claim superseded') throw error
  }
  if (scans !== 31 || transitioned) throw new Error('work continued without a fenced claim')
})

Deno.test('stats sync unit releases after a slow empty-date batch', async () => {
  let scans = 0
  let released = false
  await runStatsSyncJobUnit(statsSyncRange('2026-07-10', 365), 0, {
    findNextGame: async () => {
      scans += 1
      if (scans === 1) await new Promise((resolve) => setTimeout(resolve, 1_010))
      return null
    },
    syncGame: () => Promise.reject(new Error('unexpected game')),
    checkpoint: () => Promise.reject(new Error('slow batch should release')),
    release: () => { released = true; return Promise.resolve() },
    complete: () => Promise.reject(new Error('unexpected completion')),
  })
  if (scans !== 31 || !released) throw new Error('slow scan exceeded its batch budget')
})

Deno.test('stats sync unit re-reads later dates after a checkpoint and preserves one-game writes', async () => {
  const range = statsSyncRange('2026-07-10', 65)
  let scans = 0
  let revision = false
  const transitions: string[] = []
  const result = await runStatsSyncJobUnit(range, 2, {
    findNextGame: () => { scans += 1; return Promise.resolve(revision ? GAME_A : null) },
    syncGame: (id) => { transitions.push(`game:${id}`); return Promise.resolve() },
    checkpoint: (count, cursor) => {
      transitions.push(`checkpoint:${count}:${cursor.nextDate}`)
      revision = true
      return Promise.resolve()
    },
    release: (count) => { transitions.push(`release:${count}`); return Promise.resolve() },
    complete: () => Promise.reject(new Error('unexpected completion')),
  })
  if (scans !== 32 || result.completedItems !== 3 || result.metadata.afterGameId !== GAME_A
    || !transitions[1].startsWith('game:') || transitions[3] !== 'release:3') {
    throw new Error(`later authoritative result was not consumed: ${JSON.stringify({ scans, result, transitions })}`)
  }
})
