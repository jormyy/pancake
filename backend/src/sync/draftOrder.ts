import axios from 'axios'
import { supabase } from '../lib/supabase'
import { normalizeName } from '../lib/utils/nameMatch'

const NBA_STATS_URL = 'https://stats.nba.com/stats/drafthistory'
const NBA_COM_BASE_URL = 'https://www.nba.com'
const MIN_COMPLETE_DRAFT_PICKS = 50
const PLAYER_UPDATE_CONCURRENCY = 10
const AUTO_SYNC_START_MONTH = 5 // June, zero-indexed
const AUTO_SYNC_END_MONTH = 6 // July, zero-indexed

export type DraftOrderSource = 'stats.nba.com' | 'nba.com'

export interface NBADraftPick {
    overallPick: number
    playerName: string
    roundNumber: number
    roundPick: number
    teamName: string
}

type PlayerRow = {
    id: string
    display_name: string | null
    first_name: string
    last_name: string
    nba_draft_number: number | null
}

export type SyncDraftOrderResult = {
    seasonYear: number
    source: DraftOrderSource
    draftPickCount: number
    updated: number
    inserted: number
    staleDraftNumbersCleared: number
    unmatched: string[]
}

const HTTP_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Referer: 'https://www.nba.com/',
    Origin: 'https://www.nba.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
}

async function fetchStatsDraftOrder(seasonYear: number): Promise<NBADraftPick[]> {
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
            ...HTTP_HEADERS,
            'x-nba-stats-origin': 'stats',
            'x-nba-stats-token': 'true',
        },
        timeout: 20000,
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
    if (Object.values(idx).some((i) => i < 0)) {
        throw new Error('NBA Stats draft history response is missing required columns')
    }

    return validateDraftPicks((resultSet.rowSet as any[][]).map((row) => ({
        overallPick: Number(row[idx.overall]),
        playerName: String(row[idx.playerName]),
        roundNumber: Number(row[idx.round]),
        roundPick: Number(row[idx.roundPick]),
        teamName: String(row[idx.teamName] ?? ''),
    })))
}

