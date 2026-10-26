import { it } from 'vitest'
import { verifyPlayerRouteRecovery } from './e2e/player-route-recovery.mjs'

it.skipIf(!process.env.PLAYER_ROUTE_FIXTURE)('recovers stale chunks and paints player headers on phone browsers', async () => {
    await verifyPlayerRouteRecovery()
}, 180000)
