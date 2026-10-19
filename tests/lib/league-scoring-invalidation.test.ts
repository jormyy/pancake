import { beforeEach, expect, it, vi } from 'vitest'
import { updateLeagueConfiguration } from '@/lib/league'
import { listenForLeagueChanges } from '@/lib/league-changes'
import { setSessionOwner } from '@/lib/session-cache-registry'

const state = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: state.rpc } }))
beforeEach(() => { vi.clearAllMocks(); setSessionOwner('first') })

it('invalidates current scoring after a successful save and ignores unrelated or failed saves', async () => {
    const listener = vi.fn()
    const stop = listenForLeagueChanges('league', listener)
    try {
        state.rpc.mockResolvedValue({ error: null })
        await updateLeagueConfiguration('league', { scoring_settings: { points: 2 } }, null)
        expect(listener).toHaveBeenCalledExactlyOnceWith({ topic: 'resources', scopes: null })
        await updateLeagueConfiguration('league', { roster_size: 20 }, null)
        state.rpc.mockResolvedValueOnce({ error: new Error('save refused') })
        await expect(updateLeagueConfiguration('league', { scoring_settings: { points: 3 } }, null)).rejects.toThrow('save refused')
        expect(listener).toHaveBeenCalledTimes(1)
    } finally { stop() }
})

it('does not invalidate the next account from a previous account save completion', async () => {
    let release!: (value: { error: null }) => void
    state.rpc.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const save = updateLeagueConfiguration('league', { scoring_settings: { points: 2 } }, null)
    setSessionOwner('second')
    const listener = vi.fn()
    const stop = listenForLeagueChanges('league', listener)
    try {
        release({ error: null })
        await save
        expect(listener).not.toHaveBeenCalled()
    } finally { stop() }
})
