import { supabase } from '../_shared/supabase.ts'
import { errorMessage } from '../_shared/responses.ts'

type ListedPlayer = { espn_id: string; first_name: string; last_name: string }

/**
 * ESPN roster pages list only signed players, so a player missing from every
 * page has left the league. Only a listing with no gaps whose every record
 * imported can show that; anything less releases nobody and the next complete
 * refresh catches up.
 */
function releaseBlockers(listingGaps: string[], importFailures: string[]): string[] {
  return [...listingGaps, ...importFailures.length > 0 ? [`${importFailures.length} import failure(s)`] : []]
}

export async function releaseUnlistedPlayers(listed: ListedPlayer[], listingGaps: string[], importFailures: string[]) {
  const blockers = releaseBlockers(listingGaps, importFailures)
  if (blockers.length > 0) return { released: 0, blockers, failures: [] as string[] }
  try {
    const { data, error } = await supabase.rpc('resolve_player_imports_atomic', {
      p_source: 'espn_release',
      p_records: listed.map((player) => ({ provider_id: player.espn_id, first_name: player.first_name, last_name: player.last_name })),
    })
    if (error) throw error
    const released = (data as { released?: unknown } | null)?.released
    if (!Array.isArray(released) || released.some((id) => typeof id !== 'string')) throw new Error('Invalid release receipt')
    return { released: released.length, blockers, failures: [] as string[] }
  } catch (error) {
    return { released: 0, blockers, failures: [`release: ${errorMessage(error)}`] }
  }
}
