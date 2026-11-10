import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename } from 'node:fs/promises'
import path from 'node:path'

export async function beginTradeProof(dir) {
  const attemptId = randomUUID()
  const previous = (await readdir(dir)).filter(file => /^trade-player-stats-.*\.json$/.test(file) || /^webkit-trade-player-stats-.*\.(png|txt)$/.test(file))
  if (previous.length) {
    const archive = path.join(dir, `previous-trade-proof-${attemptId}`)
    await mkdir(archive)
    for (const file of previous) await rename(path.join(dir, file), path.join(archive, file))
  }
  return attemptId
}

export function tradeProofReceiptName(selected, widths) {
  const complete = widths.length === 3 && [390, 375, 1440].every(width => widths.includes(width))
  return `trade-player-stats-${selected ?? 'all'}${complete ? '' : `-${widths.join('-')}`}-receipt.json`
}
