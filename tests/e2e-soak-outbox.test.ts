import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  league: { id: 'league' }, leagueSeason: { id: 'season' },
  members: [0, 1, 2].map(index => ({ id: `member-${index}`, user_id: `user-${index}` })),
}))
vi.mock('./e2e/soak-support.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('./e2e/soak-support.mjs')>(),
  createDisposableLeagueFromSeedUsers: vi.fn(async () => fixture),
  writeFile: vi.fn(),
}))
vi.mock('./e2e/soak-backend-support.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('./e2e/soak-backend-support.mjs')>(),
  backendJson: vi.fn(async () => ({})),
  findAvailablePlayer: vi.fn(async () => ({ id: 'player', display_name: 'Player' })),
}))
vi.mock('./e2e/soak-draft-playoff.mjs', () => ({
  createRookieDraftFixture: vi.fn(async () => ({ fixture, draft: { id: 'draft' },
    slots: [{ member_id: 'member-0' }], rookies: [], expectedOrder: [] })),
}))
const { assertDraftPushNotification, assertPushNotifications } = await import('./e2e/soak-waiver-push.mjs')

const client = (event: string, member: string) => {
  const filters: Record<string, unknown> = {}
  const outbox = { member_id: member, event_type: event, category: event === 'draft_auto_picked' ? 'draft' : 'waiver' }
  const from = (table: string) => {
    const result = () => table === 'notification_outbox'
      ? { data: filters.event_type === event && (event !== 'waiver_claim_won' || filters.dedupe_key === `waiver_claim_won:claim:${member}`) ? [outbox] : [], error: null }
      : { data: { id: table === 'waiver_claims' ? 'claim' : 'hold' }, error: null }
    const query = {
      update: (_value: unknown) => query,
      insert: (_value: unknown) => query,
      select: (_value: string) => query,
      eq: (key: string, value: unknown) => { if (table === 'notification_outbox') filters[key] = value; return query },
      single: async () => {
        const value = result()
        return Array.isArray(value.data) ? { data: value.data[0], error: value.data.length ? null : { message: 'No produced notification' } } : value
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    }
    return query
  }
  return { supabase: { from }, filters }
}

it('reads the waiver win written by the claim trigger without relying on its text', async () => {
  const { supabase, filters } = client('waiver_claim_won', 'member-2')
  await expect(assertPushNotifications({ supabase, env: {}, state: { runId: 'run', users: fixture.members.map(member => ({ id: member.user_id })) },
    leagueId: 'league', season: 1 })).resolves.toBeUndefined()
  expect(filters).toMatchObject({ dedupe_key: 'waiver_claim_won:claim:member-2', event_type: 'waiver_claim_won' })
})

it('reads the auto-pick event for the selected draft and recipient', async () => {
  const { supabase, filters } = client('draft_auto_picked', 'member-0')
  const result = await assertDraftPushNotification({ supabase, env: {}, state: {}, season: 1, resourceOwner: {} })
  expect(result.failures).toEqual([])
  expect(filters).toEqual({ member_id: 'member-0', event_type: 'draft_auto_picked', 'data->>draftId': 'draft' })
})
