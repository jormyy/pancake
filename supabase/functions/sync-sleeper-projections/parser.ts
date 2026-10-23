export type SleeperProjection = {
  player_id: string
  game_id: string
  date: string
  team: string
  opponent: string
  week: number
  season: string
  company: 'rotowire'
  last_modified: number
  player: { first_name: string; last_name: string }
  stats: Record<string, number>
}

const REQUIRED_STATS = ['pts', 'reb', 'ast', 'stl', 'blk', 'to', 'fgm', 'fga', 'ftm', 'fta', 'tpm', 'tpa', 'gp', 'sp']
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export function parseSleeperProjections(value: unknown, context: {
  seasonYear: number; sleeperWeek: number; weekStart: string; weekEnd: string
}): SleeperProjection[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10000) throw new Error('Sleeper projections must be a nonempty array of at most 10000 rows')
  const seen = new Set<string>()
  return value.map((row: unknown, index) => {
    const fail = () => { throw new Error(`Invalid Sleeper projection at row ${index + 1}`) }
    if (!object(row) || !text(row.player_id) || !text(row.game_id) || !text(row.team) || !text(row.opponent) ||
      !text(row.date) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(Date.parse(`${row.date}T00:00:00Z`)) || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date ||
      row.date < context.weekStart || row.date > context.weekEnd || row.week !== context.sleeperWeek ||
      row.season !== String(context.seasonYear - 1) || row.season_type !== 'regular' || row.sport !== 'nba' ||
      row.category !== 'proj' || row.company !== 'rotowire' ||
      typeof row.last_modified !== 'number' || !Number.isSafeInteger(row.last_modified) || row.last_modified <= 0 ||
      !object(row.player) || !text(row.player.first_name) || !text(row.player.last_name) || !object(row.stats)) return fail()
    const stats = row.stats
    if (REQUIRED_STATS.some((key) => typeof stats[key] !== 'number') ||
      Object.values(stats).some((stat) => typeof stat !== 'number' || !Number.isFinite(stat) || stat < 0) ||
      stats.gp !== 1 || Number(stats.sp) > 48 * 60 + 6 * 5 * 60 ||
      Number(stats.fgm) > Number(stats.fga) || Number(stats.ftm) > Number(stats.fta) || Number(stats.tpm) > Number(stats.tpa)) return fail()
    const key = `${row.player_id}:${row.game_id}`
    if (seen.has(key)) throw new Error(`Duplicate Sleeper player-game at row ${index + 1}`)
    seen.add(key)
    return row as SleeperProjection
  })
}
