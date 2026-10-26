import { it } from 'vitest'
import { verifyPlayersEmptyRecovery } from './e2e/players-empty-recovery.mjs'

it.skipIf(!process.env.PLAYER_SEARCH_FIXTURE)('recovers empty player results on phone browsers', async () => {
    await verifyPlayersEmptyRecovery()
}, 180000)
