import { supabase } from '../_shared/supabase.ts'
import type { Database } from '../_shared/database.ts'
import { notifyMember } from '../_shared/notifications.ts'
import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { internalServerError } from '../_shared/responses.ts'

const PROCESS_BATCH_LIMIT = 100

type WaiverProcessRow = Database['public']['Functions']['process_due_waiver_claims_atomic']['Returns'][number]

Deno.serve(async (req) => {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError

  try {
    const processed = await processWaiverClaims()
    return Response.json({ ok: true, processed })
  } catch (e: unknown) {
    return internalServerError('process-waivers', e)
  }
})

async function playerName(playerId: string): Promise<string> {
  const { data } = await supabase
    .from('players')
    .select('display_name')
    .eq('id', playerId)
    .single()

  return data?.display_name ?? 'Unknown'
}

async function notifyClaimResult(row: WaiverProcessRow) {
  if (!row.member_id || !row.player_id || !row.status) return

  const name = await playerName(row.player_id)

  if (row.status === 'succeeded') {
    await notifyMember(row.member_id, 'Waiver Claim Succeeded', `${name} has been added to your roster.`).catch(console.error)
    return
  }

  if (row.status === 'failed_priority' || row.status === 'failed_roster') {
    const reason = row.failure_reason ?? 'The claim could not be completed.'
    await notifyMember(row.member_id, 'Waiver Claim Failed', `Your claim for ${name} failed: ${reason}`).catch(console.error)
  }
}

async function processWaiverClaims(): Promise<number> {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

  const { data, error } = await supabase.rpc('process_due_waiver_claims_atomic', {
    p_process_date: today,
    p_limit: PROCESS_BATCH_LIMIT,
  })
  if (error) throw error

  const rows: WaiverProcessRow[] = data ?? []
  for (const row of rows) await notifyClaimResult(row)

  const { error: expiredErr } = await supabase.rpc('expire_waiver_wire_logs')
  if (expiredErr) throw expiredErr

  return rows.filter((row) => row.processed).length
}
