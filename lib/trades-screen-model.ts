import type { RosterPlayer } from '@/lib/roster'
import type { Trade, TradeBlockItem, TradePickItem } from '@/lib/trades'
import type { TradeTabKey } from '@/lib/trade-ui-model'
import {
    needsMemberAcceptance,
    isOutgoingTradeForMember,
    isTradeHistoryForMember,
    isVetoableTradeForMember,
} from '@/lib/trade-perspective'

export type TradeListItem =
    | { _type: 'trade'; trade: Trade }
    | { _type: 'header'; label: string }
    | { _type: 'empty'; key: string; message: string }
    | { _type: 'blockItem'; item: TradeBlockItem }
    | { _type: 'blockPlayer'; player: RosterPlayer }
    | { _type: 'blockPick'; pick: TradePickItem }

type TradeListInput = {
    tab: TradeTabKey
    vetoableTrades: Trade[]
    incomingTrades: Trade[]
    outgoingTrades: Trade[]
    historyTrades: Trade[]
    picks: TradePickItem[]
    tradesLoading: boolean
    tradesSettled?: boolean
    /** A failed trades load: the error banner owns the message, so no empty rows. */
    tradesError?: boolean
    myBlockItems: TradeBlockItem[]
    blockLoading: boolean
    blockSettled?: boolean
    blockError?: boolean
    blockRoster: RosterPlayer[]
    leagueBlockItems: TradeBlockItem[]
}

type TradeScreenSections = Pick<TradeListInput,
    'vetoableTrades' | 'incomingTrades' | 'outgoingTrades' | 'historyTrades' | 'myBlockItems'>

export function selectTradeScreenSections(
    trades: Trade[],
    blockItems: TradeBlockItem[],
    memberId: string,
): TradeScreenSections {
    const sections: TradeScreenSections = {
        vetoableTrades: [],
        incomingTrades: [],
        outgoingTrades: [],
        historyTrades: [],
        myBlockItems: [],
    }
    for (const trade of trades) {
        if (isVetoableTradeForMember(trade, memberId)) sections.vetoableTrades.push(trade)
        if (needsMemberAcceptance(trade, memberId)) sections.incomingTrades.push(trade)
        if (isOutgoingTradeForMember(trade, memberId)) sections.outgoingTrades.push(trade)
        if (isTradeHistoryForMember(trade, memberId)) sections.historyTrades.push(trade)
    }
    for (const item of blockItems) {
        if (item.memberId === memberId) sections.myBlockItems.push(item)
    }
    return sections
}

type TradeScreenModelInput = Omit<TradeListInput, keyof TradeScreenSections> & {
    trades: Trade[]
    historyTrades?: Trade[]
    blockItems: TradeBlockItem[]
    memberId: string
}

export function buildTradeScreenModel(input: TradeScreenModelInput) {
    const selected = selectTradeScreenSections(input.trades, input.blockItems, input.memberId)
    const sections = { ...selected, historyTrades: input.historyTrades ?? selected.historyTrades }
    return {
        ...sections,
        listData: buildTradeList({ ...input, ...sections }),
        pendingInboxCount: sections.incomingTrades.length,
    }
}

export function tradeListKey(item: TradeListItem, _index: number): string {
    if (item._type === 'header') return `header-${item.label}`
    if (item._type === 'empty') return `empty-${item.key}`
    if (item._type === 'trade') return `trade-${item.trade.id}`
    if (item._type === 'blockItem') return `block-${item.item.id}`
    if (item._type === 'blockPlayer') return `block-player-${item.player.players.id}`
    return `block-pick-${item.pick.pickId}`
}

export const tradeListItemType = (item: TradeListItem) => item._type

type TradeScreenResource = 'block' | 'trades' | 'history'

export function tradeScreenResource(tab: TradeTabKey): TradeScreenResource {
    if (tab === 'block') return 'block'
    if (tab === 'history') return 'history'
    return 'trades'
}

export function buildTradeList(input: TradeListInput): TradeListItem[] {
    const result: TradeListItem[] = []
    if (input.tab === 'offers') {
        const settled = input.tradesSettled || (!input.tradesError && (input.vetoableTrades.length > 0 || input.incomingTrades.length > 0 || input.outgoingTrades.length > 0))
        if (input.vetoableTrades.length > 0) {
            result.push({ _type: 'header', label: 'Veto Window' })
            input.vetoableTrades.forEach((trade) => result.push({ _type: 'trade', trade }))
        }
        result.push({ _type: 'header', label: 'Incoming' })
        input.incomingTrades.forEach((trade) => result.push({ _type: 'trade', trade }))
        if (input.incomingTrades.length === 0 && (settled || (!input.tradesLoading && !input.tradesError))) {
            result.push({ _type: 'empty', key: 'incoming-offers', message: 'No incoming offers.' })
        }
        if (input.outgoingTrades.length > 0) {
            result.push({ _type: 'header', label: 'Outgoing' })
            input.outgoingTrades.forEach((trade) => result.push({ _type: 'trade', trade }))
        }
        return result
    }
    if (input.tab === 'block') {
        const leagueListings = input.leagueBlockItems.filter((item) => !input.myBlockItems.some((mine) => mine.id === item.id))
        result.push({ _type: 'header', label: 'League listings' })
        leagueListings.forEach((item) => result.push({ _type: 'blockItem', item }))
        if (leagueListings.length === 0 && (input.blockSettled || (!input.blockLoading && !input.blockError))) {
            result.push({ _type: 'empty', key: 'league-block-listings', message: 'No league listings yet.' })
        }
        result.push({ _type: 'header', label: 'Your listings' })
        input.myBlockItems.forEach((item) => result.push({ _type: 'blockItem', item }))
        if (input.myBlockItems.length === 0 && (input.blockSettled || (!input.blockLoading && !input.blockError))) {
            result.push({ _type: 'empty', key: 'my-block-listings', message: 'No listings yet.' })
        }
        if (input.blockRoster.length > 0) {
            result.push({ _type: 'header', label: 'List players' })
            input.blockRoster.filter((player) => !input.myBlockItems.some((item) => item.asset.kind === 'player' && item.asset.playerId === player.players.id)).forEach((player) => result.push({ _type: 'blockPlayer', player }))
        }
        if (input.picks.length > 0) {
            result.push({ _type: 'header', label: 'List picks' })
            input.picks.filter((pick) => !input.myBlockItems.some((item) => item.asset.kind === 'pick' && item.asset.pickId === pick.pickId)).forEach((pick) => result.push({ _type: 'blockPick', pick }))
        }
        return result
    }
    input.historyTrades.forEach((trade) => result.push({ _type: 'trade', trade }))
    if (input.historyTrades.length === 0 && (input.tradesSettled || (!input.tradesLoading && !input.tradesError))) {
        result.push({ _type: 'empty', key: 'trade-history', message: 'No completed trades yet.' })
    }
    return result
}
