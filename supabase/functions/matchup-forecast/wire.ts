import type { ForecastContext } from './compute.ts'

type PackedContext = Omit<ForecastContext,'teams'|'roster'|'games'|'history'|'projections'|'lineups'|'templates'|'seasonAverages'|'previous'> & {
  wireVersion: number
  teams: unknown[][]
  roster: unknown[][]
  games: unknown[][]
  history: unknown[][]
  projections: unknown[][]
  lineups: unknown[][]
  templates: unknown[][]
  seasonAverages: unknown[][]
  previous: unknown[][] | null
}

function rows(value: unknown, fields: number): unknown[][] {
  if (!Array.isArray(value) || value.some(row=>!Array.isArray(row) || row.length!==fields))
    throw new Error('Forecast wire rows are invalid')
  return value
}

export function readForecastContext(value: unknown): ForecastContext {
  const input=value as PackedContext
  if (!input || input.wireVersion!==1) throw new Error('Forecast wire version is invalid')
  const {wireVersion: _wireVersion,...source}=input
  return {...source,
    teams:rows(input.teams,2).map(([memberId,currentPoints])=>({memberId,currentPoints})),
    roster:rows(input.roster,7).map(([member_id,player_id,is_on_ir,is_on_taxi,nba_team,eligible_positions,injury_status])=>
      ({member_id,player_id,is_on_ir,is_on_taxi,nba_team,eligible_positions,injury_status})),
    games:rows(input.games,9).map(([id,game_date,home_team,away_team,status,game_time,started_at,live_scoreboard_elapsed_seconds,live_stats_elapsed_seconds])=>
      ({id,game_date,home_team,away_team,status,game_time,started_at,live_scoreboard_elapsed_seconds,live_stats_elapsed_seconds})),
    history:rows(input.history,2).map(([player_id,scores])=>({player_id,scores})),
    projections:rows(input.projections,7).map(([requested_date,player_id,projection_fantasy_points,projection_source_label,projection_fetched_at,projection_date,projection_is_fresh])=>
      ({requested_date,player_id,projection_fantasy_points,projection_source_label,projection_fetched_at,projection_date,projection_is_fresh})),
    lineups:rows(input.lineups,5).map(([member_id,player_id,game_date,slot_type,is_auto_set])=>({member_id,player_id,game_date,slot_type,is_auto_set})),
    templates:rows(input.templates,2).map(([slot_type,slot_count])=>({slot_type,slot_count})),
    seasonAverages:rows(input.seasonAverages,2).map(([player_id,avg_fantasy_points])=>({player_id,avg_fantasy_points})),
    previous:input.previous===null?null:{games:rows(input.previous,6).map(([playerId,gameId,projection,source,sourceAt,substituted])=>
      ({playerId,gameId,projection,source,sourceAt,...(substituted===true?{substituted:true}:{})}))},
  } as ForecastContext
}
