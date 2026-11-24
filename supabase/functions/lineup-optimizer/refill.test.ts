Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { processRosterRefills } = await import('./refill.ts')
type RefillRequest = import('./refill.ts').RefillRequest

const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message) }
const request = (member: string): RefillRequest => ({
  member_id: member, league_id: 'league', league_season_id: 'season', requested_at: `2026-11-24T08:00:0${member.length}.123456+00:00`,
})

async function withQueue<T>(queue: RefillRequest[], run: (completed: { p_member_id: string; p_requested_at: string }[]) => Promise<T>) {
  const original = globalThis.fetch
  const completed: { p_member_id: string; p_requested_at: string }[] = []
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    if (name === 'claim_lineup_refills') return Response.json(queue.splice(0, 1))
    if (name === 'complete_lineup_refill') { completed.push(await req.json()); return Response.json(null) }
    throw new Error(`Unexpected request ${req.url}`)
  }
  try { return await run(completed) } finally { globalThis.fetch = original }
}

Deno.test('refill re-picks every requested team once and completes each request with its own time', async () => {
  const refilled: string[] = []
  await withQueue([request('a'), request('bb')], async (completed) => {
    const outcome = await processRosterRefills(async (r) => { refilled.push(r.member_id); return 0 })
    assert(JSON.stringify(refilled) === '["a","bb"]', 'Each team was not refilled exactly once.')
    assert(JSON.stringify(completed) === JSON.stringify([
      { p_member_id: 'a', p_requested_at: request('a').requested_at },
      { p_member_id: 'bb', p_requested_at: request('bb').requested_at },
    ]), 'Requests were not completed with the time they were claimed at.')
    assert(outcome.refilled === 2 && outcome.failed === 0, 'The outcome miscounts refills.')
  })
})

Deno.test('a failed refill is reported and does not block the next team', async () => {
  await withQueue([request('a'), request('bb'), request('ccc')], async (completed) => {
    const outcome = await processRosterRefills(async (r) => {
      if (r.member_id === 'a') throw new Error('league is not active')
      return r.member_id === 'bb' ? 2 : 0
    })
    assert(completed.length === 3, 'A failed team stayed queued or stopped the run.')
    assert(outcome.refilled === 1 && outcome.failed === 2, 'Failures were not counted.')
    assert(outcome.errors.some(e => e.includes('league is not active')) && outcome.errors.some(e => e.includes('2 date(s)')),
      'Failure reasons were lost.')
  })
})

Deno.test('refill stops claiming once its time budget is spent', async () => {
  let clock = 0
  await withQueue([request('a'), request('bb')], async (completed) => {
    const outcome = await processRosterRefills(async () => { clock += 120_000; return 0 }, () => clock)
    assert(completed.length === 1 && outcome.refilled === 1, 'The run claimed work after its budget ran out.')
  })
})
