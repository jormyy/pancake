import { it } from 'vitest'

it.skipIf(!process.env.PANCAKE_DAILY_TOTAL_STACK)('verifies daily totals and screenshots through the private stack', async () => {
    await import('../e2e/matchup-daily-total.mjs')
}, 180000)
