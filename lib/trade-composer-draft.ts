import { isMultiTeamTradeItemPayload } from '@/lib/multi-team-trade-state'
import { onSessionCachesCleared } from '@/lib/session-cache-registry'
import type { MultiTeamTradeItemPayload, TradeRosterPlan } from '@/lib/trades'

// An unsent trade kept in this tab's session storage, so a page reload (an app update reloads the
// page) brings the editor back. The editor clears it on send and when it closes, so in-app
// navigation never restores it; only a reload, which skips React cleanup, finds it again.
type TradeComposerDraft = {
    ownerIdentity: string
    seasonId?: string
    mode: string
    sourceTradeId: string | null
    multiTeamMode: boolean
    selectedRecipientId: string | null
    participantIds: string[]
    items: MultiTeamTradeItemPayload[]
    notes: string
    expirationDays: string
    rosterPlan: TradeRosterPlan
}

const DRAFT_KEY = 'pancake:trade-composer-draft'

function draftStorage(): Storage | null {
    try {
        return globalThis.sessionStorage ?? null
    } catch {
        return null
    }
}

function parseDraft(raw: string): TradeComposerDraft | null {
    try {
        const draft = JSON.parse(raw) as Record<string, unknown>
        const optionalId = (value: unknown) => value === null || typeof value === 'string'
        if (typeof draft.ownerIdentity !== 'string' || (draft.seasonId !== undefined && typeof draft.seasonId !== 'string') || typeof draft.mode !== 'string' ||
            !optionalId(draft.sourceTradeId) || typeof draft.multiTeamMode !== 'boolean' ||
            !optionalId(draft.selectedRecipientId) || typeof draft.notes !== 'string' ||
            typeof draft.expirationDays !== 'string' ||
            !Array.isArray(draft.participantIds) || !draft.participantIds.every((id) => typeof id === 'string') ||
            !Array.isArray(draft.items) || !draft.items.every(isMultiTeamTradeItemPayload)) return null
        const plan = draft.rosterPlan ?? { taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [] }
        if (!plan || typeof plan !== 'object' || !['taxiPlayerIds', 'irPlayerIds', 'dropPlayerIds'].every(key => {
            const ids = (plan as Record<string, unknown>)[key]
            return Array.isArray(ids) && ids.every(id => typeof id === 'string')
        })) return null
        const moves = (plan as Record<string, unknown>).rosterMoves
        if (moves !== undefined && (!Array.isArray(moves) || !moves.every(move => move && typeof move === 'object'
            && typeof move.playerId === 'string' && (move.destination === 'active' || move.destination === 'ir')))) return null
        return { ...draft, rosterPlan: plan } as TradeComposerDraft
    } catch {
        return null
    }
}

/** Saves the editor exactly as the screen serialized it. */
export function saveTradeComposerDraft(serialized: string): boolean {
    try {
        const storage = draftStorage()
        if (!storage) return false
        storage.setItem(DRAFT_KEY, serialized)
        return true
    } catch {
        // Best effort only; the editor still holds the trade.
        return false
    }
}

export function clearTradeComposerDraft(): void {
    try {
        draftStorage()?.removeItem(DRAFT_KEY)
    } catch {
        // Best effort only.
    }
}

/** The saved draft for exactly this editor. A draft for another owner, mode or trade is dropped. */
export function readTradeComposerDraft(
    ownerIdentity: string,
    mode: string,
    sourceTradeId: string | null,
    seasonId?: string,
): TradeComposerDraft | null {
    let raw: string | null | undefined
    try {
        raw = draftStorage()?.getItem(DRAFT_KEY)
    } catch {
        return null
    }
    if (!raw) return null
    const draft = parseDraft(raw)
    if (draft?.ownerIdentity === ownerIdentity && draft.mode === mode && draft.sourceTradeId === sourceTradeId &&
        (!seasonId || draft.seasonId === seasonId)) return draft
    clearTradeComposerDraft()
    return null
}

// Sign-out and account switches clear the session caches; an unsent trade goes with them.
onSessionCachesCleared(clearTradeComposerDraft)
