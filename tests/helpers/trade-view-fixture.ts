import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach } from 'vitest'
import { useTradesFeed } from '@/hooks/use-trades-feed'
import { useTradeHistoryFeed } from '@/hooks/use-trade-history-feed'
import { useTradeBlock } from '@/hooks/use-trade-block'
import { trade, rosterPlayer } from './fixtures'

export const tradePayload = (ids = ['first'], cursor: string | null = null) => ({ trades: ids.map(id => trade({ id })), nextCursor: cursor ? { token: cursor } : null, hasMore: cursor !== null })
export const blockPayload = () => ({ roster: [rosterPlayer()], avgMap: {}, avgStatsMap: {}, picks: [], items: [], claims: [], slotPlan: { slots: [], assignments: {} } })
export function tradeHarness() {
    let offers!: ReturnType<typeof useTradesFeed>, history!: ReturnType<typeof useTradeHistoryFeed>, block!: ReturnType<typeof useTradeBlock>, screen: ReactTestRenderer | undefined
    const frames: { offers: typeof offers; history: typeof history; block: typeof block }[] = []
    const Probe = ({ member = 'member', online = true, tab = 'offers' }: { member?: string; online?: boolean; tab?: string }) => { offers = useTradesFeed(member, 'league', online && tab === 'offers'); history = useTradeHistoryFeed(member, 'league', online && tab === 'history'); block = useTradeBlock(member, 'league', online, { visible: tab === 'block' }); frames.push({ offers, history, block }); return null }
    const render = async (props = {}) => { await act(async () => { if (screen) screen.update(React.createElement(Probe, props)); else screen = create(React.createElement(Probe, props)) }); await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)) }) }
    afterEach(async () => { await act(async () => screen?.unmount()); screen = undefined; frames.length = 0 })
    return { get offers() { return offers }, get history() { return history }, get block() { return block }, frames, render }
}
