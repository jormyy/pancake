import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { usePublicLiveSnapshot } from '@/hooks/use-public-live-snapshot'
import type { LiveViewGame } from '@/lib/cache/view-types'

const activity = vi.hoisted(() => ({ active: true }))
vi.mock('@/hooks/use-browser-read-activity', () => ({ useBrowserReadActivity: () => activity }))
vi.mock('@/contexts/panel-activity', () => ({ usePanelActivity: () => true }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer | undefined
let latest: ReturnType<typeof usePublicLiveSnapshot>
const Probe = ({ games }: { games: LiveViewGame[] }) => {
    latest = usePublicLiveSnapshot('2026-10-30', games, true)
    return null
}
afterEach(async () => { await act(async () => screen?.unmount()); vi.unstubAllGlobals(); vi.useRealTimers() })

it('polls unfinished dates every thirty seconds and stops while hidden or after handoff', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-30T08:05:00Z'))
    activity.active = true
    const fetch = vi.fn(async (url: string) => Response.json({ version: 1, mode: 'public', date: url.slice(-10), capturedAt: Date.now(), games: [] }))
    vi.stubGlobal('fetch', fetch)
    const games = ['2026-10-29', '2026-10-30'].map((date, index) => ({ nba_game_id: String(index), game_date: date,
        status: 'InProgress', game_time: null, stats_synced_at: null }))
    await act(async () => { screen = create(React.createElement(Probe, { games })) })
    expect(fetch.mock.calls.map(call => call[0]).sort()).toEqual(['/api/live/2026-10-29', '/api/live/2026-10-30'])
    expect(latest.snapshots).toHaveLength(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(31000) })
    expect(fetch).toHaveBeenCalledTimes(4)
    activity.active = false
    await act(async () => { screen!.update(React.createElement(Probe, { games })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(fetch).toHaveBeenCalledTimes(4)
    activity.active = true
    await act(async () => { screen!.update(React.createElement(Probe, { games })) })
    expect(fetch).toHaveBeenCalledTimes(6)
    await act(async () => { screen!.update(React.createElement(Probe, { games: games.map(game => ({ ...game, status: 'Final', stats_synced_at: new Date().toISOString() })) })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(latest.active).toBe(false)
})

it('starts polling when a schedule arrives after its tipoff',async()=>{
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']})
    const opened=Date.parse('2026-10-30T23:00:00Z')
    vi.setSystemTime(opened)
    activity.active=true
    const fetch=vi.fn(async()=>Response.json({version:1,mode:'public',date:'2026-10-30',capturedAt:Date.now(),games:[]}))
    vi.stubGlobal('fetch',fetch)
    await act(async()=>{screen=create(React.createElement(Probe,{games:[]}))})
    await act(async()=>{await vi.advanceTimersByTimeAsync(2000)})
    await act(async()=>{screen!.update(React.createElement(Probe,{games:[{
        nba_game_id:'0021',game_date:'2026-10-30',status:'Scheduled',game_time:new Date(opened+1000).toISOString(),stats_synced_at:null,
    }]}))})
    expect(latest.active).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
})

it('keeps the wake timer for a future scheduled tipoff',async()=>{
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']})
    const opened=Date.parse('2026-10-30T23:00:00Z')
    vi.setSystemTime(opened)
    activity.active=true
    const fetch=vi.fn(async()=>Response.json({version:1,mode:'public',date:'2026-10-30',capturedAt:Date.now(),games:[]}))
    vi.stubGlobal('fetch',fetch)
    await act(async()=>{screen=create(React.createElement(Probe,{games:[{
        nba_game_id:'0021',game_date:'2026-10-30',status:'Scheduled',game_time:new Date(opened+1000).toISOString(),stats_synced_at:null,
    }]}))})
    expect(fetch).not.toHaveBeenCalled()
    await act(async()=>{await vi.advanceTimersByTimeAsync(1001)})
    expect(fetch).toHaveBeenCalledOnce()
})
