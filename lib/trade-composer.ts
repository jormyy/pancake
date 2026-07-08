import type { MultiTeamTradeItemPayload, Trade, TradeItem, TradeProposalPayload } from '@/lib/trades'
import { endOfETDayUTC } from '@/lib/shared/dates'
import type { LeagueStatus } from '@/types/database'

export type TradeComposerMode = 'propose' | 'edit' | 'counter'

type TradeComposerModeInput = {
    editTradeId?: string | null
    counterTradeId?: string | null
}

export type TradeComposerModeState = {
    mode: TradeComposerMode
    editTradeId: string | null
    counterTradeId: string | null
    sourceTradeId: string | null
}

export type TradeComposerPrefill = {
    selectedRecipientId: string | null
    offerPlayerIds: string[]
    requestPlayerIds: string[]
    offerPickIds: string[]
    requestPickIds: string[]
    notes: string
    offerFaabInput: string
    requestFaabInput: string
    expirationDays: string
}

export type RouteTradePrefill = {
    key: string
    requestPlayerIds: string[]
    requestPickIds: string[]
}

type ComposerPayloadInput = {
    offerPlayerIds: Iterable<string>
    requestPlayerIds: Iterable<string>
    offerPickIds: Iterable<string>
    requestPickIds: Iterable<string>
    notes: string
    offerFaabInput: string
    requestFaabInput: string
    expirationDaysInput: string
    leagueStatus?: LeagueStatus | null
    tradeDeadline?: string | null
}

export type ComposerPayloadDraft = {
    payload: TradeProposalPayload
    hasOffer: boolean
    hasRequest: boolean
}

type SubmitComposerInput = {
    mode: TradeComposerMode
    editTradeId: string | null
    counterTradeId: string | null
    myMemberId: string
    leagueId: string
    selectedRecipientId: string
    payload: TradeProposalPayload
}

type SubmitComposerDeps = {
    getCurrentSeasonId: (leagueId: string) => Promise<string | null>
    proposeTrade: (
        memberId: string,
        leagueId: string,
        seasonId: string,
        recipientMemberId: string,
        offerPlayerIds: string[],
        requestPlayerIds: string[],
        offerPickIds: string[],
        requestPickIds: string[],
        notes?: string,
        options?: {
            expiresAt?: string | null
            offerFaabAmount?: number
            requestFaabAmount?: number
        },
    ) => Promise<string>
    counterTrade: (tradeId: string, memberId: string, payload: TradeProposalPayload) => Promise<string>
    editTrade: (tradeId: string, memberId: string, payload: TradeProposalPayload) => Promise<string>
}

type SubmitMultiTeamComposerInput = {
    myMemberId: string
    leagueId: string
    participantMemberIds: string[]
    items: MultiTeamTradeItemPayload[]
    notes: string
    expirationDays: string
    leagueStatus?: LeagueStatus | null
    tradeDeadline?: string | null
}

type SubmitMultiTeamComposerDeps = {
    getCurrentSeasonId: (leagueId: string) => Promise<string | null>
    proposeMultiTeamTrade: (
        memberId: string,
        leagueId: string,
        seasonId: string,
        payload: {
            participantMemberIds: string[]
            items: MultiTeamTradeItemPayload[]
            notes?: string | null
            expiresAt?: string | null
        },
    ) => Promise<string>
}

const DEFAULT_EXPIRATION_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000

export function getTradeComposerMode(input: TradeComposerModeInput): TradeComposerModeState {
    const editTradeId = input.editTradeId ?? null
    const counterTradeId = input.counterTradeId ?? null
    const mode: TradeComposerMode = editTradeId ? 'edit' : counterTradeId ? 'counter' : 'propose'

    return {
        mode,
        editTradeId,
        counterTradeId,
        sourceTradeId: editTradeId ?? counterTradeId,
    }
}

function tradeItemIds(items: TradeItem[], kind: 'player' | 'pick'): string[] {
    return items.flatMap((item) => {
        if (kind === 'player' && item.kind === 'player') return [item.playerId]
        if (kind === 'pick' && item.kind === 'pick') return [item.pickId]
        return []
    })
}

export function prefillTradeComposerFromTrade(
    mode: TradeComposerMode,
    trade: Trade,
    nowMs = Date.now(),
): TradeComposerPrefill {
    const mySide = mode === 'counter' ? trade.recipientGives : trade.proposerGives
    const theirSide = mode === 'counter' ? trade.proposerGives : trade.recipientGives
    const expiresAt = trade.expiresAt ? new Date(trade.expiresAt).getTime() : null
    const expirationDays = expiresAt
        ? Math.max(1, Math.ceil((expiresAt - nowMs) / DAY_MS))
        : DEFAULT_EXPIRATION_DAYS

    return {
        selectedRecipientId: mode === 'counter' ? trade.proposerMemberId : trade.recipientMemberId,
        offerPlayerIds: tradeItemIds(mySide, 'player'),
        offerPickIds: tradeItemIds(mySide, 'pick'),
        requestPlayerIds: tradeItemIds(theirSide, 'player'),
        requestPickIds: tradeItemIds(theirSide, 'pick'),
        notes: trade.notes ?? '',
        offerFaabInput: String(mode === 'counter' ? trade.recipientFaabAmount : trade.proposerFaabAmount),
        requestFaabInput: String(mode === 'counter' ? trade.proposerFaabAmount : trade.recipientFaabAmount),
        expirationDays: String(expirationDays),
    }
}

