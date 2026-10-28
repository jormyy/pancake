import { it } from 'vitest'

it.skipIf(process.env.PANCAKE_TRADE_VALUE_STACK !== '1')('verifies stored values through the private database and browser', async () => {
  await import('./trade-values-db.mjs')
  await import('./trade-value-reader-setup.mjs')
  await import('./build-trade-value-reader.mjs')
  const { startReaderServer } = await import('./trade-value-reader-server.mjs')
  const server = startReaderServer('../reader-web')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  try {
    await import('./trade-value-reader-browser.mjs')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}, 240_000)
