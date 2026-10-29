import { rememberLeagueTimezone } from '@/lib/league-timezones'
import { onSessionCachesCleared, sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import { compareLeagueVersions, leagueVersionSnapshot, readLeagueVersion, subscribeLeagueVersion, type LeagueVersionSnapshot } from '@/lib/league-version'
import { API_URL } from '@/lib/shared/api-url'
import { mergePlayerPage, playerPageOffset, type PlayerPages } from '@/lib/cache/player-pages'

export type ScreenName = 'home' | 'roster' | 'players' | 'player' | 'trades' | 'trade-block' | 'trade-details' | 'trade-analysis' | 'league' | 'league-schedule' | 'standings' | 'activity' | 'picks' | 'settings' | 'lineup' | 'claim-editor' | 'draft-rooms' | 'draft-room' | 'profile'
export type ScreenScope = { accountId: string; leagueId?: string | null; memberId?: string | null; seasonId?: string | null; screen: ScreenName; params?: Record<string, unknown> }
export type ViewContext = { league?: { timezone?: string | null }; pendingIncomingCount?: number; leagueId: string; memberId: string; seasonId: string | null; seasonYear: number; weekNumber: number | null; today: string; version: number | string | null; stale: boolean }
export type ScreenEnvelope<T> = { schema: 1; scope: ScreenScope; lookupScope?: ScreenScope; version: string; savedAt: number; value: T; dirty: boolean }
const prefix = 'pancake:screen-view:v1:'
const maxBytes = 4 * 1024 * 1024
const maxEntries = 48
const entries = new Map<string, ScreenEnvelope<unknown>>()
const pending = new Map<string, Promise<unknown>>()
const readTokens = new Map<string, { generation: number; epoch: number }>()
const checks = new Map<string, Promise<LeagueVersionSnapshot>>()
const listeners = new Map<string, Set<() => void>>()
const leagueStops = new Map<string, { count: number; stop: () => void }>()
const contextListeners = new Set<() => void>()
const revisions = new Map<string, number>()
let epoch = 0
let streamGeneration = sessionGeneration()

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    return value
}

export function screenCacheKey(scope: ScreenScope): string {
    return prefix + JSON.stringify(canonical({ ...scope, leagueId: scope.leagueId ?? null, memberId: scope.memberId ?? null, seasonId: scope.seasonId ?? null, params: scope.params ?? {} }))
}

