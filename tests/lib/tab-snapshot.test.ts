import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
import { notifyMemberClaimsChanged } from '@/lib/claim-updates'
import { clearPersistentCaches } from '@/lib/persistent-cache'
import { setSessionOwner } from '@/lib/session-cache-registry'
import { notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'
import { readTabSnapshot, tabSnapshotRevision, tabSnapshotScope, writeTabSnapshot } from '@/lib/tab-snapshot'

beforeEach(() => {
    clearPersistentCaches()
    setSessionOwner('user')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T16:00:00Z'))
    setLeagueChangesConnected('league', true)
})
afterEach(() => { vi.useRealTimers() })
const key = 'pancake:roster-screen:v3:league:member'
const scope = () => tabSnapshotScope('user', 'member', 'league', { roster_size: 20 })

it('retains saved age while separating account, member, league, day and settings', () => {
    const savedAt = Date.now(), original = scope()
    writeTabSnapshot(key, original, tabSnapshotRevision('league'), ['saved'])
    vi.advanceTimersByTime(60_000)
    expect(readTabSnapshot(key, original, 'league')).toEqual({ data: ['saved'], savedAt })
    for (const changed of [
        tabSnapshotScope('another', 'member', 'league', { roster_size: 20 }),
        tabSnapshotScope('user', 'another', 'league', { roster_size: 20 }),
        tabSnapshotScope('user', 'member', 'another', { roster_size: 20 }),
        tabSnapshotScope('user', 'member', 'league', { roster_size: 21 }),
    ]) expect(readTabSnapshot(key, changed, 'league')).toBeUndefined()
    const oldRevision = tabSnapshotRevision('league')
    vi.advanceTimersByTime(86400_000)
    expect(tabSnapshotRevision('league')).not.toBe(oldRevision)
    expect(readTabSnapshot(key, scope(), 'league')).toBeUndefined()
})

it('keeps cached content provisional after a relevant change, outage, or session clear', () => {
    const original = scope()
    const save = () => writeTabSnapshot(key, original, tabSnapshotRevision('league'), ['saved'])
    save()
    notifyLeagueChange('other', { topic: 'roster', scopes: null })
    expect(readTabSnapshot(key, original, 'league')?.savedAt).toBe(Date.now())
    notifyLeagueChange('league', { topic: 'inventory', scopes: null })
    expect(readTabSnapshot(key, original, 'league')).toEqual({ data: ['saved'], savedAt: 0 })
    save()
    setLeagueChangesConnected('league', false)
    expect(readTabSnapshot(key, original, 'league')?.savedAt).toBe(0)
    setLeagueChangesConnected('league', true)
    expect(readTabSnapshot(key, original, 'league')?.savedAt).toBe(0)
    save()
    clearPersistentCaches()
    expect(readTabSnapshot(key, original, 'league')).toBeUndefined()
})

it('cannot certify a stale response when changes arrive during its read', () => {
    const revision = tabSnapshotRevision('league')
    notifyLeagueChange('league', { topic: 'stat', scopes: null })
    writeTabSnapshot(key, scope(), revision, ['before-change'])
    expect(readTabSnapshot(key, scope(), 'league')).toEqual({ data: ['before-change'], savedAt: 0 })
    writeTabSnapshot(key, scope(), tabSnapshotRevision('league'), ['after-change'])
    expect(readTabSnapshot(key, scope(), 'league')).toEqual({ data: ['after-change'], savedAt: Date.now() })
})


it('does not expire slow-changing pick or support snapshots on score and stat ticks', () => {
    const picks = tabSnapshotRevision('league', 'picks'), support = tabSnapshotRevision('league', 'support')
    notifyLeagueChange('league', { topic: 'stat', scopes: null })
    notifyLeagueChange('league', { topic: 'score', scopes: null })
    expect(tabSnapshotRevision('league', 'picks')).toBe(picks)
    expect(tabSnapshotRevision('league', 'support')).toBe(support)
    notifyLeagueChange('league', { topic: 'roster', scopes: null })
    expect(tabSnapshotRevision('league', 'support')).not.toBe(support)
    expect(tabSnapshotRevision('league', 'picks')).toBe(picks)
    notifyLeagueChange('league', { topic: 'inventory', scopes: null })
    expect(tabSnapshotRevision('league', 'picks')).not.toBe(picks)
})

it('keeps member support fresh for picks, priority and another balance but invalidates own claims and balance', () => {
    const revision = () => tabSnapshotRevision('league', 'support', 'mine')
    const initial = revision()
    for (const resource of ['picks', 'priority', 'faab'] as const) {
        notifyLeagueChange('league', { topic: 'inventory', scopes: null, details: [{ resource, season_id: 'season', member_id: 'other' }] })
        expect(revision()).toBe(initial)
    }
    notifyLeagueChange('league', { topic: 'inventory', scopes: null, details: [{ resource: 'claims', season_id: 'season' }] })
    const claims = revision()
    expect(claims).not.toBe(initial)
    notifyLeagueChange('league', { topic: 'inventory', scopes: null, details: [{ resource: 'faab', season_id: 'season', member_id: 'mine' }] })
    expect(revision()).not.toBe(claims)
    const own = revision()
    notifyLeagueChange('league', { topic: 'inventory', scopes: null, details: null })
    expect(revision()).not.toBe(own)
})

it('invalidates hidden owner claim snapshots without expiring other members', () => {
    const own = tabSnapshotRevision('league', 'support', 'mine')
    const other = tabSnapshotRevision('league', 'support', 'other')
    const roster = tabSnapshotRevision('league', 'roster', 'mine')
    notifyMemberClaimsChanged('mine')
    expect(tabSnapshotRevision('league', 'support', 'mine')).not.toBe(own)
    expect(tabSnapshotRevision('league', 'support', 'other')).toBe(other)
    expect(tabSnapshotRevision('league', 'roster', 'mine')).not.toBe(roster)
})
