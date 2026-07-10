import {
  runStatsSyncJobBatch,
  statsSyncRange,
} from './statsSyncJob.ts'

Deno.test('stats sync ranges enforce the 365-day boundary', () => {
  const range = statsSyncRange('2026-07-10', 365)
  if (range.startDate !== '2025-07-11' || range.endDate !== '2026-07-10') {
    throw new Error(`unexpected range: ${JSON.stringify(range)}`)
  }
  for (const days of [0, 366]) {
    try {
      statsSyncRange('2026-07-10', days)
      throw new Error(`accepted invalid day count ${days}`)
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
    }
  }
})

Deno.test('stats sync batches checkpoint each completed date and never exceed the fixed batch', async () => {
  const dates: string[] = []
  const checkpoints: string[] = []
  let continuations = 0
  const result = await runStatsSyncJobBatch(statsSyncRange('2026-07-10', 10), 0, {
    syncDate: (date) => {
      dates.push(date)
      return Promise.resolve()
    },
    checkpoint: ({ metadata }) => {
      checkpoints.push(metadata.nextDate)
      return Promise.resolve()
    },
    enqueueContinuation: () => {
      continuations += 1
      return Promise.resolve()
    },
  })

  if (dates.length !== 3 || checkpoints.length !== 3 ||
      continuations !== 1 || result.completed) {
    throw new Error(`batch was not bounded: ${JSON.stringify({ dates, checkpoints, continuations, result })}`)
  }
})

Deno.test('stats sync retry resumes after the last durable checkpoint', async () => {
  const range = statsSyncRange('2026-07-10', 5)
  let cursor = range.nextDate
  let completedItems = 0
  const firstDates: string[] = []
  try {
    await runStatsSyncJobBatch(range, completedItems, {
      syncDate: async (date) => {
        firstDates.push(date)
        if (firstDates.length === 3) throw new Error('injected upstream failure')
      },
      checkpoint: async (checkpoint) => {
        cursor = checkpoint.metadata.nextDate
        completedItems = checkpoint.completedItems
      },
      enqueueContinuation: () => Promise.resolve(),
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'injected upstream failure') throw error
  }

  const resumedDates: string[] = []
  await runStatsSyncJobBatch({ ...range, nextDate: cursor }, completedItems, {
    syncDate: (date) => {
      resumedDates.push(date)
      return Promise.resolve()
    },
    checkpoint: () => Promise.resolve(),
    enqueueContinuation: () => Promise.resolve(),
  })

  if (resumedDates.includes(firstDates[0]) || resumedDates.includes(firstDates[1]) || resumedDates[0] !== firstDates[2]) {
    throw new Error(`retry replayed completed dates: ${JSON.stringify({ firstDates, resumedDates })}`)
  }
})
