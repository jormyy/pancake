import { leagueSnapshotRevision } from '@/lib/league-changes'
import { onSessionCachesCleared, sessionGeneration } from '@/lib/session-cache-registry'
import { todayET } from '@/lib/shared/dates'

type Entry = { leagueId: string; promise: Promise<unknown>; savedAt: number; settled: boolean }
const entries = new Map<string, Entry>()
const MAX_AGE = 300_000
const MAX_ENTRIES = 64

function releaseLeagueDailyPending(leagueId?: string) {
    for (const [key, entry] of entries) if (!entry.settled && (!leagueId || entry.leagueId === leagueId)) entries.delete(key)
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseLeagueDailyPending()
})
if (typeof window !== 'undefined') window.addEventListener('offline', () => releaseLeagueDailyPending())
onSessionCachesCleared(() => entries.clear())

export function readLeagueDaily<Value>(leagueId: string, resourceKey: string, read: () => Promise<Value>): Promise<Value> {
    const revision = leagueSnapshotRevision(leagueId, 'daily')
    if (!revision) return read()
    const generation = sessionGeneration()
    const day = todayET()
    const key = JSON.stringify([generation, leagueId, day, revision, resourceKey])
    const existing = entries.get(key)
    if (existing && Date.now() - existing.savedAt < MAX_AGE) return existing.promise as Promise<Value>
    const entry: Entry = { leagueId, promise: Promise.resolve(), savedAt: Date.now(), settled: false }
    entry.promise = read().then(value => {
        entry.settled = true
        if (generation !== sessionGeneration() || day !== todayET() || revision !== leagueSnapshotRevision(leagueId, 'daily')) {
            if (entries.get(key) === entry) entries.delete(key)
        } else entry.savedAt = Date.now()
        return value
    }, error => {
        if (entries.get(key) === entry) entries.delete(key)
        throw error
    })
    entries.delete(key)
    entries.set(key, entry)
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!)
    return entry.promise as Promise<Value>
}
