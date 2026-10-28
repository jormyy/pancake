import { deepStrictEqual, equal, rejects } from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:56221')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'synthetic-unit-test')
const { loadForecastContext } = await import('./context.ts')

Deno.test('forecast workers prepare each missing date before reading cached inputs', async () => {
  const nativeFetch = globalThis.fetch
  const calls: { name: string; args: Record<string, string> }[] = []
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const name = url.pathname.split('/').at(-1)!
    const args = JSON.parse(String(init?.body))
    calls.push({ name, args })
    return Promise.resolve(Response.json(name === 'prepare_matchup_forecast_inputs' ? args.p_game_date ? [] : ['2026-11-02', '2026-11-03'] : { matchupId: 'matchup' }))
  }
  try {
    equal((await loadForecastContext('matchup')).matchupId, 'matchup')
    deepStrictEqual(calls.map(call => call.name), ['prepare_matchup_forecast_inputs', 'prepare_matchup_forecast_inputs', 'prepare_matchup_forecast_inputs', 'get_prepared_matchup_forecast_context'])
    deepStrictEqual(calls.slice(1, 3).map(call => call.args.p_game_date), ['2026-11-02', '2026-11-03'])
  } finally { globalThis.fetch = nativeFetch }
})

Deno.test('forecast workers rebuild inputs after a source change and stop after three conflicts', async () => {
  const nativeFetch = globalThis.fetch
  let prepares = 0
  globalThis.fetch = input => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname.endsWith('/prepare_matchup_forecast_inputs')) { prepares++; return Promise.resolve(Response.json([])) }
    return Promise.resolve(Response.json({ code: 'PT409', message: 'Forecast inputs changed.' }, { status: 409 }))
  }
  try {
    await rejects(loadForecastContext('matchup'), error => (error as { code: string }).code === 'PT409')
    equal(prepares, 3)
  } finally { globalThis.fetch = nativeFetch }
})
