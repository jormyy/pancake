import { supabase } from '../lib/supabase'
import { fetchSeasonSchedule, currentSeason } from '../lib/sportsdata'

export async function syncSchedule(season?: string) {
    const s = season ?? currentSeason()
    console.log(`[sync] Fetching schedule for season ${s}...`)
    const raw = await fetchSeasonSchedule(s)

    // Parse dates first so we can calculate week numbers from season start
    const parsed = raw
        .filter((g: any) => g.DateTime || g.Day)
        .map((g: any) => ({
            sportsdata_game_id: String(g.GameID),
            season_year: parseInt(s),
            game_date: new Date(g.DateTime ?? g.Day).toISOString().split('T')[0],
            home_team: g.HomeTeam ?? '',
            away_team: g.AwayTeam ?? '',
            status: g.Status ?? 'Scheduled',
            started_at: g.DateTime ? new Date(g.DateTime).toISOString() : null,
            ended_at: null,
            updated_at: new Date().toISOString(),
        }))

    // NBA API has no Week field — derive week numbers from game date relative to season start
    const seasonStart = parsed
        .map((g) => g.game_date)
        .sort()[0]

    const startMs = new Date(seasonStart).getTime()

    const games = parsed.map((g) => {
        const daysDiff = Math.floor((new Date(g.game_date).getTime() - startMs) / 86_400_000)
        return { ...g, week_number: Math.floor(daysDiff / 7) + 1 }
    })

    const { error } = await supabase
        .from('nba_games')
        .upsert(games, { onConflict: 'sportsdata_game_id' })

    if (error) throw error
    console.log(`[sync] Upserted ${games.length} games.`)

    await syncSeasonWeeks(games, parseInt(s))
}

async function syncSeasonWeeks(games: any[], seasonYear: number) {
    // Derive week start/end from games
    const weekMap: Record<number, { start: string; end: string }> = {}

    for (const g of games) {
        const wk = g.week_number
        if (!wk) continue
        const d = g.game_date
        if (!weekMap[wk]) {
            weekMap[wk] = { start: d, end: d }
        } else {
            if (d < weekMap[wk].start) weekMap[wk].start = d
            if (d > weekMap[wk].end) weekMap[wk].end = d
        }
    }

    const weeks = Object.entries(weekMap).map(([wk, range]) => ({
        season_year: seasonYear,
        week_number: parseInt(wk),
        week_start: range.start,
        week_end: range.end,
    }))

    if (weeks.length === 0) return

    const { error } = await supabase
        .from('season_weeks')
        .upsert(weeks, { onConflict: 'season_year,week_number' })

    if (error) throw error
    console.log(`[sync] Upserted ${weeks.length} season weeks.`)
}
