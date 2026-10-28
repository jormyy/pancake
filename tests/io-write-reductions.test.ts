import { it } from 'vitest'

it.skipIf(process.env.PANCAKE_IO_NEGATIVE !== '1')('original database functions fail every protected IO check', async () => {
    await import('./io-write-reductions-negative.mjs')
}, 120_000)
