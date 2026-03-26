import { supabase } from '../lib/supabase'
import { fetchSeasonSchedule } from '../lib/nba'

function currentSeasonYear(): number {
    const now = new Date()
    return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear()
}

export async function syncSchedule() {
    console.log('[sync] Fetching schedule from NBA CDN...')
    const raw = await fetchSeasonSchedule()

    if (!raw.length) {
        console.log('[sync] No schedule data returned.')
        return
    }

    const seasonYear = currentSeasonYear()

    // NBA gameId prefixes: 001=preseason, 002=regular season, 003=all-star, 004=playoffs
    // Exclude preseason — their early dates throw off week number calculations
    const regularAndPlayoff = raw.filter(
        (g) => g.gameId.startsWith('002') || g.gameId.startsWith('004'),
    )

    if (!regularAndPlayoff.length) {
        console.log('[sync] No regular season games found in schedule.')
        return
    }

    // Calculate week numbers from regular season start.
    // Use the first date with >= 5 games to skip international openers (Paris/Abu Dhabi Games)
    // which are 1-2 game days that otherwise push season start 2-3 weeks too early.
    const regularOnly = regularAndPlayoff.filter((g) => g.gameId.startsWith('002'))
    const dateCounts = new Map<string, number>()
    for (const g of regularOnly) dateCounts.set(g.gameDate, (dateCounts.get(g.gameDate) ?? 0) + 1)
    const bulkStartDates = [...dateCounts.entries()]
        .filter(([, count]) => count >= 5)
        .map(([date]) => date)
        .sort()
    const seasonStart = bulkStartDates[0] ?? regularOnly.map((g) => g.gameDate).sort()[0]
    const startMs = new Date(seasonStart).getTime()

    const games = regularAndPlayoff
        .filter((g) => g.homeTeam && g.awayTeam)
        .map((g) => {
            const daysDiff = Math.floor((new Date(g.gameDate).getTime() - startMs) / 86_400_000)
            return {
                nba_game_id: g.gameId,
                season_year: seasonYear,
                game_date: g.gameDate,
                home_team: g.homeTeam,
                away_team: g.awayTeam,
                status: g.status,
                started_at: g.startedAt,
                ended_at: null,
                week_number: Math.floor(daysDiff / 7) + 1,
                updated_at: new Date().toISOString(),
            }
        })

    // Load existing games to match by date+teams (bootstrap nba_game_id population)
    const { data: existing, error: fetchErr } = await supabase
        .from('nba_games')
        .select('id, game_date, home_team, away_team, nba_game_id')
    if (fetchErr) throw fetchErr

    const byNbaGameId = new Map<string, string>() // nba_game_id → game.id
    const byDateTeams = new Map<string, string>() // "date_home_away" → game.id
    for (const g of existing ?? []) {
        if (g.nba_game_id) byNbaGameId.set(g.nba_game_id, g.id)
        byDateTeams.set(`${g.game_date}_${g.home_team}_${g.away_team}`, g.id)
    }

    const toUpdate: any[] = []
    const toInsert: any[] = []

    for (const game of games) {
        const key = `${game.game_date}_${game.home_team}_${game.away_team}`
        const existingId = byNbaGameId.get(game.nba_game_id) ?? byDateTeams.get(key)

        if (existingId) {
            toUpdate.push({ id: existingId, ...game })
        } else {
            toInsert.push(game)
        }
    }

    const CHUNK = 500

    for (let i = 0; i < toUpdate.length; i += CHUNK) {
        const { error } = await supabase
            .from('nba_games')
            .upsert(toUpdate.slice(i, i + CHUNK), { onConflict: 'id' })
        if (error) throw error
    }

    if (toInsert.length > 0) {
        for (let i = 0; i < toInsert.length; i += CHUNK) {
            const { error } = await supabase
                .from('nba_games')
                .insert(toInsert.slice(i, i + CHUNK))
            if (error) console.error(`[sync] Game insert error (chunk ${i}):`, error.message)
        }
    }

    console.log(`[sync] Games: ${toUpdate.length} updated, ${toInsert.length} inserted.`)

    await syncSeasonWeeks([...toUpdate, ...toInsert], seasonYear)
}

async function syncSeasonWeeks(games: any[], seasonYear: number) {
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

    if (!weeks.length) return

    const { error } = await supabase
        .from('season_weeks')
        .upsert(weeks, { onConflict: 'season_year,week_number' })

    if (error) throw error
    console.log(`[sync] Upserted ${weeks.length} season weeks.`)
}
