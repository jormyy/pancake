import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { memberClaimsRevision } from '@/lib/claim-updates'
import { todayLeague } from '@/lib/timezone'
import { leagueTimezone } from '@/lib/league-timezones'
import { leagueSnapshotRevision, type SnapshotDomain } from '@/lib/league-changes'

type Snapshot<T> = { data: T; scope: string; revision: string | null; savedAt: number }

export function tabSnapshotRevision(leagueId: string, domain: SnapshotDomain = 'roster', memberId?: string): string | null {
    const revision = leagueSnapshotRevision(leagueId, domain, memberId)
    return revision ? `${todayLeague(leagueTimezone(leagueId))}:${revision}${memberId && (domain === 'roster' || domain === 'support') ? `:claims:${memberClaimsRevision(memberId)}` : ''}` : null
}

export function tabSnapshotScope(userId: string | undefined, memberId: string | undefined, leagueId: string | undefined, settings: unknown): string {
    return JSON.stringify([userId, memberId, leagueId, todayLeague(leagueTimezone(leagueId)), settings])
}

export function readTabSnapshot<T>(key: string | undefined, scope: string, leagueId: string | undefined, domain: SnapshotDomain = 'roster', memberId?: string): { data: T; savedAt: number } | undefined {
    if (!key || !leagueId) return undefined
    const snapshot = readPersistentCache<Snapshot<T>>(key)
    if (!snapshot || snapshot.scope !== scope || !Number.isFinite(snapshot.savedAt) || snapshot.savedAt > Date.now()) return undefined
    const revision = tabSnapshotRevision(leagueId, domain, memberId)
    return { data: snapshot.data, savedAt: revision && revision === snapshot.revision ? snapshot.savedAt : 0 }
}

export function writeTabSnapshot<T>(key: string, scope: string, revision: string | null | undefined, data: T): void {
    writePersistentCache<Snapshot<T>>(key, { data, scope, revision: revision ?? null, savedAt: Date.now() })
}
