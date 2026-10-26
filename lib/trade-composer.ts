import type {
    MultiTeamTradeItemPayload,
    MultiTeamTradeProposalPayload,
    Trade,
    TradeProposalPayload,
    TradeRosterPlan,
} from '@/lib/trades'
import { endOfETDayUTC } from '@/lib/shared/dates'
import type { LeagueStatus } from '@/types/database'
import { isMultiTeamTradeSubmittable, validateTradeFaabInput } from '@/lib/multi-team-trade-state'
import { MAX_TRADE_EXPIRATION_DAYS, MAX_TRADE_NOTES_BYTES, utf8ByteLength } from '@pancake/core'

type TradeComposerMode = 'propose' | 'edit' | 'counter'

type TradeComposerModeInput = {
    editTradeId?: string | null
    counterTradeId?: string | null
}

type TradeComposerModeState = {
    mode: TradeComposerMode
    editTradeId: string | null
    counterTradeId: string | null
    sourceTradeId: string | null
}

type TradeComposerPrefill = {
    selectedRecipientId: string | null
    notes: string
    expirationDays: string
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

type ComposerPayloadDraft = {
    payload: TradeProposalPayload
    hasOffer: boolean
    hasRequest: boolean
    faabError: string | null
    notesError: string | null
    expirationError: string | null
}

type SubmitComposerInput = {
    requestId?: string
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
            requestId?: string
            expiresAt?: string | null
            offerFaabAmount?: number
            requestFaabAmount?: number
            rosterPlan?: TradeProposalPayload['rosterPlan']
            estimateId?: string
        },
    ) => Promise<string>
    counterTrade: (tradeId: string, memberId: string, payload: TradeProposalPayload) => Promise<string>
    editTrade: (tradeId: string, memberId: string, payload: TradeProposalPayload) => Promise<string>
}

type SubmitMultiTeamComposerInput = {
    estimateId?: string
    requestId?: string
    nowMs?: number
    mode: TradeComposerMode
    editTradeId: string | null
    counterTradeId: string | null
    myMemberId: string
    leagueId: string
    rosterPlan?: TradeProposalPayload['rosterPlan']
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
        payload: MultiTeamTradeProposalPayload,
    ) => Promise<string>
    counterMultiTeamTrade: (
        tradeId: string,
        memberId: string,
        payload: MultiTeamTradeProposalPayload,
    ) => Promise<string>
    editMultiTeamTrade: (
        tradeId: string,
        memberId: string,
        payload: MultiTeamTradeProposalPayload,
    ) => Promise<string>
}

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_DATE_MS = 8_640_000_000_000_000
const EXPIRATION_ERROR = `Expiration must be between 1 and ${MAX_TRADE_EXPIRATION_DAYS} days.`
const NOTES_ERROR = `Notes must contain at most ${MAX_TRADE_NOTES_BYTES} UTF-8 bytes.`

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

export function prefillTradeComposerFromTrade(
    mode: TradeComposerMode,
    trade: Trade,
    nowMs = Date.now(),
): TradeComposerPrefill {
    const expiresAt = trade.expiresAt ? new Date(trade.expiresAt).getTime() : null
    const expirationDays = expiresAt
        ? Math.max(1, Math.ceil((expiresAt - nowMs) / DAY_MS))
        : ''

    return {
        selectedRecipientId: mode === 'counter' ? trade.proposerMemberId : trade.recipientMemberId,
        notes: mode === 'counter' ? '' : trade.notes ?? '',
        expirationDays: String(expirationDays),
    }
}

export function prefillTradeRosterPlan(trade: Trade, memberId: string): TradeRosterPlan {
    const incoming = trade.routedItems.filter(item => item.kind === 'player' && item.toMemberId === memberId)
    return {
        taxiPlayerIds: incoming.flatMap(item => item.kind === 'player' && item.toTaxi ? [item.playerId] : []),
        irPlayerIds: incoming.flatMap(item => item.kind === 'player' && item.toIR ? [item.playerId] : []),
        dropPlayerIds: [...(trade.participants.find(participant => participant.memberId === memberId)?.dropPlayerIds ?? [])],
    }
}

