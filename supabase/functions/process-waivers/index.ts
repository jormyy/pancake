import { supabase } from '../_shared/supabase.ts'
import type { Database } from '../_shared/database.ts'
import { serveInternal } from '../_shared/serve.ts'
import { drainDueClaims, PROCESS_BATCH_LIMIT } from './drain.ts'

type WaiverProcessRow = Database['public']['Functions']['process_due_waiver_claims_atomic']['Returns'][number]

serveInternal('process-waivers', async () => {
  const processed = await processWaiverClaims()
  return Response.json({ ok: true, processed })
})

async function playerNames(playerIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (playerIds.length === 0) return names

  const { data, error } = await supabase
    .from('players')
    .select('id, display_name')
    .in('id', [...new Set(playerIds)])

  if (error) {
    console.error('[process-waivers] failed to load player names', error)
    return names
  }

  for (const player of data ?? []) {
    if (player.display_name) names.set(player.id, player.display_name)
  }
  return names
}

function notificationRow(row: WaiverProcessRow, names: Map<string, string>): Database['public']['Tables']['notification_outbox']['Insert'] | null {
  if (!row.claim_id || !row.member_id || !row.player_id) return null
  if (row.status !== 'succeeded' && row.status !== 'failed_priority' && row.status !== 'failed_roster') return null
  const name = names.get(row.player_id) ?? 'Unknown'
  const succeeded = row.status === 'succeeded'
  return {
    dedupe_key: `waiver_result:${row.claim_id}`,
    member_id: row.member_id,
    event_type: succeeded ? 'waiver_claim_succeeded' : 'waiver_claim_failed',
    title: succeeded ? 'Waiver Claim Succeeded' : 'Waiver Claim Failed',
    body: succeeded ? `${name} has been added to your roster.`
      : `Your claim for ${name} failed: ${row.failure_reason ?? 'The claim could not be completed.'}`,
    data: { claimId: row.claim_id, playerId: row.player_id },
    category: 'waiver',
  }
}

async function notifyClaimResults(rows: WaiverProcessRow[]): Promise<void> {
  const names = await playerNames(rows.flatMap(row => row.player_id ? [row.player_id] : []))
  const notifications = rows.flatMap(row => {
    const notification = notificationRow(row, names)
    return notification ? [notification] : []
  })
  if (notifications.length === 0) return
  const { error } = await supabase.from('notification_outbox')
    .upsert(notifications, { onConflict: 'dedupe_key', ignoreDuplicates: true })
  if (error) throw error
}

async function processWaiverClaims(): Promise<number> {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

  const rows = await drainDueClaims<WaiverProcessRow>(async () => {
    const { data, error } = await supabase.rpc('process_due_waiver_claims_atomic', {
      p_process_date: today,
      p_limit: PROCESS_BATCH_LIMIT,
    })
    if (error) throw error
    return data ?? []
  }, notifyClaimResults)

  const { error: expiredErr } = await supabase.rpc('expire_waiver_wire_logs')
  if (expiredErr) throw expiredErr

  return rows.filter((row) => row.processed).length
}
