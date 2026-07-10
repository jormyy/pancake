import type { RosterPlayer } from '@/lib/roster'
import type { Trade, TradeBlockItem, TradePickItem } from '@/lib/trades'
import type { TradeTabKey } from '@/lib/trade-ui-model'
import {
    isIncomingTradeForMember,
    isOutgoingTradeForMember,
    isTradeHistoryForMember,
    isVetoableTradeForMember,
} from '@/lib/trade-perspective'

export type TradeListItem =
    | { _type: 'trade'; trade: Trade }
    | { _type: 'header'; label: string }
    | { _type: 'empty'; key: string; message: string }
    | { _type: 'pick'; pick: TradePickItem }
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
    myBlockItems: TradeBlockItem[]
    blockLoading: boolean
    blockRoster: RosterPlayer[]
    leagueBlockItems: TradeBlockItem[]
}

export type TradeScreenSections = Pick<TradeListInput,
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
        if (isIncomingTradeForMember(trade, memberId)) sections.incomingTrades.push(trade)
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
    blockItems: TradeBlockItem[]
    memberId: string
}

export function buildTradeScreenModel(input: TradeScreenModelInput) {
    const sections = selectTradeScreenSections(input.trades, input.blockItems, input.memberId)
    return {
        ...sections,
        listData: buildTradeList({ ...input, ...sections }),
        pendingInboxCount: sections.incomingTrades.length,
    }
}

export function tradeListKey(item: TradeListItem, index: number): string {
    if (item._type === 'header') return `header-${index}`
    if (item._type === 'empty') return `empty-${item.key}`
    if (item._type === 'trade') return `trade-${item.trade.id}`
    if (item._type === 'blockItem') return `block-${item.item.id}`
    if (item._type === 'blockPlayer') return `block-player-${item.player.players.id}`
    if (item._type === 'blockPick') return `block-pick-${item.pick.pickId}`
    return `pick-${item.pick.pickId}`
}

export const tradeListItemType = (item: TradeListItem) => item._type

export type TradeScreenResource = 'picks' | 'block' | 'trades'

export function tradeScreenResource(tab: TradeTabKey): TradeScreenResource {
    if (tab === 'picks') return 'picks'
    if (tab === 'block' || tab === 'leagueBlock') return 'block'
    return 'trades'
}

export function tradeLoadingMessage(tab: TradeTabKey): string {
    if (tab === 'picks') return 'Loading draft picks'
    if (tab === 'block') return 'Loading your trade block'
    if (tab === 'leagueBlock') return 'Loading league trade block'
    if (tab === 'history') return 'Loading trade history'
    return 'Loading trade offers'
}

export function buildTradeList(input: TradeListInput): TradeListItem[] {
    const result: TradeListItem[] = []
    if (input.tab === 'picks') {
        const sorted = [...input.picks].sort((left, right) =>
            left.seasonYear - right.seasonYear || left.round - right.round ||
            left.originalTeamName.localeCompare(right.originalTeamName) || left.pickId.localeCompare(right.pickId))
        let lastYear: number | null = null
        for (const pick of sorted) {
            if (pick.seasonYear !== lastYear) {
                result.push({ _type: 'header', label: `${pick.seasonYear} Picks` })
                lastYear = pick.seasonYear
            }
            result.push({ _type: 'pick', pick })
        }
        return result
    }
    if (input.tab === 'offers') {
        if (input.vetoableTrades.length > 0) {
            result.push({ _type: 'header', label: 'Veto Window' })
            input.vetoableTrades.forEach((trade) => result.push({ _type: 'trade', trade }))
        }
        result.push({ _type: 'header', label: 'Incoming' })
        input.incomingTrades.forEach((trade) => result.push({ _type: 'trade', trade }))
        if (input.incomingTrades.length === 0 && !input.tradesLoading) {
            result.push({ _type: 'empty', key: 'incoming-offers', message: 'No incoming offers.' })
        }
        result.push({ _type: 'header', label: 'Outgoing' })
        input.outgoingTrades.forEach((trade) => result.push({ _type: 'trade', trade }))
        if (input.outgoingTrades.length === 0 && !input.tradesLoading) {
            result.push({ _type: 'empty', key: 'outgoing-offers', message: 'No outgoing offers.' })
        }
        return result
    }
    if (input.tab === 'block') {
        result.push({ _type: 'header', label: 'Your Listings' })
        input.myBlockItems.forEach((item) => result.push({ _type: 'blockItem', item }))
        if (input.myBlockItems.length === 0 && !input.blockLoading) {
            result.push({ _type: 'empty', key: 'my-block-listings', message: 'No listings yet.' })
        }
        result.push({ _type: 'header', label: 'List Your Players' })
        input.blockRoster.forEach((player) => result.push({ _type: 'blockPlayer', player }))
        result.push({ _type: 'header', label: 'List Your Picks' })
        input.picks.forEach((pick) => result.push({ _type: 'blockPick', pick }))
        return result
    }
    if (input.tab === 'leagueBlock') {
        result.push({ _type: 'header', label: 'League Trade Block' })
        input.leagueBlockItems.forEach((item) => result.push({ _type: 'blockItem', item }))
        if (input.leagueBlockItems.length === 0 && !input.blockLoading) {
            result.push({ _type: 'empty', key: 'league-block-listings', message: 'No league listings yet.' })
        }
        return result
    }
    result.push({ _type: 'header', label: 'Trade History' })
    input.historyTrades.forEach((trade) => result.push({ _type: 'trade', trade }))
    if (input.historyTrades.length === 0 && !input.tradesLoading) {
        result.push({ _type: 'empty', key: 'trade-history', message: 'No completed trades yet.' })
    }
    return result
}
