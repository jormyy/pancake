// Deletes harness-created players together with every row that still points at
// them. `players` is referenced by several tables without ON DELETE CASCADE, so a
// bare `delete from players` fails on the second run against the same database
// (the perpetual harness hit `roster_players_player_id_fkey` twice on
// 2026-09-12). Children are listed before their parents.

/** @type {Array<{ table: string, column: string }>} */
export const PLAYER_REFERENCE_TABLES = [
  { table: 'trade_items', column: 'player_id' },
  { table: 'waiver_claims', column: 'drop_player_id' },
  { table: 'waiver_claims', column: 'player_id' },
  { table: 'waiver_wire_log', column: 'player_id' },
  { table: 'roster_transactions', column: 'player_id' },
  { table: 'snake_draft_picks', column: 'player_id' },
  { table: 'nominations', column: 'player_id' },
  { table: 'player_projections', column: 'player_id' },
  { table: 'player_game_stats', column: 'player_id' },
  { table: 'weekly_lineups', column: 'player_id' },
  { table: 'roster_players', column: 'player_id' },
]

const CHUNK = 200

/** @param {unknown[]} items */
const chunks = (items) => {
  const out = []
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK))
  return out
}

/**
 * @param {any} supabase service-role client
 * @param {{ sportsdataIdLike: string, label?: string }} options
 * @returns {Promise<{ playerIds: string[], deleted: Record<string, number> }>}
 */
export const deletePlayersWithReferences = async (supabase, { sportsdataIdLike, label = 'cleanup' }) => {
  const { data: players, error: lookupError } = await supabase
    .from('players')
    .select('id')
    .like('sportsdata_id', sportsdataIdLike)
  if (lookupError) throw new Error(`${label} player lookup: ${lookupError.message}`)
  const playerIds = (players ?? []).map((row) => row.id)
  /** @type {Record<string, number>} */
  const deleted = {}
  if (playerIds.length === 0) return { playerIds, deleted }

  for (const { table, column } of PLAYER_REFERENCE_TABLES) {
    for (const ids of chunks(playerIds)) {
      const { error, count } = await supabase.from(table).delete({ count: 'exact' }).in(column, ids)
      if (error) throw new Error(`${label} ${table}.${column}: ${error.message}`)
      deleted[`${table}.${column}`] = (deleted[`${table}.${column}`] ?? 0) + (count ?? 0)
    }
  }
  for (const ids of chunks(playerIds)) {
    const { error } = await supabase.from('players').delete().in('id', ids)
    if (error) throw new Error(`${label} players: ${error.message}`)
  }
  return { playerIds, deleted }
}
