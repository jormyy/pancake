import { buildScheduleSyncPlan, type ScheduleGameRow, type SeasonWeekRow } from '@pancake/core'
import { supabase } from '../lib/supabase'
import { fetchSeasonSchedule } from '../lib/nba'

const CHUNK = 500

async function syncSeasonWeeks(weeks: SeasonWeekRow[]): Promise<number> {
    if (weeks.length === 0) return 0

    const { error } = await supabase
        .from('season_weeks')
        .upsert(weeks, { onConflict: 'season_year,week_number' })
    if (error) throw error
    return weeks.length
}

// Syncs the scheduled tip-off time (game_time) for all games in the season
// from the NBA CDN static schedule. Run once per season and after schedule changes.
export async function syncGameTimes(): Promise<{ updated: number; inserted: number; weeks: number }> {
    const raw = await fetchSeasonSchedule()
    const plan = buildScheduleSyncPlan(raw)
    if (plan.regularSeason.length === 0) {
        console.log('[schedule] No regular season games')
        return { updated: 0, inserted: 0, weeks: 0 }
    }

    if (!plan.seasonStart) {
        console.log('[schedule] No regular season start date')
        return { updated: 0, inserted: 0, weeks: 0 }
    }

    if (plan.rows.length === 0) {
        console.log('[schedule] No schedule rows to sync')
        return { updated: 0, inserted: 0, weeks: 0 }
    }

    const existing: { id: string; game_date: string; home_team: string; away_team: string; nba_game_id: string | null }[] = []
    for (let from = 0; ; from += CHUNK) {
        const { data, error } = await supabase
            .from('nba_games')
            .select('id, game_date, home_team, away_team, nba_game_id')
            .range(from, from + CHUNK - 1)
        if (error) throw error
        const page = data ?? []
        existing.push(...page)
        if (page.length < CHUNK) break
    }

    const byNbaGameId = new Map<string, string>()
    const byDateTeams = new Map<string, string>()
    for (const game of existing) {
        if (game.nba_game_id) byNbaGameId.set(game.nba_game_id, game.id)
        byDateTeams.set(`${game.game_date}_${game.home_team}_${game.away_team}`, game.id)
    }

    const toUpdate: (ScheduleGameRow & { id: string })[] = []
    const toInsert: ScheduleGameRow[] = []
    for (const game of plan.rows) {
        const key = `${game.game_date}_${game.home_team}_${game.away_team}`
        const existingId = byNbaGameId.get(game.nba_game_id) ?? byDateTeams.get(key)
        if (existingId) {
            toUpdate.push({ id: existingId, ...game })
        } else {
            toInsert.push(game)
        }
    }

    let updated = 0
    for (let i = 0; i < toUpdate.length; i += CHUNK) {
        const chunk = toUpdate.slice(i, i + CHUNK)
        const { error } = await supabase
            .from('nba_games')
            .upsert(chunk as any, { onConflict: 'id' })
        if (error) throw error
        updated += chunk.length
    }

    let inserted = 0
    for (let i = 0; i < toInsert.length; i += CHUNK) {
        const chunk = toInsert.slice(i, i + CHUNK)
        const { error } = await supabase
            .from('nba_games')
            .upsert(chunk as any, { onConflict: 'nba_game_id' })
        if (error) throw error
        inserted += chunk.length
    }

    const weeks = await syncSeasonWeeks(plan.weeks)

    console.log(`[schedule] ${updated} updated, ${inserted} inserted, ${weeks} weeks synced`)
    return { updated, inserted, weeks }
}
