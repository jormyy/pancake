import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

export function runTradeProposeBudget(senderId, recipientId, negativeControl = false) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuid.test(senderId ?? '') || !uuid.test(recipientId ?? '') || senderId === recipientId) {
    throw new Error('Provide distinct sender and recipient UUIDs from the restored backup.')
  }
  const target = databaseTarget()
  const sql = readFileSync(new URL('./trade-propose-budget.sql', import.meta.url), 'utf8')
  const samples = []
  for (let sample = 1; sample <= 3; sample++) {
    const output = execFileSync('psql', [target.href, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
      '-v', `sender_id=${senderId}`, '-v', `recipient_id=${recipientId}`,
      '-v', `negative_control=${negativeControl}`, '-f', '-'], {
      input: sql, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    samples.push({ sample, measurements: JSON.parse(output.trim()) })
  }
  return samples
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argumentsList = process.argv.slice(2)
  const value = (name) => argumentsList.includes(name) ? argumentsList[argumentsList.indexOf(name) + 1] : undefined
  for (const sample of runTradeProposeBudget(value('--sender-id'), value('--recipient-id'), argumentsList.includes('--negative-control'))) {
    console.log(JSON.stringify(sample))
  }
}
