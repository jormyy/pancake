import { supabase } from '../_shared/supabase.ts'
import { errorMessage } from '../_shared/responses.ts'

export type ListedPlayer = { espn_id: string; first_name: string; last_name: string }
export type HeldReleases = { unproven: number; unclaimed: number }

/**
 * ESPN roster pages list only signed players, but a page can answer 200 and
 * still omit one, so even a listing with no gaps does not prove anyone left.
 * Real NBA boxes omit signed players too, and no feed the product reads says
 * a player is no longer rostered. A listing with gaps or import failures sends
 * nothing, and neither does a run whose NBA index step failed a row: that step
 * runs first and merges a person's split rows, so a failure can leave his ESPN
 * row apart from his boxes. A clean one names its players to espn_release,
 * which moves an omitted player's team only when his latest stored box since he
 * was last placed there (ESPN's listing or a box under that team) is of a game
 * his team did not play, and reports every other omitted teamed row as held.
 */
function releaseBlockers(listingGaps: string[], importFailures: string[], indexFailures: string[]): string[] {
  return [...listingGaps, ...importFailures.length > 0 ? [`${importFailures.length} import failure(s)`] : [],
    ...indexFailures.length > 0 ? [`${indexFailures.length} NBA index failure(s)`] : []]
}

const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string')

export async function releaseUnlistedPlayers(listed: ListedPlayer[], listingGaps: string[], importFailures: string[], indexFailures: string[]) {
  const blockers = releaseBlockers(listingGaps, importFailures, indexFailures)
  const none: HeldReleases = { unproven: 0, unclaimed: 0 }
  if (blockers.length > 0) return { released: 0, held: none, blockers, failures: [] as string[] }
  try {
    const { data, error } = await supabase.rpc('resolve_player_imports_atomic', {
      p_source: 'espn_release',
      p_records: listed.map((player) => ({ provider_id: player.espn_id, first_name: player.first_name, last_name: player.last_name })),
    })
    if (error) throw error
    const receipt = data as { released?: unknown; held?: { unproven?: unknown; unclaimed?: unknown } } | null
    if (!ids(receipt?.released) || !ids(receipt?.held?.unproven) || !ids(receipt?.held?.unclaimed)) throw new Error('Invalid release receipt')
    return { released: receipt.released.length, held: { unproven: receipt.held.unproven.length, unclaimed: receipt.held.unclaimed.length }, blockers, failures: [] as string[] }
  } catch (error) {
    return { released: 0, held: none, blockers, failures: [`release: ${errorMessage(error)}`] }
  }
}
