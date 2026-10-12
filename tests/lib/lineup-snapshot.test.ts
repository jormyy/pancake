import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ owner: 'owner', generation: 1, admitted: true }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('@/lib/supabase', () => ({ readStoredAuthState: () => ({ session: state.admitted ? {
    user: { id: state.owner }, access_token: `header.${btoa(JSON.stringify({ iss: 'https://own.example/auth/v1' }))}.signature`,
} : null }) }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => state.owner, sessionGeneration: () => state.generation, clearSessionCaches: () => {} }))
import { clearPersistentCaches, readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { readLineupSnapshot, saveLineupSnapshot, discardLineupSnapshot } from '@/lib/lineup/snapshot'

const scope = { ownerId: 'owner', memberId: 'member', leagueId: 'league', day: '2026-10-08' }
const player = { rosterPlayerId: 'roster', playerId: 'player', displayName: 'Saved player', position: 'PG', eligiblePositions: ['PG'], nbaTeam: 'ATL', injuryStatus: null, nbaId: null }
const value = { context: { seasonId: 'season', seasonYear: 2027, weekNumber: 1, today: scope.day }, date: scope.day,
    days: [{ date: scope.day, dayLabel: 'T', dateNum: 8, hasGames: true, isToday: true, playingTeams: ['ATL', 'BOS'] }],
    starters: [{ slotType: 'PG', player }], bench: [], optimizerEnabled: true }
const prefix = `pancake:lineup-screen:v1:${encodeURIComponent('https://own.example/auth/v1')}:owner:league:member:2026-10-08`
const key = `${prefix}:season:2026-10-08`

describe('private matching-day Lineup snapshots', () => {
    beforeEach(() => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-08T22:00:00Z'))
        state.owner = 'owner'; state.generation = 1; state.admitted = true; clearPersistentCaches()
    })
    it('restores the exact successful domain and context, without storing session tokens', () => {
        saveLineupSnapshot(scope, 1, value)
        expect(readLineupSnapshot(scope, scope.day)).toMatchObject(value)
        expect(JSON.stringify(readPersistentCache(key))).not.toContain('access_token')
    })
    it.each(['ownerId', 'memberId', 'leagueId', 'day'] as const)('does not cross %s', (field) => {
        saveLineupSnapshot(scope, 1, value)
        expect(readLineupSnapshot({ ...scope, [field]: 'other' }, scope.day)).toBeUndefined()
    })
    it('does not reuse another selected date or a newly confirmed season', () => {
        saveLineupSnapshot(scope, 1, value)
        expect(readLineupSnapshot(scope, '2026-10-09')).toBeUndefined()
        expect(readLineupSnapshot(scope, scope.day, { ...value.context, seasonId: 'new-season' })).toBeUndefined()
    })
    it('does not admit expired, denied, signed-out or another owner storage', () => {
        saveLineupSnapshot(scope, 1, value)
        state.admitted = false
        expect(readLineupSnapshot(scope, scope.day)).toBeUndefined()
        state.admitted = true; state.owner = 'other'
        expect(readLineupSnapshot(scope, scope.day)).toBeUndefined()
    })
    it('rejects delayed writes from the previous session generation', () => {
        state.generation = 2
        saveLineupSnapshot(scope, 1, value)
        expect(readLineupSnapshot(scope, scope.day)).toBeUndefined()
    })
    it('expires at ET midnight rather than relabeling yesterday as today', () => {
        saveLineupSnapshot(scope, 1, value)
        vi.setSystemTime(new Date('2026-10-09T03:59:59Z'))
        expect(readLineupSnapshot(scope, scope.day)).toBeDefined()
        vi.setSystemTime(new Date('2026-10-09T04:00:00Z'))
        expect(readLineupSnapshot(scope, scope.day)).toBeUndefined()
        expect(readLineupSnapshot({ ...scope, day: '2026-10-09' }, '2026-10-09')).toBeUndefined()
    })
    it('does not reuse invalidated access, even if the old domain entry remains on disk', () => {
        saveLineupSnapshot(scope, 1, value); discardLineupSnapshot(scope)
        expect(readPersistentCache(key)).not.toBeNull()
        expect(readLineupSnapshot(scope, scope.day)).toBeUndefined()
    })
    it.each([
        { project: 'https://foreign.example/auth/v1' }, { schema: 2 }, { savedAt: Date.parse('2026-10-08T23:00:00Z') },
        { context: { ...value.context, seasonId: 'wrong-season' } }, { starters: [{ slotType: 'PG', player: { ...player, eligiblePositions: null } }] },
    ])('rejects malformed or mismatched envelope %j', (change) => {
        saveLineupSnapshot(scope, 1, value)
        writePersistentCache(key, { ...readPersistentCache<object>(key), ...change })
        expect(readLineupSnapshot(scope, scope.day)).toBeUndefined()
    })
    it('caps the family at four entries and rejects oversized payloads', () => {
        for (let i = 0; i < 5; i++) {
            vi.advanceTimersByTime(1)
            const day = `2026-10-${String(8 + i).padStart(2, '0')}`
            saveLineupSnapshot(scope, 1, { ...value, date: day, days: [{ ...value.days[0], date: day }] })
        }
        expect(readLineupSnapshot(scope, '2026-10-08')).toBeUndefined()
        expect(readLineupSnapshot(scope, '2026-10-12')).toBeDefined()
        clearPersistentCaches()
        saveLineupSnapshot(scope, 1, { ...value, starters: [{ slotType: 'PG', player: { ...player, displayName: 'x'.repeat(256 * 1024) } }] })
        expect(readLineupSnapshot(scope, scope.day)).toBeUndefined()
    })
})
