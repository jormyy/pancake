import type { DynastyTradeAnalysis } from '@/core/src/dynasty/decisionEngine'
import type { RosterPlayer } from '@/lib/roster'

export type TradeAssetOrder = {
    kind: string
    round?: number
    seasonYear?: number
    tradeValue?: number | null
    playerName?: string
    playerId?: string
}

export function tradeRosterAssetOrder(player: RosterPlayer): TradeAssetOrder {
    return { kind: 'player', tradeValue: player.tradeValue, playerName: player.players.display_name, playerId: player.players.id }
}

export function tradeAnalysisAssetOrder(asset: DynastyTradeAnalysis['assets'][number] & Pick<TradeAssetOrder, 'round' | 'seasonYear'>): TradeAssetOrder {
    const pick = asset.kind === 'pick' ? asset.label.match(/^(\d{4}) Round (\d+)(?:$| · )/) : null
    return {
        ...asset,
        round: asset.round ?? (pick ? Number(pick[2]) : undefined),
        seasonYear: asset.seasonYear ?? (pick ? Number(pick[1]) : undefined),
        tradeValue: asset.missingInputs.includes('imported player value') ? null : asset.values.overall,
        playerName: asset.label,
        playerId: asset.assetId,
    }
}

const playerValue = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000 ? value : -Infinity
const compareKey = (left = '', right = '') => left < right ? -1 : left > right ? 1 : 0

export function orderTradeAssets<T extends TradeAssetOrder>(items: readonly T[]): T[]
export function orderTradeAssets<T>(items: readonly T[], assetOrder: (item: T) => TradeAssetOrder): T[]
export function orderTradeAssets<T>(items: readonly T[], assetOrder: (item: T) => TradeAssetOrder = item => item as TradeAssetOrder): T[] {
    const rank = (asset: TradeAssetOrder) => asset.kind === 'player' ? 0 : asset.kind === 'pick' ? 1 : 2
    return [...items].sort((left, right) => {
        const a = assetOrder(left)
        const b = assetOrder(right)
        return rank(a) - rank(b) || (a.kind === 'pick' && b.kind === 'pick'
            ? (a.round ?? Infinity) - (b.round ?? Infinity) || (a.seasonYear ?? Infinity) - (b.seasonYear ?? Infinity)
            : a.kind === 'player' && b.kind === 'player'
                ? (playerValue(b.tradeValue) - playerValue(a.tradeValue) || 0)
                    || compareKey(a.playerName, b.playerName) || compareKey(a.playerId, b.playerId)
                : 0)
    })
}

export function isTradeableRosterPlayer(player: RosterPlayer, allowInactive = false): boolean {
    return allowInactive || !player.is_on_ir && !player.is_on_taxi
}
