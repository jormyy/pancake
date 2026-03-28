import axios from 'axios'
import { supabase } from '../lib/supabase'

const NBA_CDN = 'https://cdn.nba.com/static/json'

const client = axios.create({
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.nba.com',
        'Referer': 'https://www.nba.com/',
    },
})

export interface EndpointTestResult {
    endpoint: string
    status: 'ok' | 'error'
    statusCode?: number
    responseTimeMs: number
    error?: string
    sampleData?: any
}

export async function testNBAEndpoints(): Promise<EndpointTestResult[]> {
    // Fetch a known Final game ID from DB to test box score / play-by-play endpoints
    const { data: sampleGame } = await supabase
        .from('nba_games')
        .select('nba_game_id')
        .eq('status', 'Final')
        .not('nba_game_id', 'is', null)
        .order('game_date', { ascending: false })
        .limit(1)
        .single()

    const gameId = sampleGame?.nba_game_id ?? '0022401000'

    const tests: Array<{ name: string; url: string; validate: (data: any) => any }> = [
        {
            name: 'todaysScoreboard',
            url: `${NBA_CDN}/liveData/scoreboard/todaysScoreboard_00.json`,
            validate: (d) => ({
                gameCount: d?.scoreboard?.games?.length ?? 0,
                firstGame: d?.scoreboard?.games?.[0]
                    ? `${d.scoreboard.games[0].awayTeam?.teamTricode} @ ${d.scoreboard.games[0].homeTeam?.teamTricode}`
                    : 'no games today',
            }),
        },
        {
            name: `boxscore (${gameId})`,
            url: `${NBA_CDN}/liveData/boxscore/boxscore_${gameId}.json`,
            validate: (d) => ({
                homeTeam: d?.game?.homeTeam?.teamTricode,
                awayTeam: d?.game?.awayTeam?.teamTricode,
                playerCount: (d?.game?.homeTeam?.players?.length ?? 0) + (d?.game?.awayTeam?.players?.length ?? 0),
            }),
        },
        {
            name: 'seasonSchedule',
            url: `${NBA_CDN}/staticData/scheduleLeagueV2_1.json`,
            validate: (d) => ({
                gameDateCount: d?.leagueSchedule?.gameDates?.length ?? 0,
                firstDate: d?.leagueSchedule?.gameDates?.[0]?.gameDate ?? null,
            }),
        },
        {
            name: `playByPlay (${gameId})`,
            url: `${NBA_CDN}/liveData/playbyplay/playbyplay_${gameId}.json`,
            validate: (d) => ({
                actionCount: d?.game?.actions?.length ?? 0,
                firstAction: d?.game?.actions?.[0]?.actionType ?? null,
            }),
        },
    ]

    const results: EndpointTestResult[] = []

    for (const test of tests) {
        const start = Date.now()
        try {
            const { data, status } = await client.get(test.url)
            const responseTimeMs = Date.now() - start
            results.push({
                endpoint: test.name,
                status: 'ok',
                statusCode: status,
                responseTimeMs,
                sampleData: test.validate(data),
            })
        } catch (e: any) {
            results.push({
                endpoint: test.name,
                status: 'error',
                statusCode: e.response?.status,
                responseTimeMs: Date.now() - start,
                error: e.message,
            })
        }
    }

    return results
}
