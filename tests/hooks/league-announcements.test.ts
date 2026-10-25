import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useLeagueAnnouncements } from '@/hooks/use-league-announcements'
import { listLeagueAnnouncements } from '@/lib/league-announcements'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let latest: ReturnType<typeof useLeagueAnnouncements>
const Probe = ({ league = 'league', enabled = true }: { league?: string; enabled?: boolean }) => { latest = useLeagueAnnouncements('owner', league, enabled); return null }
beforeEach(() => { rpc.mockReset().mockResolvedValue({ data: [], error: null }) })
afterEach(async () => { await act(async () => screen?.unmount()); vi.unstubAllGlobals() })

it('calls the existing announcement RPC with its exact named argument', async () => {
    await expect(listLeagueAnnouncements('league')).resolves.toEqual([])
    expect(rpc).toHaveBeenCalledExactlyOnceWith('notif_list_announcements', { p_league_id: 'league' })
})

it('waits for the announcement read before revealing and keeps its result stable after first load', async () => {
    let finish!: (value: unknown) => void
    rpc.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await act(async () => { screen = create(React.createElement(Probe)) })
    expect(latest.loaded).toBe(false)
    await act(async () => finish({ data: [{ id: 'new', body: 'Draft tonight.' }], error: null }))
    expect(latest.loaded).toBe(true)
    expect(latest.announcements[0].body).toBe('Draft tonight.')
    await act(async () => screen.update(React.createElement(Probe)))
    expect(rpc).toHaveBeenCalledOnce()
})

it('drops a late former-league response and defers reads until authorized', async () => {
    let finish!: (value: unknown) => void
    rpc.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await act(async () => { screen = create(React.createElement(Probe, { enabled: false })) })
    expect(rpc).not.toHaveBeenCalled()
    await act(async () => screen.update(React.createElement(Probe)))
    await act(async () => screen.update(React.createElement(Probe, { league: 'new-league' })))
    await act(async () => finish({ data: [{ id: 'private-old-league' }], error: null }))
    expect(latest.announcements).toEqual([])
    expect(latest.loaded).toBe(true)
})

it('allows Home content to render if the announcement read fails', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('offline') })
    await act(async () => { screen = create(React.createElement(Probe)) })
    expect(latest.loaded).toBe(true)
    expect(latest.announcements).toEqual([])
})
