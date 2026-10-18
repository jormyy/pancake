import { onSessionCachesCleared } from '@/lib/session-cache-registry'

type Topic = 'lineup' | 'roster' | 'score' | 'game' | 'stat' | 'inventory'
type Scope = { season_id: string; member_id?: string; date?: string | null; week?: number }
export type LeagueChange = { topic: Topic | 'catchup'; scopes: Scope[] | null }
type Listener = (change: LeagueChange) => void
const topics = new Set(['lineup', 'roster', 'score', 'game', 'stat', 'inventory'])
const listeners = new Map<string, Set<Listener>>()
const connected = new Set<string>()
const revisions = new Map<string, Map<string, number>>()
export type SnapshotDomain = 'roster' | 'support' | 'picks'
const snapshotTopics = { roster: ['lineup', 'roster', 'inventory', 'game', 'stat', 'catchup'], support: ['roster', 'inventory', 'catchup'], picks: ['inventory', 'catchup'] }
const runtimeKey = `${Date.now()}:${Math.random()}`
let sessionEpoch = 0

export function leagueSnapshotRevision(leagueId: string, domain: SnapshotDomain = 'roster'): string | null {
    return connected.has(leagueId) ? `${runtimeKey}:${sessionEpoch}:${snapshotTopics[domain].map(topic => revisions.get(leagueId)?.get(topic) ?? 0).join(':')}` : null
}

export function invalidateLeagueSnapshot(leagueId: string, topic = 'catchup'): void {
    let group = revisions.get(leagueId)
    if (!group) { group = new Map(); revisions.set(leagueId, group) }
    group.set(topic, (group.get(topic) ?? 0) + 1)
}

export function leagueChangesConnected(leagueId: string): boolean {
    return connected.has(leagueId)
}

export function setLeagueChangesConnected(leagueId: string, ready: boolean): void {
    if (ready) connected.add(leagueId)
    else { if (connected.has(leagueId)) invalidateLeagueSnapshot(leagueId); connected.delete(leagueId) }
}

export function notifyLeagueChange(leagueId: string, change: LeagueChange): void {
    invalidateLeagueSnapshot(leagueId, change.topic)
    for (const listener of listeners.get(leagueId) ?? []) listener(change)
}

export function listenForLeagueChanges(leagueId: string, listener: Listener): () => void {
    let group = listeners.get(leagueId)
    if (!group) { group = new Set(); listeners.set(leagueId, group) }
    group.add(listener)
    if (connected.has(leagueId)) listener({ topic: 'catchup', scopes: null })
    return () => {
        group.delete(listener)
        if (!group.size) listeners.delete(leagueId)
    }
}

export function leagueChangeAffects(change: LeagueChange, selection: { seasonId: string; memberIds?: string[]; date?: string; week?: number }): boolean {
    return change.scopes === null || change.scopes.some(scope => scope.season_id === selection.seasonId
        && (!scope.member_id || !selection.memberIds || selection.memberIds.includes(scope.member_id))
        && (!scope.date || !selection.date || scope.date === selection.date)
        && (scope.week === undefined || selection.week === undefined || scope.week === selection.week))
}

export function leagueChangeReceiver(leagueId: string, receive: Listener): (row: Record<string, unknown>) => void {
    const revisions = new Map<string, bigint>()
    return row => {
        if (row.league_id !== leagueId || typeof row.topic !== 'string' || !topics.has(row.topic)) return
        const raw = row.revision
        if (!(typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0)
            && !(typeof raw === 'string' && /^[1-9]\d*$/.test(raw))) return
        const revision = BigInt(raw as number | string)
        const previous = revisions.get(row.topic)
        if (previous !== undefined && revision <= previous) return
        const scopes = row.scopes
        if (scopes !== null && (!Array.isArray(scopes) || !scopes.every(scope => scope && typeof scope === 'object'
            && typeof scope.season_id === 'string'
            && (scope.member_id === undefined || typeof scope.member_id === 'string')
            && (scope.date == null || typeof scope.date === 'string')
            && (scope.week === undefined || Number.isSafeInteger(scope.week))))) return
        revisions.set(row.topic, revision)
        receive({ topic: row.topic as Topic, scopes: previous !== undefined && revision > previous + 1n ? null : scopes as Scope[] | null })
    }
}

export function deferLeagueRefresh(read: () => unknown | Promise<unknown>, delayMs = 200) {
    let disposed = false
    let pending = false
    let running = false
    let attempts = 0
    let queuedAt: number | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const active = () => !disposed && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
        && (typeof navigator === 'undefined' || navigator.onLine !== false)
    const schedule = (delay: number) => {
        if (!pending || running || !active() || attempts >= 3) return
        if (timer) clearTimeout(timer)
        const remaining = attempts || queuedAt === null ? delay : Math.max(0, 1000 - (Date.now() - queuedAt))
        timer = setTimeout(() => { timer = null; void run() }, Math.min(delay, remaining))
    }
    const run = async () => {
        if (!active() || running || !pending) return
        pending = false
        queuedAt = null
        running = true
        attempts += 1
        try { if (await read() === false) pending = true; else attempts = 0 }
        catch (error) { pending = true; if (!disposed) console.error('Could not refresh changed league data.', error) }
        finally { running = false; schedule(attempts ? attempts * 2_000 : delayMs) }
    }
    const resume = () => { if (active() && pending) { attempts = 0; schedule(delayMs) } }
    if (typeof window !== 'undefined') window.addEventListener('online', resume)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume)
    return {
        trigger: () => { if (disposed) return; queuedAt ??= Date.now(); pending = true; attempts = 0; schedule(delayMs) },
        cancel: () => {
            disposed = true
            if (timer) clearTimeout(timer)
            if (typeof window !== 'undefined') window.removeEventListener('online', resume)
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume)
        },
    }
}

onSessionCachesCleared(() => { connected.clear(); revisions.clear(); sessionEpoch += 1 })
