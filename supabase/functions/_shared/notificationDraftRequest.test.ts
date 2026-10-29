import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'draft-request-test')
Deno.env.set('WEB_PUSH_VAPID_PUBLIC_KEY', 'pub')
Deno.env.set('WEB_PUSH_VAPID_PRIVATE_KEY', 'priv')
Deno.env.set('WEB_PUSH_VAPID_SUBJECT', 'mailto:ops@example.test')
const { handleDraftRoute } = await import('../api/draft.ts')
const user = '22222222-2222-4222-8222-222222222222'
const member = '33333333-3333-4333-8333-333333333333'
const draft = '44444444-4444-4444-8444-444444444444'
const player = '55555555-5555-4555-8555-555555555555'
const league = '66666666-6666-4666-8666-666666666666'

Deno.test('commissioner picks queue delivery without waiting for the push provider and skip mock picks', async () => {
  const nativeFetch = globalThis.fetch
  const queued: Record<string, unknown>[] = []
  let isMock = false
  let providerReads = 0
  let recipientReads = 0
  let release: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  globalThis.fetch = async (input, init) => {
    const options = init as RequestInit | undefined
    const url = new URL(input instanceof Request ? input.url : input)
    const table = url.pathname.split('/').at(-1)
    if (table === 'user') return Response.json({ id: user, aud: 'authenticated', role: 'authenticated' })
    if (table === 'drafts') return Response.json({ id: draft, league_id: league })
    if (table === 'league_members') {
      if (url.searchParams.get('select')?.startsWith('user_id')) recipientReads++
      return Response.json(url.searchParams.has('role') ? [{ league_id: league }]
        : { id: member, user_id: user, role: 'commissioner' })
    }
    if (table === 'commissioner_snake_pick_atomic') return Response.json({
      pick: { id: 'pick', overall_pick: 1, round: 1, pick_in_round: 1, member_id: member, draft_pick_id: null },
      player_id: player, remaining: 0, league_id: league, league_season_id: 'season', is_mock: isMock,
    })
    if (table === 'leagues') return Response.json({ roster_size: 20, taxi_slots: 2 })
    if (table === 'roster_players') return new Response(null, { headers: { 'content-range': '*/0' } })
    if (table === 'players') return Response.json({ display_name: 'Rookie' })
    if (table === 'notification_preferences') return Response.json({ draft_enabled: true })
    if (table === 'web_push_subscriptions') {
      providerReads++
      await new Promise<void>(resolve => { release = resolve })
      return Response.json([])
    }
    assert.equal(table, 'enqueue_rookie_pick_notification')
    queued.push(JSON.parse(String(options?.body)))
    return new Response(null, { status: 201 })
  }
  const path = `/draft/${draft}/commissioner-pick`
  const request = () => handleDraftRoute(new Request(`http://edge.test${path}`, { method: 'POST',
    headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ memberId: member, playerId: player }),
  }), path)
  let pending: ReturnType<typeof request> | undefined
  try {
    pending = request()
    const response = await Promise.race([pending, new Promise<null>(resolve => {
      timeout = setTimeout(() => resolve(null), 100)
    })])
    assert.equal(response?.status, 200, 'push delivery must not delay the completed pick response')
    assert.equal(providerReads, 0)
    assert.equal(recipientReads, 0)
    assert.equal(queued.length, 1)
    assert.deepEqual(queued[0], { p_draft_id: draft, p_member_id: member, p_player_id: player, p_pick_id: 'pick' })
    isMock = true
    assert.equal((await request())?.status, 200)
    assert.equal(queued.length, 1)
    assert.equal(recipientReads, 0)
  } finally {
    clearTimeout(timeout)
    release?.()
    await pending
    globalThis.fetch = nativeFetch
  }
})
