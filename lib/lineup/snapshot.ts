import { readPersistentCache, removePersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { readStoredAuthState } from '@/lib/supabase'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import { todayET } from '@/lib/shared/dates'
import type { LineupContext, LineupPlayer, LineupSlot, WeekDay } from './read'

export type LineupSnapshotScope = { ownerId: string; memberId: string; leagueId: string; day: string }
export type LineupSnapshot = {
    schema: 1
    scope: LineupSnapshotScope
    project: string
    savedAt: number
    context: LineupContext
    date: string
    days: WeekDay[]
    starters: LineupSlot[]
    bench: LineupPlayer[]
    optimizerEnabled: boolean
}
const MAX_BYTES = 256 * 1024
const MAX_AGE = 24 * 60 * 60 * 1000

function projectForOwner(ownerId: string): string | null {
    // The auth layer admits only its own project's structurally valid, unexpired session.
    // Store the public issuer, never tokens, and recheck admission on every disk read/write.
    const { session } = readStoredAuthState()
    if (session?.user.id !== ownerId || sessionOwner() !== ownerId) return null
    const payload = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))).iss as string
}
function scopeKey(scope: LineupSnapshotScope, project: string) {
    return `pancake:lineup-screen:v1:${encodeURIComponent(project)}:${scope.ownerId}:${scope.leagueId}:${scope.memberId}:${scope.day}`
}
function sameScope(a: LineupSnapshotScope | undefined, b: LineupSnapshotScope) {
    return a?.ownerId === b.ownerId && a.memberId === b.memberId && a.leagueId === b.leagueId && a.day === b.day
}
function validPlayer(p: LineupPlayer | null): boolean {
    return p === null || Boolean(p && typeof p.playerId === 'string' && typeof p.rosterPlayerId === 'string'
        && typeof p.displayName === 'string' && Array.isArray(p.eligiblePositions)
        && p.eligiblePositions.every((v) => typeof v === 'string'))
}
function validContext(c: LineupContext | undefined, day: string): c is LineupContext {
    return Boolean(c && typeof c.seasonId === 'string' && c.seasonId
        && Number.isInteger(c.seasonYear) && Number.isInteger(c.weekNumber) && c.weekNumber > 0 && c.today === day)
}

export function readLineupSnapshot(scope: LineupSnapshotScope, date: string, context?: LineupContext): LineupSnapshot | undefined {
    const project = projectForOwner(scope.ownerId)
    if (!project || scope.day !== todayET()) return undefined
    const key = scopeKey(scope, project)
    const savedContext = readPersistentCache<LineupContext>(`${key}:context`)
    if (!validContext(savedContext ?? undefined, scope.day)) return undefined
    if (context && (context.seasonId !== savedContext!.seasonId || context.weekNumber !== savedContext!.weekNumber
        || context.seasonYear !== savedContext!.seasonYear)) return undefined
    const saved = readPersistentCache<LineupSnapshot>(`${key}:${savedContext!.seasonId}:${date}`)
    if (!saved || saved.schema !== 1 || saved.project !== project || !sameScope(saved.scope, scope)
        || !Number.isFinite(saved.savedAt) || saved.savedAt > Date.now() || Date.now() - saved.savedAt > MAX_AGE
        || !validContext(saved.context, scope.day) || saved.context.seasonId !== savedContext!.seasonId
        || saved.context.weekNumber !== savedContext!.weekNumber || saved.context.seasonYear !== savedContext!.seasonYear
        || saved.date !== date || !Array.isArray(saved.days) || saved.days.length > 7
        || !saved.days.some((d) => d.date === date) || saved.days.some((d) => !d || typeof d.date !== 'string'
            || !Array.isArray(d.playingTeams) || d.playingTeams.some((t) => typeof t !== 'string'))
        || !Array.isArray(saved.starters) || saved.starters.length > 64
        || saved.starters.some((s) => !s || typeof s.slotType !== 'string' || !validPlayer(s.player))
        || !Array.isArray(saved.bench) || saved.bench.length > 128 || saved.bench.some((p) => !p || !validPlayer(p))
        || typeof saved.optimizerEnabled !== 'boolean') return undefined
    return saved
}

export function saveLineupSnapshot(
    scope: LineupSnapshotScope,
    generation: number,
    value: Omit<LineupSnapshot, 'scope' | 'project' | 'savedAt' | 'schema'>,
): void {
    const project = projectForOwner(scope.ownerId)
    if (!project || sessionOwner() !== scope.ownerId || sessionGeneration() !== generation
        || scope.day !== todayET() || value.context.today !== scope.day) return
    const snapshot: LineupSnapshot = { schema: 1, scope, project, savedAt: Date.now(), ...value }
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_BYTES) return
    const key = scopeKey(scope, project)
    writePersistentCache(`${key}:${value.context.seasonId}:${value.date}`, snapshot)
    writePersistentCache(`${key}:context`, value.context)
}

export function discardLineupSnapshot(scope: LineupSnapshotScope): void {
    const project = projectForOwner(scope.ownerId)
    if (project) removePersistentCache(`${scopeKey(scope, project)}:context`)
}
