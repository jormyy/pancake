import { it } from 'vitest'

it.skipIf(!process.env.PANCAKE_MATCHUP_NAVIGATION)('verifies matchup arrows, selected dates, and selector highlights on the private stack', async () => {
    await import('../e2e/matchup-navigation.mjs')
}, 240000)
