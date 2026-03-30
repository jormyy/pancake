import { supabase } from '../lib/supabase'
import { fetchBoxScore } from '../lib/nba'
import { currentSeasonYear } from '../lib/utils/season'

export interface StatMismatch {
    gameId: string
    gameDate: string
    playerId: string
    playerName: string
    field: string
    expected: number
    actual: number
}

export interface VerifyResult {
    gamesChecked: number
    gamesMatched: number
    gamesMismatched: number
    mismatches: StatMismatch[]
    missingGames: string[] // nba_game_ids with no stat rows in DB
}

const COMPARE_FIELDS: Array<{ cdnKey: keyof CdnStats; dbKey: string }> = [
    { cdnKey: 'points', dbKey: 'points' },
    { cdnKey: 'reboundsTotal', dbKey: 'rebounds' },
    { cdnKey: 'assists', dbKey: 'assists' },
    { cdnKey: 'steals', dbKey: 'steals' },
    { cdnKey: 'blocks', dbKey: 'blocks' },
    { cdnKey: 'turnovers', dbKey: 'turnovers' },
    { cdnKey: 'threePointersMade', dbKey: 'three_pointers_made' },
    { cdnKey: 'fieldGoalsMade', dbKey: 'field_goals_made' },
    { cdnKey: 'freeThrowsMade', dbKey: 'free_throws_made' },
]

interface CdnStats {
    points: number
    reboundsTotal: number
    assists: number
    steals: number
    blocks: number
    turnovers: number
    threePointersMade: number
    fieldGoalsMade: number
    freeThrowsMade: number
}

export async function verifySampleStats(sampleSize = 10): Promise<VerifyResult> {
    // Pick random Final games that have a nba_game_id
    const { data: allGames } = await supabase
        .from('nba_games')
        .select('id, nba_game_id, game_date')
        .eq('status', 'Final')
        .not('nba_game_id', 'is', null)
        .order('game_date', { ascending: false })
        .limit(sampleSize * 5) // oversample then shuffle

    if (!allGames?.length) {
        return { gamesChecked: 0, gamesMatched: 0, gamesMismatched: 0, mismatches: [], missingGames: [] }
    }

    // Shuffle and take sampleSize
    const shuffled = allGames.sort(() => Math.random() - 0.5).slice(0, sampleSize)

    // Load player lookup (nba_id → { id, display_name })
    const { data: players } = await supabase.from('players').select('id, display_name, nba_id').limit(10000)
    const byNbaId = new Map<string, { id: string; name: string }>()
    for (const p of players ?? []) {
        if (p.nba_id) byNbaId.set(p.nba_id, { id: p.id, name: p.display_name })
    }

    const mismatches: StatMismatch[] = []
    const missingGames: string[] = []
    let gamesMatched = 0
    let gamesMismatched = 0

    for (const game of shuffled) {
        try {
            const boxScore = await fetchBoxScore(game.nba_game_id!)
            const cdnPlayers = [
                ...(boxScore.homeTeam?.players ?? []),
                ...(boxScore.awayTeam?.players ?? []),
            ]

            // Load stored stats for this game
            const { data: dbStats } = await supabase
                .from('player_game_stats')
                .select('player_id,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made,field_goals_made,free_throws_made')
                .eq('game_id', game.id)

            if (!dbStats?.length) {
                missingGames.push(game.nba_game_id!)
                continue
            }

            const dbByPlayerId = new Map(dbStats.map((s: any) => [s.player_id, s]))
            let gameMismatched = false

            for (const cdnPlayer of cdnPlayers) {
                const personId = String(cdnPlayer.personId)
                const playerInfo = byNbaId.get(personId)
                if (!playerInfo) continue

                const dbRow = dbByPlayerId.get(playerInfo.id)
                if (!dbRow) continue

                const s = cdnPlayer.statistics
                for (const { cdnKey, dbKey } of COMPARE_FIELDS) {
                    const expected = s[cdnKey] ?? 0
                    const actual = (dbRow as any)[dbKey] ?? 0
                    if (expected !== actual) {
                        mismatches.push({
                            gameId: game.nba_game_id!,
                            gameDate: game.game_date,
                            playerId: playerInfo.id,
                            playerName: playerInfo.name,
                            field: dbKey,
                            expected,
                            actual,
                        })
                        gameMismatched = true
                    }
                }
            }

            if (gameMismatched) gamesMismatched++
            else gamesMatched++
        } catch (e: any) {
            console.warn(`[verify] Error checking ${game.nba_game_id}: ${e.message}`)
        }
    }

    return {
        gamesChecked: shuffled.length,
        gamesMatched,
        gamesMismatched,
        mismatches,
        missingGames,
    }
}

