import { describe, expect, it, vi } from 'vitest'

type DraftSubscription = {
    watches: { table: string; filter: string; event?: string }[]
}

const mocks = vi.hoisted(() => ({
    subscribe: vi.fn((_channelName: string, _subscription: DraftSubscription) => ({ topic: 'draft' })),
}))

vi.mock('@/lib/realtime', () => ({
    subscribeToTableChanges: mocks.subscribe,
}))
vi.mock('@/lib/supabase', () => ({
    supabase: { removeChannel: vi.fn(async () => undefined) },
}))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))

import { subscribeToDraft } from '@/lib/draft'

describe('auction draft realtime watches', () => {
    it('uses the nomination update as the single signal for each bid', () => {
        const refresh = vi.fn()
        subscribeToDraft('draft-1', 'league-1', refresh)

        const subscription = mocks.subscribe.mock.calls[0]?.[1]
        expect(subscription?.watches).toEqual([
            { table: 'nominations', filter: 'draft_id=eq.draft-1' },
            { table: 'draft_budgets', filter: 'draft_id=eq.draft-1' },
            { table: 'drafts', event: 'UPDATE', filter: 'id=eq.draft-1' },
        ])
    })
})
