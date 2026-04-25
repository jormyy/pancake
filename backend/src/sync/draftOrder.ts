import axios from 'axios'
import { supabase } from '../lib/supabase'
import { normalizeName } from '../lib/utils/nameMatch'

// NBA Stats API draft history endpoint
// Season format: just the year, e.g. "2025" for the 2025 draft
const NBA_STATS_URL = 'https://stats.nba.com/stats/drafthistory'

interface NBADraftPick {
    overallPick: number
    playerName: string
    roundNumber: number
    roundPick: number
    teamName: string
}

async function fetchDraftOrder(seasonYear: number): Promise<NBADraftPick[]> {
    const { data } = await axios.get(NBA_STATS_URL, {
        params: {
            LeagueID: '00',
            Season: String(seasonYear),
            RoundNum: '',
            RoundPick: '',
            TeamID: '0',
            Overall_Pick: '',
            SeasonType: '',
        },
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Referer: 'https://www.nba.com/',
            Origin: 'https://www.nba.com',
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'x-nba-stats-origin': 'stats',
            'x-nba-stats-token': 'true',
        },
        timeout: 15000,
    })

    const resultSet = data?.resultSets?.[0]
    if (!resultSet) throw new Error('Unexpected response shape from NBA Stats API')

    const headers: string[] = resultSet.headers
    const idx = {
        playerName: headers.indexOf('PLAYER_NAME'),
        overall: headers.indexOf('OVERALL_PICK'),
        round: headers.indexOf('ROUND_NUMBER'),
        roundPick: headers.indexOf('ROUND_PICK'),
        teamName: headers.indexOf('TEAM_NAME'),
    }

    return (resultSet.rowSet as any[][]).map((row) => ({
        overallPick: Number(row[idx.overall]),
        playerName: String(row[idx.playerName]),
        roundNumber: Number(row[idx.round]),
        roundPick: Number(row[idx.roundPick]),
        teamName: String(row[idx.teamName]),
    }))
}

export async function syncDraftOrder(seasonYear: number): Promise<{ updated: number; unmatched: string[] }> {
    console.log(`[draftOrder] Fetching ${seasonYear} NBA draft order from stats.nba.com…`)

    const picks = await fetchDraftOrder(seasonYear)
    console.log(`[draftOrder] Got ${picks.length} picks`)

    // Fetch all players with years_exp = 0 (current rookies)
    const { data: players, error } = await supabase
        .from('players')
        .select('id, display_name, first_name, last_name')
        .eq('years_exp', 0)

    if (error) throw error

    const playersByNorm = new Map<string, string>() // normalized name -> player id
    for (const p of players ?? []) {
        playersByNorm.set(normalizeName((p as any).display_name), (p as any).id)
    }

    let updated = 0
    const unmatched: string[] = []

    for (const pick of picks) {
        const norm = normalizeName(pick.playerName)
        const playerId = playersByNorm.get(norm)

        if (!playerId) {
            unmatched.push(`#${pick.overallPick} ${pick.playerName}`)
            continue
        }

        const { error: updateErr } = await supabase
            .from('players')
            .update({ nba_draft_number: pick.overallPick })
            .eq('id', playerId)

        if (updateErr) {
            console.error(`[draftOrder] Failed to update ${pick.playerName}:`, updateErr.message)
        } else {
            updated++
        }
    }

    if (unmatched.length > 0) {
        console.warn(`[draftOrder] ${unmatched.length} picks could not be matched to DB players:`)
        unmatched.forEach((p) => console.warn(`  ${p}`))
    }

    console.log(`[draftOrder] Done. Updated ${updated}/${picks.length} players.`)
    return { updated, unmatched }
}
