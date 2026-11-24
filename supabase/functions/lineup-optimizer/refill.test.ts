Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { processRosterRefill } = await import('./refill.ts')
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

Deno.test('one run refills exactly one waiting team and completes it with its claimed time', async () => {
  const refilled: string[] = []
  const queue = [request('a'), request('bb')]
  await withQueue(queue, async (completed) => {
    const outcome = await processRosterRefill(async (r) => { refilled.push(r.member_id); return 0 })
    assert(JSON.stringify(refilled) === '["a"]', 'A run refilled more or fewer than one team.')
    assert(JSON.stringify(completed) === JSON.stringify([{ p_member_id: 'a', p_requested_at: request('a').requested_at }]),
      'The team was not completed with the time it was claimed at.')
    assert(queue.length === 1, 'The run claimed a second team.')
    assert(outcome.refilled === 1 && outcome.failed === 0, 'The outcome miscounts refills.')
  })
})

Deno.test('a failed refill is reported and still completed so the queue moves on', async () => {
  for (const [refill, reason] of [
    [async () => { throw new Error('league is not active') }, 'league is not active'],
    [async () => 2, '2 date(s)'],
  ] as const) {
    await withQueue([request('a')], async (completed) => {
      const outcome = await processRosterRefill(refill)
      assert(completed.length === 1, 'A failed team stayed claimed.')
      assert(outcome.failed === 1 && outcome.refilled === 0, 'The failure was not counted.')
      assert(outcome.errors.some(e => e.includes(reason)), 'The failure reason was lost.')
    })
  }
})

Deno.test('an empty queue does nothing', async () => {
  await withQueue([], async (completed) => {
    const outcome = await processRosterRefill(async () => { throw new Error('should not run') })
    assert(completed.length === 0 && outcome.refilled === 0 && outcome.failed === 0, 'An empty queue did work.')
  })
})
