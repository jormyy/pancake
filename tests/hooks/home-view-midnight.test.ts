import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMatchupData } from '@/hooks/use-matchup-data'
import { clearScreenViews } from '@/lib/cache/screen-cache'
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => 'account', sessionGeneration: () => 0, onSessionCachesCleared: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: 'account' }, access_token: 'synthetic' } } }) } } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let renderer: ReactTestRenderer | undefined
afterEach(async () => { if (renderer) await act(async () => renderer?.unmount()); renderer = undefined; vi.useRealTimers(); vi.unstubAllGlobals() })
it('reads the new daily view at ET midnight without polling unchanged data', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T03:59:30Z')); clearScreenViews()
    const dates: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        const url = new URL(input)
        if (url.pathname.endsWith('/version')) return new Response(JSON.stringify({ version: '1', changes: [] }))
        const params = JSON.parse(url.searchParams.get('params')!)
        dates.push(params.date)
        return new Response(JSON.stringify({ ok: true, view: { context: {}, matchup: null, selectedDate: params.date } }))
    }))
    let latest!: ReturnType<typeof useMatchupData>
    const Probe = () => { latest = useMatchupData({ id: 'member' }, { id: 'account' }, { id: 'league' }); return null }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(latest.selectedDate).toBe('2026-10-27')
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    expect(latest.selectedDate).toBe('2026-10-28')
    expect(dates).toEqual(['2026-10-27', '2026-10-28'])
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000) })
    expect(dates).toHaveLength(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000) })
    expect(latest.selectedDate).toBe('2026-10-29')
    expect(dates).toEqual(['2026-10-27', '2026-10-28', '2026-10-29'])
})
