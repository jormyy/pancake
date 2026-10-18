import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { todayET } from '@/lib/shared/dates'
import { leagueSnapshotRevision, type SnapshotDomain } from '@/lib/league-changes'

type Snapshot<T> = { data: T; scope: string; revision: string | null; savedAt: number }

export function tabSnapshotRevision(leagueId: string, domain: SnapshotDomain = 'roster'): string | null {
    const revision = leagueSnapshotRevision(leagueId, domain)
    return revision ? `${todayET()}:${revision}` : null
}

export function tabSnapshotScope(userId: string | undefined, memberId: string | undefined, leagueId: string | undefined, settings: unknown): string {
    return JSON.stringify([userId, memberId, leagueId, todayET(), settings])
}

export function readTabSnapshot<T>(key: string | undefined, scope: string, leagueId: string | undefined, domain: SnapshotDomain = 'roster'): { data: T; savedAt: number } | undefined {
    if (!key || !leagueId) return undefined
    const snapshot = readPersistentCache<Snapshot<T>>(key)
    if (!snapshot || snapshot.scope !== scope || !Number.isFinite(snapshot.savedAt) || snapshot.savedAt > Date.now()) return undefined
    const revision = tabSnapshotRevision(leagueId, domain)
    return { data: snapshot.data, savedAt: revision && revision === snapshot.revision ? snapshot.savedAt : 0 }
}

export function writeTabSnapshot<T>(key: string, scope: string, revision: string | null | undefined, data: T): void {
    writePersistentCache<Snapshot<T>>(key, { data, scope, revision: revision ?? null, savedAt: Date.now() })
}