export function validateTradeExpirationDays(value: string): { days: number | null; error: string | null } {
    const trimmed = value.trim()
    if (trimmed === '') return { days: null, error: null }
    if (!/^\d+$/.test(trimmed)) return { days: null, error: EXPIRATION_ERROR }

    const days = Number(trimmed)
    if (
        !Number.isSafeInteger(days) ||
        days < 1 ||
        days > MAX_TRADE_EXPIRATION_DAYS
    ) {
        return { days: null, error: EXPIRATION_ERROR }
    }
    return { days, error: null }
}

export function validateTradeNotes(value: string): { error: string | null } {
    return { error: utf8ByteLength(value) > MAX_TRADE_NOTES_BYTES ? NOTES_ERROR : null }
}

function generatedExpirationMs(
    input: ComposerPayloadInput,
    nowMs: number,
): { expiresAtMs: number | null; error: string | null } {
    const expiration = validateTradeExpirationDays(input.expirationDaysInput)
    if (expiration.error || expiration.days == null) {
        return { expiresAtMs: null, error: expiration.error }
    }
    if (!Number.isFinite(nowMs)) return { expiresAtMs: null, error: EXPIRATION_ERROR }

    let expiresAtMs = nowMs + expiration.days * DAY_MS
    if (
        (input.leagueStatus === 'active' || input.leagueStatus === 'playoffs') &&
        input.tradeDeadline
    ) {
        const deadlineEndMs = Date.parse(endOfETDayUTC(input.tradeDeadline)) - 1
        if (Number.isFinite(deadlineEndMs) && expiresAtMs > deadlineEndMs) {
            expiresAtMs = deadlineEndMs
        }
    }

    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || Math.abs(expiresAtMs) > MAX_DATE_MS) {
        return { expiresAtMs: null, error: EXPIRATION_ERROR }
    }
    return { expiresAtMs, error: null }
}

export function buildTradeComposerPayload(input: ComposerPayloadInput, nowMs = Date.now()): ComposerPayloadDraft {
    const offerPlayerIds = Array.from(input.offerPlayerIds)
    const requestPlayerIds = Array.from(input.requestPlayerIds)
    const offerPickIds = Array.from(input.offerPickIds)
    const requestPickIds = Array.from(input.requestPickIds)
    const offerFaab = validateTradeFaabInput(input.offerFaabInput)
    const requestFaab = validateTradeFaabInput(input.requestFaabInput)
    const offerFaabAmount = offerFaab.amount
    const requestFaabAmount = requestFaab.amount
    const faabError = offerFaab.error ?? requestFaab.error
    const notesError = validateTradeNotes(input.notes).error
    const expiration = generatedExpirationMs(input, nowMs)

    return {
        payload: {
            offerPlayerIds,
            requestPlayerIds,
            offerPickIds,
            requestPickIds,
            notes: input.notes.trim() || undefined,
            expiresAt: expiration.expiresAtMs == null ? null : new Date(expiration.expiresAtMs).toISOString(),
            offerFaabAmount,
            requestFaabAmount,
        },
        hasOffer: offerPlayerIds.length > 0 || offerPickIds.length > 0 || offerFaabAmount > 0,
        hasRequest: requestPlayerIds.length > 0 || requestPickIds.length > 0 || requestFaabAmount > 0,
        faabError,
        notesError,
        expirationError: expiration.error,
    }
}

