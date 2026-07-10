import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useLeagues } from '@/hooks/use-leagues'

const mocks = vi.hoisted(() => ({ fetchUserLeagues: vi.fn() }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/lib/league', () => ({ fetchUserLeagues: mocks.fetchUserLeagues }))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: vi.fn(() => undefined),
    removePersistentCache: vi.fn(),
    writePersistentCache: vi.fn(),
}))
vi.mock('@/lib/realtime', () => ({
    subscribeToTableChanges: vi.fn(() => ({ topic: 'leagues' })),
    unsubscribeFromTableChanges: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('league refresh contract', () => {
    it('returns the authoritative load promise', async () => {
        let resolveRefresh!: (rows: never[]) => void
        const pending = new Promise<never[]>((resolve) => { resolveRefresh = resolve })
        mocks.fetchUserLeagues.mockResolvedValueOnce([]).mockReturnValueOnce(pending)
        let latest!: ReturnType<typeof useLeagues>
        const Probe = () => { latest = useLeagues(); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })

        let settled = false
        let refresh!: Promise<void>
        await act(async () => {
            refresh = latest.refresh().then(() => { settled = true })
            await Promise.resolve()
        })
        expect(settled).toBe(false)
        await act(async () => { resolveRefresh([]); await refresh })
        expect(settled).toBe(true)
        await act(async () => { renderer.unmount() })
    })
})
