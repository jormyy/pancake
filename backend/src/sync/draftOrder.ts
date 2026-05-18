import axios from 'axios'
import { supabase } from '../lib/supabase'
import { normalizeName } from '../lib/utils/nameMatch'

// NBA Stats API draft history endpoint
// Season format: just the year, e.g. "2025" for the 2025 draft
//
// IMPORTANT: stats.nba.com is cloud-blocked. The NBA actively blocks requests
// from data-center IP ranges (Railway, Render, AWS, GCP, etc.), so this call
// will fail/hang in production. The rest of pancake migrated to cdn.nba.com
// for live data, but the CDN does not expose a static draft-history feed
// (CDN only carries scoreboards, schedules, headshots, and box scores).
//
// Workaround: this sync is intended to be run **manually from a local dev
// machine** (or any non-data-center IP) via the admin route. If we detect a
// known cloud env we short-circuit with a clear error so the failure is loud
// rather than silent.
const NBA_STATS_URL = 'https://stats.nba.com/stats/drafthistory'

// Railway, Render, Fly, and Vercel each set a platform-specific env var.
// Presence of any signals we are running in a data-center where stats.nba.com
// is blocked. This is best-effort: it does not have to be exhaustive, only
// loud enough to make the cloud failure obvious instead of silent.
function isCloudHostEnv(): boolean {
    return Boolean(
        process.env.RAILWAY_ENVIRONMENT ||
        process.env.RAILWAY_PROJECT_ID ||
        process.env.RENDER ||
        process.env.FLY_APP_NAME ||
        process.env.VERCEL,
    )
}

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
    if (isCloudHostEnv()) {
        // Fail loud and early. The previous behaviour silently hung/errored
        // mid-fetch because stats.nba.com drops cloud-IP connections.
        throw new Error(
            '[draftOrder] stats.nba.com is blocked on cloud hosts (Railway/Render/Fly/Vercel). ' +
            'Run this sync from a local dev machine: `npm run sync:draft-order` ' +
            'or POST /sync/draft-order against a local backend.',
        )
    }

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

    // Build a single upsert payload instead of one UPDATE per pick.
    // Rows are guaranteed to exist (we just selected them), so upsert(onConflict:'id')
    // merges nba_draft_number into the existing row without disturbing other columns.
    // Cast to any: generated types want a full row, but PostgREST accepts a
    // partial payload on the UPDATE path of an upsert.
    const updates: Array<{ id: string; nba_draft_number: number }> = []
    const unmatched: string[] = []

    for (const pick of picks) {
        const norm = normalizeName(pick.playerName)
        const playerId = playersByNorm.get(norm)

        if (!playerId) {
            unmatched.push(`#${pick.overallPick} ${pick.playerName}`)
            continue
        }

        updates.push({ id: playerId, nba_draft_number: pick.overallPick })
    }

    // Chunk at 500 rows per upsert (matches the pattern used in historicalCDN/stats sync).
    let updated = 0
    for (let i = 0; i < updates.length; i += 500) {
        const chunk = updates.slice(i, i + 500)
        const { error: upsertErr } = await supabase
            .from('players')
            .upsert(chunk as any, { onConflict: 'id' })

        if (upsertErr) {
            console.error(`[draftOrder] Upsert failed for chunk starting at ${i}:`, upsertErr.message)
            // Continue with remaining chunks rather than aborting the whole sync.
            continue
        }
        updated += chunk.length
    }

    if (unmatched.length > 0) {
        console.warn(`[draftOrder] ${unmatched.length} picks could not be matched to DB players:`)
        unmatched.forEach((p) => console.warn(`  ${p}`))
    }

    console.log(`[draftOrder] Done. Updated ${updated}/${picks.length} players.`)
    return { updated, unmatched }
}
