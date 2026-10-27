import { boundary, bumpView, held } from '../helpers/screen-view-boundary'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import type { LeagueTab } from '@/lib/league/tabs'
import { useLeagueTabResources } from '@/hooks/use-league-tab-resources'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer | undefined
let latest: ReturnType<typeof useLeagueTabResources>
const frames: string[][] = []
const Probe = ({ league = 'league', member = 'member', authorized = true, tab = 'results' }: { league?: string; member?: string; authorized?: boolean; tab?: LeagueTab }) => {
    latest = useLeagueTabResources(league, member, tab, authorized)
    frames.push(latest.standings.map(row => row.memberId))
    return null
}
const payload = (memberId: string) => ({ standings: [{ memberId }] })
const mount = async () => { await act(async () => { screen = create(React.createElement(Probe)) }) }
afterEach(async () => { await act(async () => screen?.unmount()); screen = undefined; frames.length = 0 })

it('retains visible standings offline and replaces them after the next version check', async () => {
    boundary.read.mockResolvedValue(payload('saved'))
    await mount()
    boundary.online = false
    await act(async () => screen!.update(React.createElement(Probe)))
    expect(latest.standings[0].memberId).toBe('saved')
    const next = held<ReturnType<typeof payload>>()
    boundary.read.mockReturnValueOnce(next.promise)
    boundary.online = true
    bumpView()
    await act(async () => screen!.update(React.createElement(Probe)))
    expect(latest.standings[0].memberId).toBe('saved')
    await act(async () => next.resolve(payload('fresh')))
    expect(latest.standings[0].memberId).toBe('fresh')
    expect(boundary.read.mock.calls.every(([scope]) => scope.screen === 'league' && scope.params.tab === 'results')).toBe(true)
})

it('defers an inactive route reconnect until focus returns', async () => {
    boundary.read.mockResolvedValue(payload('saved'))
    await mount()
    boundary.focused = false; boundary.online = false
    await act(async () => screen!.update(React.createElement(Probe)))
    boundary.online = true
    bumpView()
    await act(async () => screen!.update(React.createElement(Probe)))
    expect(boundary.read).toHaveBeenCalledTimes(1)
    boundary.focused = true
    await act(async () => screen!.update(React.createElement(Probe)))
    expect(boundary.read).toHaveBeenCalledTimes(2)
})

it('rejects a former league response after the league changes', async () => {
    const old = held<ReturnType<typeof payload>>()
    boundary.read.mockReturnValueOnce(old.promise).mockResolvedValue(payload('new-member'))
    await mount()
    await act(async () => screen!.update(React.createElement(Probe, { league: 'other' })))
    frames.length = 0
    await act(async () => old.resolve(payload('old-member')))
    expect(latest.standings[0].memberId).toBe('new-member')
    expect(frames.flat()).not.toContain('old-member')
})

it('retains standings after a failed reconnect and recovers through explicit retry', async () => {
    boundary.read.mockResolvedValue(payload('saved'))
    await mount()
    boundary.read.mockRejectedValueOnce(new Error('network failed'))
    await act(async () => bumpView())
    expect(latest.standings[0].memberId).toBe('saved')
    expect(latest.tabError).toBe('network failed')
    boundary.read.mockResolvedValue(payload('recovered'))
    await act(async () => latest.refreshTab('results'))
    expect(latest.tabError).toBeUndefined()
    expect(latest.standings[0].memberId).toBe('recovered')
})

it('does not start a view read before membership validation', async () => {
    boundary.read.mockResolvedValue(payload('validated'))
    await act(async () => { screen = create(React.createElement(Probe, { authorized: false })) })
    expect(boundary.read).not.toHaveBeenCalled()
    await act(async () => screen!.update(React.createElement(Probe)))
    expect(latest.standings[0].memberId).toBe('validated')
})

it('defers an inactive initial view and its manual retry until focus returns', async () => {
    boundary.focused = false
    boundary.read.mockResolvedValue(payload('visible'))
    await mount()
    await act(async () => latest.refreshTab('results'))
    expect(boundary.read).not.toHaveBeenCalled()
    boundary.focused = true
    await act(async () => screen!.update(React.createElement(Probe)))
    expect(latest.standings[0].memberId).toBe('visible')
})

it('reads only the selected panel and catches its dirty cached view on return', async () => {
    boundary.read.mockImplementation(async scope => scope.params.tab === 'results' ? payload('standings') : { rows: [{ id: 'activity' }] })
    await mount()
    expect(boundary.read).toHaveBeenCalledTimes(1)
    await act(async () => screen!.update(React.createElement(Probe, { tab: 'history' })))
    expect(latest.transactions.map(row => row.id)).toEqual(['activity'])
    await act(async () => bumpView())
    await act(async () => screen!.update(React.createElement(Probe)))
    expect(latest.standings[0].memberId).toBe('standings')
    expect(boundary.read.mock.calls.map(([scope]) => scope.params.tab)).toEqual(['results', 'history', 'history', 'results'])
})

it('keeps activity rows through a forced refresh and replaces them with the complete reply', async () => {
    boundary.read.mockResolvedValue({ rows: [{ id: 'saved' }] })
    await act(async () => { screen = create(React.createElement(Probe, { tab: 'history' })) })
    const next = held<{ rows: { id: string }[] }>()
    boundary.read.mockReturnValueOnce(next.promise)
    let refresh!: Promise<void>
    await act(async () => { refresh = latest.refreshTab('history') })
    expect(latest.transactions.map(row => row.id)).toEqual(['saved'])
    await act(async () => { next.resolve({ rows: [{ id: 'fresh' }] }); await refresh })
    expect(latest.transactions.map(row => row.id)).toEqual(['fresh'])
})

it('does not accept a suspended reply for a former member', async () => {
    const old = held<ReturnType<typeof payload>>()
    boundary.read.mockReturnValueOnce(old.promise).mockResolvedValue(payload('new-member'))
    await mount()
    await act(async () => screen!.update(React.createElement(Probe, { member: 'next' })))
    await act(async () => old.resolve(payload('old-member')))
    expect(latest.standings[0].memberId).toBe('new-member')
})

it('shows the newest server view after a version changes during a suspended read', async () => {
    const old = held<ReturnType<typeof payload>>()
    boundary.read.mockReturnValueOnce(old.promise).mockResolvedValue(payload('authoritative'))
    await mount()
    await act(async () => bumpView())
    await act(async () => old.resolve(payload('stale')))
    expect(latest.standings[0].memberId).toBe('authoritative')
    expect(boundary.read).toHaveBeenCalledTimes(2)
})
