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

export function assetLockReason(locks: readonly AssetLock[]): string | undefined {
    const trade = locks.some(lock => lock.sourceKind === 'trade')
    const claim = locks.some(lock => lock.sourceKind === 'claim')
    if (trade && claim) return 'Locked by a pending trade and a pending waiver claim'
    if (trade) return 'Locked by a pending trade'
    if (claim) return 'Locked by a pending waiver claim'
    return undefined
}
