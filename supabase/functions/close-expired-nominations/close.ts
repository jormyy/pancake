import type { Database } from '../_shared/database.ts'
import { supabase } from '../_shared/supabase.ts'

const CLOSE_BATCH_LIMIT = 100

type ClosedNominationRow = Database['public']['Functions']['close_expired_auction_nominations_atomic']['Returns'][number]
type ExpiredSnakePickRow = Database['public']['Functions']['process_expired_snake_picks_atomic']['Returns'][number]

export async function closeExpiredNominations(): Promise<{
  checked: number
  closed: number
  autoPicked: number
  failed: number
  nominationsChecked: number
  snakePicksChecked: number
  failure: string | null
}> {
  const [nominationResult, snakePickResult] = await Promise.all([
    supabase.rpc('close_expired_auction_nominations_atomic', {
      p_limit: CLOSE_BATCH_LIMIT,
    }),
    supabase.rpc('process_expired_snake_picks_atomic', {
      p_limit: CLOSE_BATCH_LIMIT,
    }),
  ])
  if (nominationResult.error) throw nominationResult.error
  if (snakePickResult.error) throw snakePickResult.error

  let closed = 0
  let autoPicked = 0
  let failed = 0
  const failures: string[] = []
  const nominationRows: ClosedNominationRow[] = nominationResult.data ?? []
  const snakePickRows: ExpiredSnakePickRow[] = snakePickResult.data ?? []

  for (const result of nominationRows) {
    if (!result.error_message && !result.error_code) {
      if (result.closed) closed += 1
      continue
    }
    failed += 1
    failures.push(`Nomination ${result.nomination_id}: ${result.error_message ?? result.error_code}`)
    console.error(
      `[close-expired-nominations] nomination ${result.nomination_id} failed`,
      result.error_message ?? result.error_code,
    )
  }

  for (const result of snakePickRows) {
    if (!result.error_message && !result.error_code) {
      if (result.picked) autoPicked += 1
      continue
    }
    failed += 1
    failures.push(`Snake pick ${result.pick_id}: ${result.error_message ?? result.error_code}`)
    console.error(
      `[close-expired-nominations] snake pick ${result.pick_id} failed`,
      result.error_message ?? result.error_code,
    )
  }

  return {
    checked: nominationRows.length + snakePickRows.length,
    closed,
    autoPicked,
    failed,
    nominationsChecked: nominationRows.length,
    snakePicksChecked: snakePickRows.length,
    failure: failed > 0 ? `${failed} expired draft action(s) failed: ${failures.slice(0, 5).join('; ')}` : null,
  }
}