async function fetchNbaComDraftOrder(seasonYear: number): Promise<NBADraftPick[]> {
    const visited = new Set<string>()
    const queue = [
        `${NBA_COM_BASE_URL}/news/${seasonYear}-nba-draft-order`,
        `${NBA_COM_BASE_URL}/draft/${seasonYear}`,
    ]
    const errors: string[] = []

    for (let i = 0; i < queue.length; i++) {
        const url = queue[i]
        if (visited.has(url)) continue
        visited.add(url)

        try {
            const { data: html } = await axios.get<string>(url, {
                headers: HTTP_HEADERS,
                timeout: 20000,
                responseType: 'text',
            })
            const picks = parseDraftPicksFromNbaComHtml(html)
            if (picks.length >= MIN_COMPLETE_DRAFT_PICKS) return picks

            for (const linkedUrl of findDraftOrderLinks(html, seasonYear)) {
                if (!visited.has(linkedUrl)) queue.push(linkedUrl)
            }
            errors.push(`${url}: found ${picks.length} draft picks`)
        } catch (error) {
            errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    throw new Error(
        `Could not load a complete ${seasonYear} NBA draft board from NBA.com. ${errors.join('; ')}`,
    )
}

async function fetchDraftOrder(seasonYear: number): Promise<{ source: DraftOrderSource; picks: NBADraftPick[] }> {
    const errors: string[] = []

    try {
        const picks = await fetchStatsDraftOrder(seasonYear)
        if (picks.length >= MIN_COMPLETE_DRAFT_PICKS) return { source: 'stats.nba.com', picks }
        errors.push(`stats.nba.com returned ${picks.length} picks`)
    } catch (error) {
        errors.push(`stats.nba.com: ${error instanceof Error ? error.message : String(error)}`)
    }

    const picks = await fetchNbaComDraftOrder(seasonYear)
    if (errors.length > 0) {
        console.warn(`[draftOrder] Falling back to NBA.com (${errors.join('; ')})`)
    }
    return { source: 'nba.com', picks }
}

export function parseDraftPicksFromNbaComHtml(html: string): NBADraftPick[] {
    const articleText = extractArticleText(html)
    return articleText ? parseDraftPicksFromArticleText(articleText) : []
}

export function parseDraftPicksFromArticleText(articleText: string): NBADraftPick[] {
    const picks: NBADraftPick[] = []
    const lines = articleText
        .replace(/&gt;/g, '>')
        .replace(/\u00a0/g, ' ')
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)

    for (const line of lines) {
        const match = line.match(/^(\d{1,2})\.\s+(.+)$/)
        if (!match) continue

        const overallPick = Number(match[1])
        const beforeParenthetical = match[2].replace(/\s+\(.+$/, '').trim()
        const pickMatch = beforeParenthetical.match(
            /^(.+?)\s+(?:drafts?|selects?|takes?|picks?|from)\s+(.+)$/i,
        )
        if (!pickMatch) continue

        const playerName = cleanPlayerName(pickMatch[2])
        if (!playerName) continue

        picks.push({
            overallPick,
            playerName,
            teamName: pickMatch[1].trim(),
            roundNumber: overallPick <= 30 ? 1 : 2,
            roundPick: overallPick <= 30 ? overallPick : overallPick - 30,
        })
    }

    return validateDraftPicks(picks)
}

function extractArticleText(html: string): string | null {
    const nextData = extractNextData(html)
    const articleText = nextData?.props?.pageProps?.article?.contentText
    if (typeof articleText === 'string') return articleText

    return null
}

function findDraftOrderLinks(html: string, seasonYear: number): string[] {
    const nextData = extractNextData(html)
    const links = new Set<string>()
    const wanted = `${seasonYear}-nba-draft-order`

    function visit(value: unknown): void {
        if (!value) return
        if (typeof value === 'string') {
            if (value.includes(wanted)) links.add(toAbsoluteNbaUrl(value))
            return
        }
        if (Array.isArray(value)) {
            value.forEach(visit)
            return
        }
        if (typeof value === 'object') {
            for (const nested of Object.values(value)) visit(nested)
        }
    }

    visit(nextData)
    return [...links]
}

function extractNextData(html: string): any | null {
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
    if (!match) return null
    try {
        return JSON.parse(match[1])
    } catch {
        return null
    }
}

function toAbsoluteNbaUrl(url: string): string {
    if (url.startsWith('http')) return url
    if (url.startsWith('/')) return `${NBA_COM_BASE_URL}${url}`
    return `${NBA_COM_BASE_URL}/${url}`
}

function cleanPlayerName(name: string): string {
    return name
        .replace(/\s+via\s+.+$/i, '')
        .replace(/\s+to\s+.+$/i, '')
        .replace(/[;:,]+$/g, '')
        .trim()
}

function validateDraftPicks(picks: NBADraftPick[]): NBADraftPick[] {
    const byOverall = new Map<number, NBADraftPick>()
    for (const pick of picks) {
        if (
            !Number.isInteger(pick.overallPick) ||
            pick.overallPick < 1 ||
            pick.overallPick > 60 ||
            !pick.playerName
        ) {
            continue
        }
        if (byOverall.has(pick.overallPick)) {
            throw new Error(`Duplicate NBA draft pick #${pick.overallPick}`)
        }
        byOverall.set(pick.overallPick, pick)
    }
    return [...byOverall.values()].sort((a, b) => a.overallPick - b.overallPick)
}

export async function syncDraftOrder(seasonYear: number): Promise<SyncDraftOrderResult> {
    console.log(`[draftOrder] Fetching ${seasonYear} NBA draft order…`)

    const { source, picks } = await fetchDraftOrder(seasonYear)
    if (picks.length < MIN_COMPLETE_DRAFT_PICKS) {
        throw new Error(
            `[draftOrder] Refusing to sync an incomplete draft board: ${picks.length} picks found.`,
        )
    }
    console.log(`[draftOrder] Got ${picks.length} picks from ${source}`)

    const existingPlayers = await loadPlayers()
    const { resolved, unmatched } = await resolveDraftPlayers(picks, existingPlayers)
    if (unmatched.length > 0) {
        throw new Error(`[draftOrder] Could not resolve every pick: ${unmatched.join(', ')}`)
    }

    const draftPlayerIds = new Set(resolved.map((row) => row.playerId))
    const staleDraftNumbers = existingPlayers.filter(
        (player) => player.nba_draft_number != null && !draftPlayerIds.has(player.id),
    )

    const updateRows = resolved.map((row) => ({
        id: row.playerId,
        years_exp: 0,
        nba_draft_number: row.pick.overallPick,
    }))
    await updatePlayers(updateRows)

    if (staleDraftNumbers.length > 0) {
        await updatePlayers(staleDraftNumbers.map((player) => ({
            id: player.id,
            nba_draft_number: null,
        })))
    }

    await verifySyncedDraftBoard(picks)

    console.log(
        `[draftOrder] Done. Updated ${updateRows.length}/${picks.length}; ` +
        `inserted=${resolved.filter((row) => row.inserted).length}; ` +
        `cleared=${staleDraftNumbers.length}.`,
    )
    return {
        seasonYear,
        source,
        draftPickCount: picks.length,
        updated: updateRows.length,
        inserted: resolved.filter((row) => row.inserted).length,
        staleDraftNumbersCleared: staleDraftNumbers.length,
        unmatched,
    }
}

async function loadPlayers(): Promise<PlayerRow[]> {
    const rows: PlayerRow[] = []
    const pageSize = 1000
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await supabase
            .from('players')
            .select('id, display_name, first_name, last_name, nba_draft_number')
            .range(from, from + pageSize - 1)
        if (error) throw error
        rows.push(...((data ?? []) as PlayerRow[]))
        if (!data || data.length < pageSize) break
    }
    return rows
}

async function resolveDraftPlayers(
    picks: NBADraftPick[],
    existingPlayers: PlayerRow[],
): Promise<{
    resolved: Array<{ pick: NBADraftPick; playerId: string; inserted: boolean }>
    unmatched: string[]
}> {
    const byNormName = new Map<string, string>()
    for (const player of existingPlayers) {
        const displayName = player.display_name ?? `${player.first_name} ${player.last_name}`
        setUnique(byNormName, normalizeName(displayName), player.id)
    }

    const resolved: Array<{ pick: NBADraftPick; playerId: string; inserted: boolean }> = []
    const missing: NBADraftPick[] = []
    const unmatched: string[] = []

    for (const pick of picks) {
        const playerId = byNormName.get(normalizeName(pick.playerName))
        if (playerId && playerId !== '__ambiguous__') {
            resolved.push({ pick, playerId, inserted: false })
        } else if (playerId === '__ambiguous__') {
            unmatched.push(`#${pick.overallPick} ${pick.playerName} (ambiguous player name)`)
        } else {
            missing.push(pick)
        }
    }

    if (missing.length > 0) {
        const inserted = await insertMissingDraftPlayers(missing)
        for (const row of inserted) {
            byNormName.set(normalizeName(row.display_name ?? `${row.first_name} ${row.last_name}`), row.id)
        }
        for (const pick of missing) {
            const playerId = byNormName.get(normalizeName(pick.playerName))
            if (playerId && playerId !== '__ambiguous__') {
                resolved.push({ pick, playerId, inserted: true })
            } else {
                unmatched.push(`#${pick.overallPick} ${pick.playerName}`)
            }
        }
    }

    return {
        resolved: resolved.sort((a, b) => a.pick.overallPick - b.pick.overallPick),
        unmatched,
    }
}

async function insertMissingDraftPlayers(picks: NBADraftPick[]): Promise<PlayerRow[]> {
    const rows = picks.map((pick) => {
        const { firstName, lastName } = splitPlayerName(pick.playerName)
        return {
            first_name: firstName,
            last_name: lastName,
            nba_team: null,
            position: null,
            status: 'ACT',
            years_exp: 0,
            updated_at: new Date().toISOString(),
        }
    })

    const { data, error } = await supabase
        .from('players')
        .insert(rows as any)
        .select('id, display_name, first_name, last_name, nba_draft_number')
    if (error) throw error
    return (data ?? []) as PlayerRow[]
}

function splitPlayerName(displayName: string): { firstName: string; lastName: string } {
    const parts = displayName.trim().split(/\s+/)
    return {
        firstName: parts[0] ?? displayName,
        lastName: parts.slice(1).join(' ') || parts[0] || displayName,
    }
}

async function updatePlayers(rows: Record<string, unknown>[]): Promise<void> {
    for (let i = 0; i < rows.length; i += PLAYER_UPDATE_CONCURRENCY) {
        const chunk = rows.slice(i, i + PLAYER_UPDATE_CONCURRENCY)
        await Promise.all(chunk.map(async (row) => {
            const { id, ...fields } = row
            const { error } = await supabase.from('players').update(fields as any).eq('id', String(id))
            if (error) throw error
        }))
    }
}

async function verifySyncedDraftBoard(picks: NBADraftPick[]): Promise<void> {
    const { data, error } = await supabase
        .from('players')
        .select('id, display_name, nba_draft_number')
        .eq('years_exp', 0)
        .not('nba_draft_number', 'is', null)
        .order('nba_draft_number', { ascending: true })
    if (error) throw error

    const expected = new Set(picks.map((pick) => pick.overallPick))
    const actual = new Set((data ?? []).map((player: any) => Number(player.nba_draft_number)))
    const missing = [...expected].filter((pick) => !actual.has(pick))
    const extras = [...actual].filter((pick) => !expected.has(pick))
    if (missing.length > 0 || extras.length > 0 || (data ?? []).length !== picks.length) {
        throw new Error(
            `[draftOrder] Verification failed after sync. ` +
            `missing=[${missing.join(',')}], extras=[${extras.join(',')}], ` +
            `rows=${(data ?? []).length}, expected=${picks.length}.`,
        )
    }
}

function setUnique(map: Map<string, string>, key: string, value: string): void {
    const existing = map.get(key)
    if (!existing) {
        map.set(key, value)
    } else if (existing !== value) {
        map.set(key, '__ambiguous__')
    }
}

export function isDraftOrderAutoSyncWindow(now = new Date()): boolean {
    const month = now.getMonth()
    if (month === AUTO_SYNC_START_MONTH) return now.getDate() >= 20
    if (month === AUTO_SYNC_END_MONTH) return now.getDate() <= 15
    return false
}

export async function syncCurrentDraftOrderIfDue(now = new Date()): Promise<SyncDraftOrderResult | null> {
    if (!isDraftOrderAutoSyncWindow(now)) return null
    const seasonYear = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear()
    return syncDraftOrder(seasonYear)
}
