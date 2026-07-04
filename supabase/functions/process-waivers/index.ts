import { supabase } from '../_shared/supabase.ts'
import type { Database } from '../_shared/database.ts'
import { notifyMember } from '../_shared/notifications.ts'
import { serveInternal } from '../_shared/serve.ts'

const PROCESS_BATCH_LIMIT = 100
const NOTIFICATION_CONCURRENCY = 10

type WaiverProcessRow = Database['public']['Functions']['process_due_waiver_claims_atomic']['Returns'][number]
type NotificationJob = () => Promise<void>

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

function notificationJob(row: WaiverProcessRow, names: Map<string, string>): NotificationJob | null {
  if (!row.member_id || !row.player_id || !row.status) return null
  const memberId = row.member_id
  const playerId = row.player_id
  const name = names.get(playerId) ?? 'Unknown'

  if (row.status === 'succeeded') {
    return () => notifyMember(memberId, 'Waiver Claim Succeeded', `${name} has been added to your roster.`, undefined, 'waiver')
  }

  if (row.status !== 'failed_priority' && row.status !== 'failed_roster') {
    return null
  }

  const reason = row.failure_reason ?? 'The claim could not be completed.'
  return () => notifyMember(memberId, 'Waiver Claim Failed', `Your claim for ${name} failed: ${reason}`, undefined, 'waiver')
}

async function runBounded(jobs: NotificationJob[], concurrency: number): Promise<void> {
  let next = 0
  const workerCount = Math.min(concurrency, jobs.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      await job().catch((error) => console.error('[process-waivers] notification failed', error))
    }
  })
  await Promise.all(workers)
}

async function notifyClaimResults(rows: WaiverProcessRow[]): Promise<void> {
  const playerIds = rows.flatMap((row) => row.player_id ? [row.player_id] : [])
  const names = await playerNames(playerIds)
  const jobs = rows.flatMap((row) => {
    const job = notificationJob(row, names)
    return job ? [job] : []
  })
  if (jobs.length > 0) {
    await runBounded(jobs, NOTIFICATION_CONCURRENCY)
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
  const [, { error: expiredErr }] = await Promise.all([
    notifyClaimResults(rows),
    supabase.rpc('expire_waiver_wire_logs'),
  ])
  if (expiredErr) throw expiredErr

  return rows.filter((row) => row.processed).length
}
