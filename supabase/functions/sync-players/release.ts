import { supabase } from '../_shared/supabase.ts'
import { errorMessage } from '../_shared/responses.ts'

type ListedPlayer = { espn_id: string; first_name: string; last_name: string }
export type HeldReleases = { unproven: number; unclaimed: number }

/**
 * ESPN roster pages list only signed players, but a page can answer 200 and
 * still omit one, so even a listing with no gaps does not prove anyone left.
 * A listing with gaps or import failures sends nothing. A clean one names its
 * players to espn_release, which clears a team only when the stored NBA boxes
 * agree and reports every other omitted row as held. Real boxes omit signed
 * inactive players too, so a box omission counts only after a box that showed
 * the player playing.
 */
function releaseBlockers(listingGaps: string[], importFailures: string[]): string[] {
  return [...listingGaps, ...importFailures.length > 0 ? [`${importFailures.length} import failure(s)`] : []]
}

const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string')

export async function releaseUnlistedPlayers(listed: ListedPlayer[], listingGaps: string[], importFailures: string[]) {
  const blockers = releaseBlockers(listingGaps, importFailures)
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