export interface SeasonTotalsRow {
    playerId: string
    playerName: string
    gamesPlayed: number
    totalPoints: number
    totalRebounds: number
    totalAssists: number
    totalSteals: number
    totalBlocks: number
}

export async function verifySeasonTotals(seasonYear?: number): Promise<SeasonTotalsRow[]> {
    const year = seasonYear ?? currentSeasonYear()

    // Paginate through all rows — Supabase caps at 1000 per request
    const allRows: any[] = []
    let pg = 0
    while (true) {
        const { data: batch } = await supabase
            .from('player_game_stats')
            .select('player_id, points, rebounds, assists, steals, blocks, did_not_play')
            .eq('season_year', year)
            .eq('did_not_play', false)
            .range(pg * 1000, pg * 1000 + 999)
        if (!batch?.length) break
        allRows.push(...batch)
        if (batch.length < 1000) break
        pg++
    }
    const data = allRows

    if (!data.length) return []

    // Aggregate by player
    const totals = new Map<string, { pts: number; reb: number; ast: number; stl: number; blk: number; gp: number }>()
    for (const row of data) {
        const t = totals.get(row.player_id) ?? { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, gp: 0 }
        t.pts += row.points ?? 0
        t.reb += row.rebounds ?? 0
        t.ast += row.assists ?? 0
        t.stl += row.steals ?? 0
        t.blk += row.blocks ?? 0
        t.gp += 1
        totals.set(row.player_id, t)
    }

    // Load player names
    const { data: players } = await supabase.from('players').select('id, display_name').limit(10000)
    const nameMap = new Map((players ?? []).map((p: any) => [p.id, p.display_name]))

    return Array.from(totals.entries())
        .sort(([, a], [, b]) => b.pts - a.pts)
        .slice(0, 20)
        .map(([playerId, t]) => ({
            playerId,
            playerName: nameMap.get(playerId) ?? 'Unknown',
            gamesPlayed: t.gp,
            totalPoints: t.pts,
            totalRebounds: t.reb,
            totalAssists: t.ast,
            totalSteals: t.stl,
            totalBlocks: t.blk,
        }))
}

export interface ValidationReport {
    seasonYear: number
    totalGames: number
    finalGames: number
    gamesWithStats: number
    gamesWithoutStats: number
    gamesMissingNbaGameId: number
    playersWithoutNbaId: number
    missingGameDetails: Array<{
        nbaGameId: string
        gameDate: string
        homeTeam: string
        awayTeam: string
    }>
}

export async function validateDatabase(seasonYear?: number): Promise<ValidationReport> {
    const year = seasonYear ?? currentSeasonYear()

    const { count: totalGames } = await supabase
        .from('nba_games')
        .select('id', { count: 'exact', head: true })
        .eq('season_year', year)

    const { count: finalGames } = await supabase
        .from('nba_games')
        .select('id', { count: 'exact', head: true })
        .eq('season_year', year)
        .eq('status', 'Final')

    const { count: gamesMissingNbaGameId } = await supabase
        .from('nba_games')
        .select('id', { count: 'exact', head: true })
        .eq('season_year', year)
        .is('nba_game_id', null)

    // Final games with zero stat rows
    const { data: finalGameIds } = await supabase
        .from('nba_games')
        .select('id, nba_game_id, game_date, home_team, away_team')
        .eq('season_year', year)
        .eq('status', 'Final')
        .not('nba_game_id', 'is', null)

    // Fetch distinct game_ids — paginate at 1000 rows (Supabase server cap)
    const syncedSet = new Set<string>()
    let page = 0
    while (true) {
        const { data: batch } = await supabase
            .from('player_game_stats')
            .select('game_id')
            .eq('season_year', year)
            .range(page * 1000, page * 1000 + 999)
        if (!batch?.length) break
        for (const r of batch) syncedSet.add(r.game_id)
        if (batch.length < 1000) break
        page++
    }
    const unsyncedGames = (finalGameIds ?? []).filter((g: any) => !syncedSet.has(g.id))

    const { count: playersWithoutNbaId } = await supabase
        .from('players')
        .select('id', { count: 'exact', head: true })
        .is('nba_id', null)

    return {
        seasonYear: year,
        totalGames: totalGames ?? 0,
        finalGames: finalGames ?? 0,
        gamesWithStats: (finalGameIds?.length ?? 0) - unsyncedGames.length,
        gamesWithoutStats: unsyncedGames.length,
        gamesMissingNbaGameId: gamesMissingNbaGameId ?? 0,
        playersWithoutNbaId: playersWithoutNbaId ?? 0,
        missingGameDetails: unsyncedGames.slice(0, 20).map((g: any) => ({
            nbaGameId: g.nba_game_id,
            gameDate: g.game_date,
            homeTeam: g.home_team,
            awayTeam: g.away_team,
        })),
    }
}
