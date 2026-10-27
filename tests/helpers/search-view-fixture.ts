import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach } from 'vitest'
import { usePlayerSearch } from '@/hooks/use-player-search'
import { playerRow } from './fixtures'

export function searchPayload(ids = ['player'], hasMore = false) {
    return { context: { leagueId: 'league', memberId: 'member', seasonId: 'season', seasonYear: 2027, today: '2026-10-27', version: '1' }, players: ids.map(id => playerRow({ id })), ownedMap: {}, waiverClearsAt: {}, waiverIds: [], pendingClaimIds: [], transactionState: {}, visibleTotals: [], hasMore, claims: [], weekDays: [] }
}
const scoringSettings = { points: 1 }
export function searchHarness() {
    let latest!: ReturnType<typeof usePlayerSearch>, screen: ReactTestRenderer | undefined
    const frames: ReturnType<typeof usePlayerSearch>[] = []
    const Probe = ({ owner = 'account', member = 'member', enabled = true }: { owner?: string; member?: string; enabled?: boolean }) => { latest = usePlayerSearch('league', new Map(), new Set(), member, { ownerId: owner, enabled, scoringSettings }); frames.push(latest); return null }
    const render = async (props = {}) => { await act(async () => { if (screen) screen.update(React.createElement(Probe, props)); else screen = create(React.createElement(Probe, props)) }); await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)) }) }
    const unmount = async () => { await act(async () => screen?.unmount()); screen = undefined }
    afterEach(async () => { await unmount(); frames.length = 0 })
    return { get latest() { return latest }, frames, render, unmount }
}