export function prefillTradeComposerFromRoute(
    selectedRecipientId: string | null,
    params: { requestPlayerId?: string | null; requestPickId?: string | null },
): RouteTradePrefill {
    const requestPlayerId = params.requestPlayerId ?? null
    const requestPickId = params.requestPickId ?? null

    return {
        key: `params:${selectedRecipientId ?? ''}:${requestPlayerId ?? ''}:${requestPickId ?? ''}`,
        requestPlayerIds: requestPlayerId ? [requestPlayerId] : [],
        requestPickIds: requestPickId ? [requestPickId] : [],
    }
}

function parseNonNegativeInt(value: string, fallback = 0): number {
    const parsed = parseInt(value || String(fallback), 10)
    return Math.max(0, Number.isFinite(parsed) ? parsed : fallback)
}

function parseOptionalPositiveInt(value: string): number | null {
    if (value.trim() === '') return null
    const parsed = parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function generatedExpirationMs(input: ComposerPayloadInput, nowMs: number): number | null {
    const expirationDays = parseOptionalPositiveInt(input.expirationDaysInput)
    if (expirationDays == null) return null

    let expiresAtMs = nowMs + expirationDays * DAY_MS
    if (
        (input.leagueStatus === 'active' || input.leagueStatus === 'playoffs') &&
        input.tradeDeadline
    ) {
        const deadlineEndMs = Date.parse(endOfETDayUTC(input.tradeDeadline)) - 1
        if (Number.isFinite(deadlineEndMs) && expiresAtMs > deadlineEndMs) {
            expiresAtMs = deadlineEndMs
        }
    }

    return expiresAtMs > nowMs ? expiresAtMs : null
}

export function buildTradeComposerPayload(input: ComposerPayloadInput, nowMs = Date.now()): ComposerPayloadDraft {
    const offerPlayerIds = Array.from(input.offerPlayerIds)
    const requestPlayerIds = Array.from(input.requestPlayerIds)
    const offerPickIds = Array.from(input.offerPickIds)
    const requestPickIds = Array.from(input.requestPickIds)
    const offerFaabAmount = parseNonNegativeInt(input.offerFaabInput)
    const requestFaabAmount = parseNonNegativeInt(input.requestFaabInput)
    const expiresAtMs = generatedExpirationMs(input, nowMs)

    return {
        payload: {
            offerPlayerIds,
            requestPlayerIds,
            offerPickIds,
            requestPickIds,
            notes: input.notes.trim() || undefined,
            expiresAt: expiresAtMs == null ? null : new Date(expiresAtMs).toISOString(),
            offerFaabAmount,
            requestFaabAmount,
        },
        hasOffer: offerPlayerIds.length > 0 || offerPickIds.length > 0 || offerFaabAmount > 0,
        hasRequest: requestPlayerIds.length > 0 || requestPickIds.length > 0 || requestFaabAmount > 0,
    }
}

export async function submitTradeComposer(
    input: SubmitComposerInput,
    deps: SubmitComposerDeps,
): Promise<void> {
    if (input.mode === 'counter' && input.counterTradeId) {
        await deps.counterTrade(input.counterTradeId, input.myMemberId, input.payload)
        return
    }

    if (input.mode === 'edit' && input.editTradeId) {
        await deps.editTrade(input.editTradeId, input.myMemberId, input.payload)
        return
    }

    const seasonId = await deps.getCurrentSeasonId(input.leagueId)
    if (!seasonId) throw new Error('No active season found.')

    await deps.proposeTrade(
        input.myMemberId,
        input.leagueId,
        seasonId,
        input.selectedRecipientId,
        input.payload.offerPlayerIds,
        input.payload.requestPlayerIds,
        input.payload.offerPickIds,
        input.payload.requestPickIds,
        input.payload.notes ?? undefined,
        {
            expiresAt: input.payload.expiresAt,
            offerFaabAmount: input.payload.offerFaabAmount,
            requestFaabAmount: input.payload.requestFaabAmount,
        },
    )
}

export async function submitMultiTeamTradeComposer(
    input: SubmitMultiTeamComposerInput,
    deps: SubmitMultiTeamComposerDeps,
): Promise<void> {
    const draft = buildTradeComposerPayload({
        offerPlayerIds: [],
        requestPlayerIds: [],
        offerPickIds: [],
        requestPickIds: [],
        notes: input.notes,
        offerFaabInput: '0',
        requestFaabInput: '0',
        expirationDaysInput: input.expirationDays,
        leagueStatus: input.leagueStatus,
        tradeDeadline: input.tradeDeadline,
    })
    const seasonId = await deps.getCurrentSeasonId(input.leagueId)
    if (!seasonId) throw new Error('No active season found.')

    await deps.proposeMultiTeamTrade(input.myMemberId, input.leagueId, seasonId, {
        participantMemberIds: input.participantMemberIds,
        items: input.items,
        notes: input.notes.trim() || undefined,
        expiresAt: draft.payload.expiresAt,
    })
}

export function tradeComposerTitle(mode: TradeComposerMode): string {
    if (mode === 'counter') return 'Counter Trade'
    if (mode === 'edit') return 'Edit Trade'
    return 'Propose Trade'
}

export function tradeComposerSuccessCopy(mode: TradeComposerMode): { title: string; message: string } {
    if (mode === 'counter') return { title: 'Counter Sent', message: 'Your counter offer has been sent.' }
    if (mode === 'edit') return { title: 'Trade Updated', message: 'Your edited offer has been sent.' }
    return { title: 'Trade Proposed', message: 'Your trade offer has been sent.' }
}
