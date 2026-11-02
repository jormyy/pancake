import { deepStrictEqual, equal, rejects } from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:56221')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'synthetic-unit-test')
const { loadForecastContext } = await import('./context.ts')
const packed=()=>({wireVersion:1,matchupId:'matchup',observedAt:'2026-11-01T12:00:00Z',today:'2026-11-01',weekEnd:'2026-11-07',isFinalized:false,teams:[],roster:[],games:[],history:[],projections:[],lineups:[],templates:[],seasonAverages:[],automaticMembers:[],previous:null})

Deno.test('forecast workers prepare each missing date before reading cached inputs', async () => {
  const nativeFetch = globalThis.fetch
  const calls: { name: string; args: Record<string, string> }[] = []
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const name = url.pathname.split('/').at(-1)!
    const args = JSON.parse(String((init as { body?: unknown } | undefined)?.body))
    calls.push({ name, args })
    return Promise.resolve(Response.json(name === 'prepare_matchup_forecast_inputs' ? args.p_game_date ? [] : ['2026-11-02', '2026-11-03'] : packed()))
  }
  try {
    equal((await loadForecastContext('matchup')).matchupId, 'matchup')
    deepStrictEqual(calls.map(call => call.name), ['prepare_matchup_forecast_inputs', 'prepare_matchup_forecast_inputs', 'prepare_matchup_forecast_inputs', 'get_compact_matchup_forecast_context'])
    deepStrictEqual(calls.slice(1, 3).map(call => call.args.p_game_date), ['2026-11-02', '2026-11-03'])
  } finally { globalThis.fetch = nativeFetch }
})

Deno.test('forecast workers prepare all dates in one call with the batched backend', async () => {
  const nativeFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = input => {
    const url = new URL(input instanceof Request ? input.url : input)
    const name = url.pathname.split('/').at(-1)!
    calls.push(name)
    return Promise.resolve(Response.json(name === 'prepare_matchup_forecast_inputs' ? [] : packed()))
  }
  try {
    equal((await loadForecastContext('matchup')).matchupId, 'matchup')
    deepStrictEqual(calls, ['prepare_matchup_forecast_inputs', 'get_compact_matchup_forecast_context'])
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

Deno.test('forecast input decoding restores the original row contract',async()=>{
  const nativeFetch=globalThis.fetch
  globalThis.fetch=async input=>{
    const name=new URL(input instanceof Request?input.url:input).pathname.split('/').at(-1)
    return Response.json(name==='prepare_matchup_forecast_inputs'?[]:{...packed(),roster:[['member','player',false,false,'BOS',['PG'],null]]})
  }
  try {equal((await loadForecastContext('matchup')).roster[0].player_id,'player')}
  finally {globalThis.fetch=nativeFetch}
})
