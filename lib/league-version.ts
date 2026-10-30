import { listenForLeagueChanges } from '@/lib/league-changes'
import { onSessionCachesCleared, sessionGeneration } from '@/lib/session-cache-registry'
import { API_URL } from '@/lib/shared/api-url'

export type LeagueVersionChange = { version: string; topic: string; scope: Record<string, unknown>; created_at: string }
export type LeagueVersionSnapshot = { version: string; changes: LeagueVersionChange[] }
const snapshots = new Map<string, LeagueVersionSnapshot>()
const listeners = new Map<string, Set<(snapshot: LeagueVersionSnapshot) => void>>()
const stops = new Map<string, () => void>()
const empty: LeagueVersionSnapshot = { version: '0', changes: [] }
let versionGeneration = sessionGeneration()

export function normalizeLeagueVersion(value: unknown): string {
    const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
    if (typeof text !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(text) || BigInt(text) > 9223372036854775807n) {
        throw new Error('Invalid league version')
    }
    return text
}

export function compareLeagueVersions(left: string, right: string): number {
    const a = BigInt(normalizeLeagueVersion(left))
    const b = BigInt(normalizeLeagueVersion(right))
    return a > b ? 1 : a < b ? -1 : 0
}

export function leagueVersionSnapshot(leagueId: string): LeagueVersionSnapshot {
    return snapshots.get(leagueId) ?? empty
}

export function applyLeagueVersion(leagueId: string, value: unknown): LeagueVersionSnapshot {
    if (!value || typeof value !== 'object' || !('version' in value) || !('changes' in value)) throw new Error('Invalid league version response')
    const version = normalizeLeagueVersion(value.version)
    if (!Array.isArray(value.changes) || value.changes.length > 128) throw new Error('Invalid league changes')
    let previous = '0'
    const changes: LeagueVersionChange[] = value.changes.map(change => {
        if (!change || typeof change !== 'object' || typeof change.topic !== 'string'
            || !change.scope || typeof change.scope !== 'object' || Array.isArray(change.scope)
            || typeof change.created_at !== 'string') throw new Error('Invalid league change')
        const next = normalizeLeagueVersion(change.version)
        if (compareLeagueVersions(next, previous) <= 0 || compareLeagueVersions(next, version) > 0) throw new Error('Invalid league change order')
        previous = next
        return { version: next, topic: change.topic, scope: change.scope, created_at: change.created_at }
    })
    const current = leagueVersionSnapshot(leagueId)
    if (compareLeagueVersions(version, current.version) <= 0) return current
    const unseen = changes.filter(change => compareLeagueVersions(change.version, current.version) > 0)
    const gap = !unseen.length || BigInt(unseen[0].version) > BigInt(current.version) + 1n
        || unseen.at(-1)?.version !== version
        || unseen.some((change, index) => index > 0 && BigInt(change.version) !== BigInt(unseen[index - 1].version) + 1n)
    const snapshot = { version, changes: gap
        ? [{ version, topic: 'catchup', scope: {}, created_at: unseen.at(-1)?.created_at ?? new Date().toISOString() }]
        : unseen }

    snapshots.set(leagueId, snapshot)
    for (const listener of listeners.get(leagueId) ?? []) listener(snapshot)
    return snapshot
}

export async function readLeagueVersion(leagueId: string, since = leagueVersionSnapshot(leagueId).version): Promise<LeagueVersionSnapshot> {
    const generation = sessionGeneration()
    const floor = normalizeLeagueVersion(since)
    const { supabase } = await import('@/lib/supabase')
    const { data: { session } } = await supabase.auth.getSession()
    if (!session || generation !== sessionGeneration()) throw new Error('Your account changed. Please retry.')
    const response = await fetch(`${API_URL}/version?league=${encodeURIComponent(leagueId)}&since=${floor}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
    })
    const data: unknown = await response.json()
    if (generation !== sessionGeneration()) throw new Error('Your account changed. Please retry.')
    if (!response.ok) throw new Error('Could not read the league version')
    if (data && typeof data === 'object' && 'version' in data && compareLeagueVersions(normalizeLeagueVersion(data.version), floor) < 0) {
        return applyLeagueVersion(leagueId, { version: floor, changes: [] })
    }
    return applyLeagueVersion(leagueId, data)
}

export function subscribeLeagueVersion(leagueId: string, listener: (snapshot: LeagueVersionSnapshot) => void, replayVersion = false): () => void {
    let group = listeners.get(leagueId)
    if (!group) { group = new Set(); listeners.set(leagueId, group) }
    group.add(listener)
    if (!stops.has(leagueId)) {
        stops.set(leagueId, listenForLeagueChanges(leagueId, change => {
            if (change.topic === 'version' && change.version && change.changes) {
                applyLeagueVersion(leagueId, { version: change.version, changes: change.changes })
            }
        }, replayVersion))
    }
    return () => {
        group.delete(listener)
        if (!group.size && listeners.get(leagueId) === group) {
            listeners.delete(leagueId)
            stops.get(leagueId)?.()
            stops.delete(leagueId)
        }
    }
}

onSessionCachesCleared(() => {
    if (versionGeneration === sessionGeneration()) {
        for (const [leagueId, previous] of snapshots) {
            const snapshot: LeagueVersionSnapshot = { version: previous.version, changes: [{
                version: previous.version, topic: 'catchup', scope: {}, created_at: new Date().toISOString(),
            }] }
            snapshots.set(leagueId, snapshot)
            for (const listener of listeners.get(leagueId) ?? []) listener(snapshot)
        }
        return
    }
    versionGeneration = sessionGeneration()
    for (const stop of stops.values()) stop()
    stops.clear()
    listeners.clear()
    snapshots.clear()
})
