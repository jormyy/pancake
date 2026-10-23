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

const STORED_STATS = ['pts', 'reb', 'ast', 'stl', 'blk', 'to', 'fgm', 'fga', 'ftm', 'fta', 'tpm', 'tpa', 'sp', 'dd', 'td']
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const id = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value)

export class SleeperProjectionParseError extends Error {
  constructor(message: string, readonly inputRowCount: number, readonly rejectedRowCount: number) {
    super(message)
    this.name = 'SleeperProjectionParseError'
  }
}

function projectionStats(raw: Record<string, unknown>): Record<string, number> | null {
  const games = raw.gp === undefined ? 0 : raw.gp
  if (typeof games !== 'number' || !Number.isFinite(games) || games < 0) return null
  const stats: Record<string, number> = {}
  for (const key of STORED_STATS) {
    const value = games === 0 || raw[key] === undefined ? 0 : raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
    stats[key] = value
  }
  stats.fga = Math.max(stats.fga, stats.fgm)
  stats.fta = Math.max(stats.fta, stats.ftm)
  stats.tpa = Math.max(stats.tpa, stats.tpm)
  return stats
}

export function parseSleeperProjections(value: unknown, context: {
  seasonYear: number; sleeperWeek: number; weekStart: string; weekEnd: string
}): { rows: SleeperProjection[]; inputRowCount: number; rejectedRowCount: number } {
  if (!Array.isArray(value)) throw new SleeperProjectionParseError('Sleeper projections must be an array', 0, 0)
  const seen = new Set<string>()
  const rows: SleeperProjection[] = []
  for (const row of value) {
    if (!object(row) || !id(row.player_id) || !id(row.game_id) || !text(row.team) || !text(row.opponent) ||
      !text(row.date) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(Date.parse(`${row.date}T00:00:00Z`)) || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date ||
      row.date < context.weekStart || row.date > context.weekEnd || row.week !== context.sleeperWeek ||
      row.season !== String(context.seasonYear - 1) || row.season_type !== 'regular' || row.sport !== 'nba' ||
      row.category !== 'proj' || row.company !== 'rotowire' ||
      typeof row.last_modified !== 'number' || !Number.isSafeInteger(row.last_modified) || row.last_modified <= 0 ||
      !object(row.player) || !text(row.player.first_name) || !text(row.player.last_name) || !object(row.stats)) continue
    const key = `${row.player_id}:${row.game_id}`
    const stats = projectionStats(row.stats)
    if (!stats || seen.has(key)) continue
    seen.add(key)
    rows.push({
      player_id: row.player_id, game_id: row.game_id, date: row.date, team: row.team, opponent: row.opponent,
      week: context.sleeperWeek, season: String(context.seasonYear - 1), company: 'rotowire',
      last_modified: row.last_modified, player: { first_name: row.player.first_name, last_name: row.player.last_name }, stats,
    })
  }
  const rejectedRowCount = value.length - rows.length
  if (rows.length === 0) throw new SleeperProjectionParseError('No valid Sleeper projections', value.length, rejectedRowCount)
  if (rejectedRowCount * 5 > value.length) throw new SleeperProjectionParseError('More than 20% of Sleeper projections are invalid', value.length, rejectedRowCount)
  return { rows, inputRowCount: value.length, rejectedRowCount }
}
