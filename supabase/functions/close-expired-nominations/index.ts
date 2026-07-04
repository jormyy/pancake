import type { Database } from '../_shared/database.ts'
import { serveInternal } from '../_shared/serve.ts'
import { supabase } from '../_shared/supabase.ts'

const CLOSE_BATCH_LIMIT = 100

type ClosedNominationRow = Database['public']['Functions']['close_expired_auction_nominations_atomic']['Returns'][number]
type ExpiredSnakePickRow = Database['public']['Functions']['process_expired_snake_picks_atomic']['Returns'][number]

serveInternal('close-expired-nominations', async () => {
  const result = await closeExpiredNominations()
  return Response.json({ ok: true, ...result })
})

async function closeExpiredNominations(): Promise<{
  checked: number
  closed: number
  autoPicked: number
  failed: number
  nominationsChecked: number
  snakePicksChecked: number
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
  const nominationRows: ClosedNominationRow[] = nominationResult.data ?? []
  const snakePickRows: ExpiredSnakePickRow[] = snakePickResult.data ?? []

  for (const result of nominationRows) {
    if (!result.error_message && !result.error_code) {
      if (result.closed) closed += 1
      continue
    }
    failed += 1
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
  }
}
