Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:1')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { summarizeBoundaryFailures } = await import('./seasonBoundary.ts')

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

Deno.test('no failures yields null so the run is recorded as success', () => {
  assert(summarizeBoundaryFailures([{ leagueId: 'a', actions: [] }]) === null, 'expected null')
  assert(summarizeBoundaryFailures([]) === null, 'expected null for empty')
})

Deno.test('a failed league is counted and named', () => {
  const summary = summarizeBoundaryFailures([
    { leagueId: 'ok', actions: ['advanced'] },
    { leagueId: 'bad', actions: [], error: 'boom' },
  ])
  assert(summary === '1 of 2 league(s) failed — bad: boom', `unexpected summary: ${summary}`)
})

Deno.test('the sample is capped at five leagues', () => {
  const reports = Array.from({ length: 8 }, (_, i) => ({ leagueId: `l${i}`, actions: [], error: 'x' }))
  const summary = summarizeBoundaryFailures(reports) ?? ''
  assert(summary.startsWith('8 of 8 league(s) failed'), summary)
  assert((summary.match(/: x/g) ?? []).length === 5, 'expected five samples')
})
