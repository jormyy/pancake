import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const steps = {
  proposal: ['keyboard-space', 'keyboard-enter', 'propose-name', 'propose-photo', 'propose-partner', 'deal-summary', 'propose-analysis', 'proposal-review', 'proposal-roster-plan'],
  offers: ['received-card', 'sent-card', 'sent-details', 'received-details', 'accept-review', 'accept-roster-plan', 'edit', 'edit-column-add-remove', 'counter', 'counter-column-add-remove', 'history-card', 'history-details', 'pick-card-details', 'multi-history-card', 'multi-history-details'],
  multi: ['multi-column-add-remove', 'selected-routes', 'multi-overview', 'multi-overview-remove', 'multi-review'],
  analyzer: ['analyzer-prefill', 'analyzer-selection', 'analyzer-column-add-remove', 'analyzer-summary', 'analyzer-values'],
  block: ['block-roster', 'block-own-listing', 'second-manager-received', 'block-other-listing', 'block-offer'],
  activity: ['league-trade-activity', 'league-completed-activity'],
}

export function reserveTradeCapture(captures, width, label) {
  const key = `${width}-${label}`
  assert.ok(!captures.has(key), `Duplicate trade proof capture: ${key}`)
  captures.add(key)
}

export function assertTradeSenderStates(before, after, excludedName) {
  const keep = label => !excludedName || !label?.includes(excludedName)
  const normalize = states => states.map(state => ({ ...state,
    controls: state.controls.filter(control => keep(control.label)).toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    selectionLabels: state.selectionLabels.filter(keep).toSorted(),
  })).toSorted((a, b) => a.sender.localeCompare(b.sender))
  assert.deepEqual(normalize(after), normalize(before), 'Every sender retains its routes, FAAB and other draft state')
}

export function assertTradeProof(receipts, widths, selected) {
  const expected = (selected ? steps[selected] : Object.values(steps).flat()).toSorted()
  for (const width of widths) assert.deepEqual(receipts.filter(receipt => receipt.width === width).map(receipt => receipt.label).toSorted(), expected, `Every ${selected ?? 'full-matrix'} entry point is required at ${width}px`)
}

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
