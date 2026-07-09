import {
  E2E_PLAYER_PREFIX,
  createFallbackE2EPlayers,
  fetchAll,
} from './soak-support.mjs'
export {
  assertBackendUsesFakePush,
  backendAuthedJson,
  backendGetJson,
  backendJson,
  backendUrl,
  postJson,
  signInForAccessToken,
  todayET,
} from './soak-network.mjs'

export const findAvailablePlayer = async (supabase, leagueId, leagueSeasonId) => {
  const [players, rosterRows] = await Promise.all([
    fetchAll(supabase, 'players', 'id, display_name, sportsdata_id'),
    fetchAll(supabase, 'roster_players', 'player_id', {
      league_id: leagueId,
      league_season_id: leagueSeasonId,
    }),
  ])
  const rosteredIds = new Set(rosterRows.map((row) => row.player_id))
  const player = players
    .filter((row) => row.display_name && String(row.sportsdata_id ?? '').startsWith(E2E_PLAYER_PREFIX))
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)) || String(a.id).localeCompare(String(b.id)))
    .find((row) => !rosteredIds.has(row.id))
  if (!player) {
    const [fallback] = await createFallbackE2EPlayers(supabase, leagueSeasonId, 1, 'D.X.1')
    if (!fallback) throw new Error('D.X.1: no available player found for waiver push scenario')
    return fallback
  }
  return player
}

export const findAvailablePlayers = async (supabase, leagueId, leagueSeasonId, count, label) => {
  const [players, rosterRows] = await Promise.all([
    fetchAll(supabase, 'players', 'id, display_name, sportsdata_id'),
    fetchAll(supabase, 'roster_players', 'player_id', {
      league_id: leagueId,
      league_season_id: leagueSeasonId,
    }),
  ])
  const rosteredIds = new Set(rosterRows.map((row) => row.player_id))
  const available = players
    .filter((row) => row.display_name && String(row.sportsdata_id ?? '').startsWith(E2E_PLAYER_PREFIX) && !rosteredIds.has(row.id))
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)) || String(a.id).localeCompare(String(b.id)))
    .slice(0, count)
  if (available.length < count) {
    const fallback = await createFallbackE2EPlayers(supabase, leagueSeasonId, count - available.length, label)
    return [...available, ...fallback].slice(0, count)
  }
  return available
}