export function buildTwoTeamTradeComposerPayload(
    items: MultiTeamTradeItemPayload[],
    myMemberId: string,
    recipientMemberId: string,
    terms: Pick<ComposerPayloadInput, 'notes' | 'expirationDaysInput' | 'leagueStatus' | 'tradeDeadline'>,
    nowMs = Date.now(),
): ComposerPayloadDraft {
    const fromMe = items.filter((item) => item.fromMemberId === myMemberId && item.toMemberId === recipientMemberId)
    const fromRecipient = items.filter((item) => item.fromMemberId === recipientMemberId && item.toMemberId === myMemberId)
    return buildTradeComposerPayload({
        offerPlayerIds: fromMe.flatMap((item) => item.kind === 'player' ? [item.playerId] : []),
        requestPlayerIds: fromRecipient.flatMap((item) => item.kind === 'player' ? [item.playerId] : []),
        offerPickIds: fromMe.flatMap((item) => item.kind === 'pick' ? [item.pickId] : []),
        requestPickIds: fromRecipient.flatMap((item) => item.kind === 'pick' ? [item.pickId] : []),
        notes: terms.notes,
        offerFaabInput: String(fromMe.reduce((total, item) => total + (item.kind === 'faab' ? item.faabAmount : 0), 0)),
        requestFaabInput: String(fromRecipient.reduce((total, item) => total + (item.kind === 'faab' ? item.faabAmount : 0), 0)),
        expirationDaysInput: terms.expirationDaysInput,
        leagueStatus: terms.leagueStatus,
        tradeDeadline: terms.tradeDeadline,
    }, nowMs)
}

export async function submitTradeComposer(
    input: SubmitComposerInput,
    deps: SubmitComposerDeps,
): Promise<void> {
    const faabError = validateTradeFaabInput(String(input.payload.offerFaabAmount ?? 0)).error ??
        validateTradeFaabInput(String(input.payload.requestFaabAmount ?? 0)).error
    if (faabError) throw new Error(faabError)
    const notesError = validateTradeNotes(input.payload.notes ?? '').error
    if (notesError) throw new Error(notesError)

    if (input.mode === 'counter' && input.counterTradeId) {
        await deps.counterTrade(input.counterTradeId, input.myMemberId, { ...input.payload, requestId: input.requestId, recipientMemberId: input.selectedRecipientId })
        return
    }

    if (input.mode === 'edit' && input.editTradeId) {
        await deps.editTrade(input.editTradeId, input.myMemberId, { ...input.payload, requestId: input.requestId, recipientMemberId: input.selectedRecipientId })
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
            requestId: input.requestId,
            ...(input.payload.estimateId ? { estimateId: input.payload.estimateId } : {}),
            ...(input.payload.rosterPlan ? { rosterPlan: input.payload.rosterPlan } : {}),
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
    if (!isMultiTeamTradeSubmittable(input.participantMemberIds, input.items)) {
        throw new Error('Multi-team trades require exactly one valid asset per route and involvement from every participant.')
    }
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
    }, input.nowMs)
    if (draft.notesError) throw new Error(draft.notesError)
    if (draft.expirationError) throw new Error(draft.expirationError)

    const payload = {
        requestId: input.requestId,
        ...(input.estimateId ? { estimateId: input.estimateId } : {}),
        ...(input.rosterPlan ? { rosterPlan: input.rosterPlan } : {}),
        participantMemberIds: input.participantMemberIds,
        items: input.items,
        notes: draft.payload.notes,
        expiresAt: draft.payload.expiresAt,
    }

    if (input.mode === 'counter' && input.counterTradeId) {
        await deps.counterMultiTeamTrade(input.counterTradeId, input.myMemberId, payload)
        return
    }

    if (input.mode === 'edit' && input.editTradeId) {
        await deps.editMultiTeamTrade(input.editTradeId, input.myMemberId, payload)
        return
    }

    const seasonId = await deps.getCurrentSeasonId(input.leagueId)
    if (!seasonId) throw new Error('No active season found.')

    await deps.proposeMultiTeamTrade(input.myMemberId, input.leagueId, seasonId, payload)
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
