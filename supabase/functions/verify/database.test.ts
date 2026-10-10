import { currentSeasonYear } from '../_shared/season.ts'
import { parseSeasonYear, validateDatabase } from './database.ts'

type Filter = [string, string, unknown]
type Result = { count: number | null; error: unknown }

function fakeClient(answer: (table: string, filters: Filter[]) => Result, rpcResult: { data: unknown; error: unknown }) {
  const calls: string[] = []
  const builder = (table: string, filters: Filter[]) => ({
    select: () => builder(table, filters),
    eq: (column: string, value: unknown) => builder(table, [...filters, ['eq', column, value]]),
    is: (column: string, value: unknown) => builder(table, [...filters, ['is', column, value]]),
    then: (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => {
      calls.push(`${table}:${JSON.stringify(filters)}`)
      return Promise.resolve(answer(table, filters)).then(resolve, reject)
    },
  })
  const client = {
    from: (table: string) => builder(table, []),
    rpc: (name: string, args: unknown) => {
      calls.push(`rpc:${name}:${JSON.stringify(args)}`)
      return Promise.resolve(rpcResult)
    },
  }
  // deno-lint-ignore no-explicit-any
  return { client: client as any, calls }
}

Deno.test('season year accepts omitted and whole supported years only', () => {
  const current = currentSeasonYear()
  const cases: Array<[unknown, number | null]> = [
    [undefined, current], [null, current], ['', current],
    [2026, 2026], ['2026', 2026], [' 1946 ', 1946], [2100, 2100],
    ['NaN', null], ['abc', null], ['2026x', null], [2025.5, null], ['2025.5', null],
    [Number.NaN, null], [1945, null], [2101, null], ['-2026', null], [true, null], [{}, null],
  ]
  for (const [input, expected] of cases) {
    const actual = parseSeasonYear(input)
    if (actual !== expected) throw new Error(`${JSON.stringify(input)} parsed as ${actual}, expected ${expected}`)
  }
})

Deno.test('validate-db reports exact counts for a supported year', async () => {
  const { client, calls } = fakeClient((table, filters) => {
    if (table === 'players') return { count: 3, error: null }
    if (filters.some(([, column]) => column === 'status')) return { count: 40, error: null }
    if (filters.some(([, column]) => column === 'nba_game_id')) return { count: 0, error: null }
    return { count: 1230, error: null }
  }, { data: 0, error: null })

  const report = await validateDatabase(client, 2026)
  const expected = { seasonYear: 2026, totalGames: 1230, finalGames: 40, finalGamesWithoutStats: 0, gamesMissingNbaGameId: 0, playersWithoutNbaId: 3 }
  if (JSON.stringify(report) !== JSON.stringify(expected)) throw new Error(`unexpected report ${JSON.stringify(report)}`)
  if (!calls.includes('rpc:count_final_games_missing_stats:{"season_year_param":2026}')) throw new Error(`RPC year not passed: ${calls}`)
})

Deno.test('validate-db propagates every count query error instead of reporting success', async () => {
  const failure = { message: 'invalid input syntax for type integer', code: '22P02' }
  const targets = ['total', 'final', 'missing-id', 'players']
  for (const target of targets) {
    const { client } = fakeClient((table, filters) => {
      const kind = table === 'players' ? 'players'
        : filters.some(([, column]) => column === 'status') ? 'final'
        : filters.some(([, column]) => column === 'nba_game_id') ? 'missing-id' : 'total'
      return kind === target ? { count: null, error: failure } : { count: 1, error: null }
    }, { data: 0, error: null })
    let thrown: unknown = null
    try {
      await validateDatabase(client, 2026)
    } catch (error) {
      thrown = error
    }
    if (thrown !== failure) throw new Error(`${target} query error was not propagated: ${JSON.stringify(thrown)}`)
  }

  const { client } = fakeClient(() => ({ count: 1, error: null }), { data: null, error: failure })
  let thrown: unknown = null
  try {
    await validateDatabase(client, 2026)
  } catch (error) {
    thrown = error
  }
  if (thrown !== failure) throw new Error('RPC error was not propagated')
})