function storage(): Storage | null {
    try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

function savedKeys(): string[] {
    const local = storage()
    if (!local) return []
    try { return Array.from({ length: local.length }, (_, index) => local.key(index)).filter((key): key is string => key?.startsWith(prefix) === true) } catch { return [] }
}

function restore(): void {
    const local = storage()
    for (const key of savedKeys()) {
        if ([...entries.values()].some(entry => screenCacheKey(entry.scope) === key)) continue
        try {
            const entry = JSON.parse(local!.getItem(key)!) as ScreenEnvelope<unknown>
            if (entry.schema === 1 && entry.scope?.accountId && screenCacheKey(entry.scope) === key && /^\d+$/.test(entry.version) && Number.isFinite(entry.savedAt)) {
                const lookup = screenCacheKey(entry.lookupScope ?? entry.scope)
                const existing = entries.get(lookup)
                if (!existing || existing.savedAt < entry.savedAt) entries.set(lookup, entry)
            }
            else local?.removeItem(key)
        } catch { try { local?.removeItem(key) } catch {} }
    }
}

export function cachedScreenView<T>(scope: ScreenScope): ScreenEnvelope<T> | undefined {
    restore()
    return entries.get(screenCacheKey(scope)) as ScreenEnvelope<T> | undefined
}

function publish(key: string): void {
    for (const listener of listeners.get(key) ?? []) listener()
}

export function saveScreenView<T>(scope: ScreenScope, value: T, version: string, replace = false): void {
    restore()
    const key = screenCacheKey(scope)
    const previous = entries.get(key)
    const partial = !replace && scope.screen === 'players' && typeof scope.params?.limit === 'number' && !scope.params.offset && previous
        && playerPageOffset(previous.value as PlayerPages) > playerPageOffset(value as PlayerPages)
    if (partial) value = mergePlayerPage(previous.value as PlayerPages, value as PlayerPages, 0) as T
    const context = value && typeof value === 'object' && 'context' in value ? value.context as ViewContext | null : null
    if (context?.leagueId && context.league) rememberLeagueTimezone(context.leagueId, context.league.timezone)
    const resolvedScope = context?.seasonId ? { ...scope, seasonId: context.seasonId } : scope
    const entry: ScreenEnvelope<T> = { schema: 1, scope: resolvedScope, lookupScope: scope, value, version, savedAt: Date.now(), dirty: Boolean(partial || !replace && scope.screen === 'players' && previous?.dirty) }
    const serialized = JSON.stringify(entry)
    const size = (text: string) => new TextEncoder().encode(text).length
    if (size(serialized) > maxBytes) return
    if (previous && screenCacheKey(previous.scope) !== screenCacheKey(resolvedScope)) { try { storage()?.removeItem(screenCacheKey(previous.scope)) } catch {} }
    entries.delete(key)
    entries.set(key, entry)
    let bytes = [...entries.values()].reduce((sum, item) => sum + size(JSON.stringify(item)), 0)
    for (const [oldKey, oldEntry] of [...entries].sort((a, b) => a[1].savedAt - b[1].savedAt)) {
        if (entries.size <= maxEntries && bytes <= maxBytes) break
        entries.delete(oldKey)
        bytes -= size(JSON.stringify(oldEntry))
        try { storage()?.removeItem(screenCacheKey(oldEntry.scope)) } catch {}
    }
    try { storage()?.setItem(screenCacheKey(resolvedScope), serialized) } catch {}
    publish(key)
    for (const listener of contextListeners) listener()
}

const dependencies: Record<ScreenName, string[]> = {
    home: ['roster', 'lineup', 'score', 'stat', 'player_stats', 'game', 'resources', 'inventory', 'announcement', 'forecast', 'settings', 'member', 'season'],
    roster: ['roster', 'lineup', 'inventory', 'resources', 'settings', 'member', 'season', 'trade', 'claim'],
    players: ['roster', 'inventory', 'resources', 'score', 'stat', 'player_stats', 'game', 'settings', 'season', 'claim'],
    player: ['roster', 'inventory', 'resources', 'stat', 'player_stats', 'game', 'settings', 'season', 'trade', 'claim'],
    trades: ['trade', 'roster', 'inventory', 'resources', 'member', 'settings', 'season'],
    'trade-block': ['trade', 'roster', 'inventory', 'resources', 'member', 'season'],
    'trade-details': ['trade', 'roster', 'inventory', 'resources', 'member', 'settings', 'season'],
    'trade-analysis': ['trade', 'resources', 'roster', 'inventory', 'settings', 'season'],
    league: ['score', 'roster', 'inventory', 'resources', 'member', 'settings', 'season', 'draft', 'activity', 'announcement'],
    'league-schedule': ['score', 'member', 'settings', 'season'],
    standings: ['score', 'member', 'season'], activity: ['activity', 'roster', 'inventory', 'trade', 'announcement', 'member'],
    picks: ['inventory', 'trade', 'draft', 'member', 'season'], settings: ['settings', 'inventory', 'member', 'season'],
    lineup: ['trade', 'claim', 'inventory', 'lineup', 'roster', 'game', 'stat', 'settings', 'resources', 'season'],
    'claim-editor': ['trade', 'roster', 'inventory', 'claim', 'member', 'settings', 'season'],
    'draft-rooms': ['draft', 'member', 'settings', 'season'], 'draft-room': ['draft', 'roster', 'inventory', 'member', 'settings', 'season'],
    profile: ['profile'],
}

function screenAffected(scope: ScreenScope, snapshot: LeagueVersionSnapshot, previous: string): boolean {
    if (compareLeagueVersions(snapshot.version, previous) <= 0) return false
    const changes = snapshot.changes.filter(change => compareLeagueVersions(change.version, previous) > 0)
    if (!changes.length || BigInt(changes[0].version) > BigInt(previous) + 1n) return true
    return changes.some(change => {
        if (change.topic === 'catchup') return true
        const rawTopics = Array.isArray(change.scope.topics) ? change.scope.topics : [change.topic]
        const topics = rawTopics.map(topic => topic === 'members' ? 'member' : topic === 'players' ? 'resources' : topic === 'projections' ? 'resources' : topic === 'claims' ? 'inventory' : topic)
        const known = new Set([...Object.values(dependencies).flat(), 'members', 'players', 'projections', 'claims'])
        if (topics.some(topic => typeof topic !== 'string' || !known.has(topic))) return true
        const tables = change.scope.tables
        if (scope.screen === 'players' && Array.isArray(tables) && tables.length > 0
            && tables.every(table => ['standings_current', 'matchup_totals', 'matchup_forecasts', 'trade_value_cache'].includes(table))) return false
        return topics.some(topic => dependencies[scope.screen].includes(String(topic)))
    })
}

function applyVersion(leagueId: string, snapshot: LeagueVersionSnapshot): void {
    restore()
    for (const [key, entry] of entries) {
        if (entry.scope.leagueId !== leagueId || compareLeagueVersions(snapshot.version, entry.version) <= 0) continue
        if (screenAffected(entry.scope, snapshot, entry.version)) {
            entry.dirty = true
            revisions.set(key, (revisions.get(key) ?? 0) + 1)
        } else entry.version = snapshot.version
        try { storage()?.setItem(screenCacheKey(entry.scope), JSON.stringify(entry)) } catch {}
        publish(key)
    }
}

export function invalidateScreenViews(leagueId?: string): void {
    restore()
    for (const [key, entry] of entries) {
        if (leagueId && entry.scope.leagueId !== leagueId) continue
        entry.dirty = true
        revisions.set(key, (revisions.get(key) ?? 0) + 1)
        try { storage()?.setItem(screenCacheKey(entry.scope), JSON.stringify(entry)) } catch {}
        publish(key)
    }
}

export function clearScreenViews(): void {
    if (streamGeneration !== sessionGeneration()) {
        streamGeneration = sessionGeneration()
        for (const stream of leagueStops.values()) stream.stop()
        leagueStops.clear()
    }
    epoch += 1
    entries.clear()
    pending.clear()
    readTokens.clear()
    checks.clear()
    revisions.clear()
    for (const key of savedKeys()) { try { storage()?.removeItem(key) } catch {} }
    for (const key of listeners.keys()) publish(key)
    for (const listener of contextListeners) listener()
}

export function subscribeScreenView(scope: ScreenScope, listener: () => void): () => void {
    const key = screenCacheKey(scope)
    const group = listeners.get(key) ?? new Set()
    group.add(listener)
    listeners.set(key, group)
    const leagueId = scope.leagueId
    let selectedStream: { count: number; stop: () => void } | undefined
    if (leagueId) {
        let stream = leagueStops.get(leagueId)
        if (!stream) {
            stream = { count: 0, stop: subscribeLeagueVersion(leagueId, snapshot => applyVersion(leagueId, snapshot)) }
            leagueStops.set(leagueId, stream)
        }
        stream.count += 1
        selectedStream = stream
    }
    return () => {
        group.delete(listener)
        if (!group.size) { listeners.delete(key); pending.delete(key); readTokens.delete(key) }
        const stream = leagueId ? leagueStops.get(leagueId) : undefined
        if (stream && stream === selectedStream && --stream.count === 0) { stream.stop(); leagueStops.delete(leagueId!) }
    }
}

function checkVersion(scope: ScreenScope): Promise<LeagueVersionSnapshot> {
    const leagueId = scope.leagueId!
    const key = JSON.stringify([scope.accountId, leagueId])
    const existing = checks.get(key)
    if (existing) return existing
    const task = readLeagueVersion(leagueId).then(snapshot => { applyVersion(leagueId, snapshot); return snapshot }).finally(() => { if (checks.get(key) === task) checks.delete(key) })
    checks.set(key, task)
    return task
}

export async function readScreenView<T>(scope: ScreenScope, options: { force?: boolean; checkVersion?: boolean } = {}): Promise<T> {
    const key = screenCacheKey(scope)
    const existing = pending.get(key)
    if (existing && readTokens.get(key)?.generation === sessionGeneration() && readTokens.get(key)?.epoch === epoch) return existing as Promise<T>
    const requestEpoch = epoch
    const generation = sessionGeneration()
    const token = { generation, epoch: requestEpoch }
    readTokens.set(key, token)
    const current = () => requestEpoch === epoch && generation === sessionGeneration() && readTokens.get(key) === token
    const task = (async () => {
        const cached = cachedScreenView<T>(scope)
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            if (cached) return cached.value
            throw new Error('Offline. Open this screen online first.')
        }
        if (!cached && scope.leagueId && typeof window !== 'undefined' && typeof window.WebSocket === 'function') {
            const { waitForLeagueChanges } = await import('@/lib/league-changes')
            await waitForLeagueChanges(scope.leagueId)
        }
        if (scope.leagueId && options.checkVersion !== false) await checkVersion(scope)
        if (!current()) throw new Error('Your account or league changed. Please retry.')
        const selected = cachedScreenView<T>(scope)
        if (scope.leagueId && selected && !selected.dirty && !options.force) return selected.value
        const { supabase } = await import('@/lib/supabase')
        const { data: { session } } = await supabase.auth.getSession()
        if (!current() || session?.user.id !== scope.accountId) throw new Error('Your account changed. Please retry.')
        let value: T
        let revision: number
        let version: string
        do {
            revision = revisions.get(key) ?? 0
            version = scope.leagueId ? leagueVersionSnapshot(scope.leagueId).version : '0'
            const paginated = scope.screen === 'players' && typeof scope.params?.limit === 'number' && !scope.params.offset
            let offset = 0
            let combined: PlayerPages | undefined
            do {
                const params = offset ? { ...scope.params, offset } : scope.params ?? {}
                const query = new URLSearchParams({ params: JSON.stringify(params) })
                if (scope.leagueId) query.set('leagueId', scope.leagueId)
                if (scope.memberId) query.set('memberId', scope.memberId)
                const response = await fetch(`${API_URL}/views/${scope.screen}?${query}`, { headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store', signal: AbortSignal.timeout(30_000) })
                const body = await response.json() as { ok?: boolean; view?: T; error?: string }
                if (!current()) throw new Error('Your account or league changed. Please retry.')
                if (!response.ok || body.ok !== true || body.view === undefined) throw new Error(body.error ?? 'Could not load this screen.')
                value = body.view
                if (!paginated) break
                const page = value as PlayerPages
                combined = combined ? mergePlayerPage(combined, page, offset) : { ...page, nextOffset: page.players.length }
                offset += page.players.length
                value = combined as T
                if (!page.hasMore || page.players.length === 0) break
            } while (offset < playerPageOffset(cachedScreenView<PlayerPages>(scope)?.value ?? combined!))
            if (scope.screen === 'league-schedule') {
                const published = (value as { context?: { version?: unknown } }).context?.version
                if (typeof published !== 'string' || !/^\d+$/.test(published)) throw new Error('Could not read the schedule version.')
                version = published
            }
        } while (revision !== (revisions.get(key) ?? 0) || Boolean(scope.leagueId && screenAffected(scope, leagueVersionSnapshot(scope.leagueId), version)))
        saveScreenView(scope, value, version, true)
        return value
    })()
    pending.set(key, task)
    try { return await task } finally { if (pending.get(key) === task) { pending.delete(key); if (readTokens.get(key) === token) readTokens.delete(key) } }
}

onSessionCachesCleared(clearScreenViews)

export function latestScreenContext(accountId: string, leagueId: string): ViewContext | undefined {
    restore()
    const entry = [...entries.values()].filter(item => item.scope.accountId === accountId && item.scope.leagueId === leagueId).sort((a, b) => b.savedAt - a.savedAt)[0]
    const value = entry?.value as { context?: ViewContext } | undefined
    return value?.context
}

export function subscribeScreenContext(listener: () => void): () => void {
    contextListeners.add(listener)
    return () => { contextListeners.delete(listener) }
}

export async function refreshScreenVersions(leagueId?: string): Promise<void> {
    const accountId = sessionOwner()
    if (!accountId) return
    const leagues = leagueId ? [leagueId] : [...new Set([...entries.values()].filter(entry => entry.scope.accountId === accountId).flatMap(entry => entry.scope.leagueId ? [entry.scope.leagueId] : []))]
    await Promise.all(leagues.map(async id => {
        try { await checkVersion({ accountId, leagueId: id, screen: 'home' }) }
        catch { invalidateScreenViews(id) }
    }))
}
