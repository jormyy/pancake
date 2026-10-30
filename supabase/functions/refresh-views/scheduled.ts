import { supabase } from '../_shared/supabase.ts'
import { renewCurrentWorkLease } from '../_shared/workContext.ts'
import { setTimeout as pause } from 'node:timers/promises'

function receipt(value: unknown): { processed: number; remaining: boolean } {
  if (!value || typeof value !== 'object' || !('processed' in value) || !('remaining' in value)
    || !Number.isInteger(value.processed) || Number(value.processed) < 0 || Number(value.processed) > 1
    || typeof value.remaining !== 'boolean') throw new Error('Invalid scheduler chunk receipt')
  return { processed: Number(value.processed), remaining: value.remaining }
}

export async function runScheduledChunks(kind: unknown, at?: unknown) {
  if (kind !== 'forecasts' && kind !== 'notifications') throw new Error('Unknown scheduler chunk')
  if (at !== undefined && (typeof at !== 'string' || !Number.isFinite(Date.parse(at)))) throw new Error('Invalid scheduler scan time')
  const args = { p_kind: kind, ...(kind === 'notifications' && typeof at === 'string' ? { p_now: at } : {}) }
  let processed = 0, remaining = false
  for (let step = 0; step < 64; step++) {
    await pause(100)
    if (step % 8 === 0) await renewCurrentWorkLease()
    const { data, error } = await supabase.rpc('run_scheduler_chunk', args)
    if (error) throw error
    const chunk = receipt(data)
    processed += chunk.processed
    remaining = chunk.remaining
    if (!remaining) break
  }
  if (remaining) {
    await renewCurrentWorkLease()
    const { data, error } = await supabase.rpc('run_scheduler_chunk', { ...args, p_requeue: true })
    if (error) throw error
    receipt(data)
  }
  return { result: { processed, continued: remaining }, rowsAffected: processed, failure: null }
}
