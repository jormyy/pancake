import { assertPrivateLockStack } from '../e2e/pending-asset-locks.mjs'
import { describe, expect, it } from 'vitest'
import { assetLockReason, readAssetLocks, type AssetLock } from '@/lib/locked-assets'

const trade: AssetLock = { assetKind: 'player', assetId: 'player', sourceKind: 'trade', sourceId: 'trade-id', reason: 'Cancel this trade.' }
const claim: AssetLock = { ...trade, sourceKind: 'claim', sourceId: 'claim-id', reason: 'Cancel this claim.' }

describe('asset lock presentation', () => {
    it('uses the server reason and both simultaneous reservations', () => {
        expect(readAssetLocks({ assetLocks: [trade, claim] })).toEqual([trade, claim])
    })
    it('tolerates old snapshots and rejects malformed locks', () => {
        for (const value of [null, {}, { assetLocks: {} }, { assetLocks: [null, {}, { ...trade, sourceKind: 'other' }] }]) {
            expect(readAssetLocks(value)).toEqual([])
        }
    })
    it('uses short reasons without source ids and collapses repeated reservations', () => {
        expect(assetLockReason([])).toBeUndefined()
        expect(assetLockReason([trade, trade])).toBe('Locked by a pending trade')
        expect(assetLockReason([claim, claim])).toBe('Locked by a pending waiver claim')
        expect(assetLockReason([trade, claim])).toBe('Locked by a pending trade and a pending waiver claim')
    })
})

it('confines browser verification to the assigned private stack', () => {
    expect(() => assertPrivateLockStack('http://127.0.0.1:59821')).not.toThrow()
    expect(() => assertPrivateLockStack('https://example.supabase.co')).toThrow()
    expect(() => assertPrivateLockStack('http://127.0.0.1:54321')).toThrow()
})
