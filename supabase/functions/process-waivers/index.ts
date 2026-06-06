import { supabase } from '../_shared/supabase.ts'
import { notifyMember } from '../_shared/notifications.ts'
import { internalServerError } from '../_shared/responses.ts'

type WaiverStatus = 'succeeded' | 'failed_priority' | 'failed_roster' | 'cancelled' | 'pending'

type WaiverProcessRow = {
  processed: boolean
  claim_id: string | null
  member_id: string | null
  player_id: string | null
  status: WaiverStatus | null
  failure_reason: string | null
}

Deno.serve(async () => {
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
  let processed = 0

  while (true) {
    const { data, error } = await supabase.rpc('process_next_waiver_claim_atomic', {
      p_process_date: today,
    })
    if (error) throw error

    const rows = Array.isArray(data) ? data as WaiverProcessRow[] : []
    if (rows.length === 0 || !rows.some((row) => row.processed)) break

    processed += rows.filter((row) => row.processed).length
    for (const row of rows) await notifyClaimResult(row)
  }

  const { error: expiredErr } = await supabase.rpc('expire_waiver_wire_logs')
  if (expiredErr) throw expiredErr

  return processed
}
