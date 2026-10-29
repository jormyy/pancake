import assert from 'node:assert/strict'
import { command } from './process.mjs'
import { project } from './common.mjs'

export function parseDiskUsage(text) {
  const fields = text.trim().split('\n').at(-1).trim().split(/\s+/)
  const [blocks, used, available] = fields.slice(1, 4).map(Number)
  const percent = Number(fields[4]?.replace('%', ''))
  assert.ok([blocks, used, available, percent].every(Number.isFinite) && blocks > 0 && available >= 0 && percent >= 0 && percent <= 100, 'Invalid VM disk usage')
  return { totalBytes: blocks * 1024, usedBytes: used * 1024, availableBytes: available * 1024, percent }
}

export async function diskUsage(execute = command) {
  const result = await execute('docker', ['exec', `supabase_db_${project}`, 'df', '-Pk', '/var/lib/postgresql/data'], { timeout: 10000 })
  return parseDiskUsage(result.stdout)
}
