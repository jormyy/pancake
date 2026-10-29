export type AssetLock = {
    assetKind: 'player' | 'pick'
    assetId: string
    sourceKind: 'trade' | 'claim'
    sourceId: string
    reason: string
}

export function readAssetLocks(value: unknown): AssetLock[] {
    if (!value || typeof value !== 'object' || !('assetLocks' in value) || !Array.isArray(value.assetLocks)) return []
    return value.assetLocks.filter((lock): lock is AssetLock => Boolean(lock && typeof lock === 'object'
        && (lock.assetKind === 'player' || lock.assetKind === 'pick') && typeof lock.assetId === 'string'
        && (lock.sourceKind === 'trade' || lock.sourceKind === 'claim') && typeof lock.sourceId === 'string'
        && typeof lock.reason === 'string'))
}

export function lockLink(lock: AssetLock): string {
    return lock.sourceKind === 'trade' ? `/trades?tradeId=${encodeURIComponent(lock.sourceId)}`
        : `/players?section=waivers&claimId=${encodeURIComponent(lock.sourceId)}`
}
