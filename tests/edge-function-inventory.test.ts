import { describe, expect, it } from 'vitest'
import {
    checkInventory,
    inventoryFailures,
} from '../scripts/check-edge-functions.mjs'

describe('Supabase Edge function inventory', () => {
    it('keeps every configured function in the dynamic check set', () => {
        const { entrypoints } = checkInventory()
        const names = entrypoints.map((file) => file.split('/').at(-2))

        expect(names).toEqual(expect.arrayContaining([
            'backfill',
            'live-poll',
            'sync-draft-order',
            'sync-players',
            'sync-schedule',
            'sync-stats',
            'verify',
        ]))
    })

    it('mutation-proves missing and unconfigured entrypoints are rejected', () => {
        expect(inventoryFailures(['api', 'verify'], ['api'])).toEqual([
            'configured function verify has no index.ts',
        ])
        expect(inventoryFailures(['api'], ['api', 'rogue'])).toEqual([
            'Edge entrypoint rogue is missing from config.toml',
        ])
    })
})
