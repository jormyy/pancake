import type { RosterPlayer } from '@/lib/roster'

export type TradeAssetOrder = { kind: string; round?: number; seasonYear?: number }

export function orderTradeAssets<T extends TradeAssetOrder>(items: readonly T[]): T[]
export function orderTradeAssets<T>(items: readonly T[], assetOrder: (item: T) => TradeAssetOrder): T[]
export function orderTradeAssets<T>(items: readonly T[], assetOrder: (item: T) => TradeAssetOrder = item => item as TradeAssetOrder): T[] {
    const rank = (asset: TradeAssetOrder) => asset.kind === 'player' ? 0 : asset.kind === 'pick' ? 1 : 2
    return [...items].sort((left, right) => {
        const a = assetOrder(left)
        const b = assetOrder(right)
        return rank(a) - rank(b) || (a.kind === 'pick' && b.kind === 'pick'
            ? (a.round ?? Infinity) - (b.round ?? Infinity) || (a.seasonYear ?? Infinity) - (b.seasonYear ?? Infinity)
            : 0)
    })
}

export function isTradeableRosterPlayer(player: RosterPlayer, allowInactive = false): boolean {
    return allowInactive || !player.is_on_ir && !player.is_on_taxi
}
