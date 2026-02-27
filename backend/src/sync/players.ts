import { supabase } from '../lib/supabase'
import { fetchAllPlayers } from '../lib/sportsdata'

export async function syncPlayers() {
  console.log('[sync] Fetching players from SportsData.io...')
  const raw = await fetchAllPlayers()

  const players = raw.map((p: any) => ({
    sportsdata_id: String(p.PlayerID),
    first_name: p.FirstName ?? '',
    last_name: p.LastName ?? '',
    nba_team: p.Team ?? null,
    position: normalizePosition(p.Position),
    jersey_number: p.Jersey ? String(p.Jersey) : null,
    status: p.Status ?? null,
    injury_status: p.InjuryStatus ?? null,
    headshot_url: p.PhotoUrl ?? null,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await supabase
    .from('players')
    .upsert(players, { onConflict: 'sportsdata_id' })

  if (error) throw error
  console.log(`[sync] Upserted ${players.length} players.`)
}

// Map SportsData.io position strings to our nba_position enum
function normalizePosition(pos: string | null): string | null {
  const map: Record<string, string> = {
    PG: 'PG', SG: 'SG', SF: 'SF', PF: 'PF', C: 'C',
    G: 'G', F: 'F',
  }
  return pos ? (map[pos] ?? null) : null
}
