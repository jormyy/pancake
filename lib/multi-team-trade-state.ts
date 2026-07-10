import type { MultiTeamTradeItemPayload, Trade } from '@/lib/trades'

type AssetDestinations = Record<string, string | null>

type ParticipantTradeDraft = {
    defaultDestinationId: string
    playerDestinations: AssetDestinations
    pickDestinations: AssetDestinations
    faabInputs: Record<string, string>
}

export type MultiTeamTradeState = {
    participantOrder: string[]
    participants: Record<string, ParticipantTradeDraft>
}

export type MultiTeamTradeAction =
    | { type: 'toggle-participant'; memberId: string; actorMemberId: string; availableMemberIds: string[] }
    | { type: 'set-participants'; actorMemberId: string; participantIds: string[] }
    | { type: 'toggle-asset'; asset: 'player' | 'pick'; memberId: string; assetId: string }
    | { type: 'select-asset'; asset: 'player' | 'pick'; memberId: string; assetId: string }
    | { type: 'set-default-destination'; memberId: string; toMemberId: string }
    | { type: 'set-asset-destination'; asset: 'player' | 'pick'; memberId: string; assetId: string; toMemberId: string }
    | { type: 'set-faab'; memberId: string; toMemberId: string; value: string }
    | { type: 'prefill'; state: MultiTeamTradeState }
    | { type: 'reset'; actorMemberId: string }

const emptyParticipant = (memberId: string, participantIds: string[]): ParticipantTradeDraft => ({
    defaultDestinationId: defaultDestinationFor(memberId, participantIds),
    playerDestinations: {},
    pickDestinations: {},
    faabInputs: {},
})

export function createMultiTeamTradeState(actorMemberId: string): MultiTeamTradeState {
    const participantOrder = actorMemberId ? [actorMemberId] : []
    return {
        participantOrder,
        participants: actorMemberId ? { [actorMemberId]: emptyParticipant(actorMemberId, participantOrder) } : {},
    }
}

function defaultDestinationFor(memberId: string, participantIds: string[]): string {
    if (participantIds.length < 2) return ''
    const currentIndex = participantIds.indexOf(memberId)
    if (currentIndex < 0) return participantIds.find((id) => id !== memberId) ?? ''
    return participantIds[(currentIndex + 1) % participantIds.length] ?? ''
}

function cleanDestinations(
    destinations: AssetDestinations,
    memberId: string,
    participantIds: string[],
): AssetDestinations {
    return Object.fromEntries(Object.entries(destinations).map(([assetId, destinationId]) => [
        assetId,
        destinationId && destinationId !== memberId && participantIds.includes(destinationId)
            ? destinationId
            : null,
    ]))
}

function reconcileParticipants(state: MultiTeamTradeState, participantIds: string[]): MultiTeamTradeState {
    const participants: Record<string, ParticipantTradeDraft> = {}
    for (const memberId of participantIds) {
        const current = state.participants[memberId] ?? emptyParticipant(memberId, participantIds)
        const defaultDestinationId = current.defaultDestinationId !== memberId && participantIds.includes(current.defaultDestinationId)
            ? current.defaultDestinationId
            : defaultDestinationFor(memberId, participantIds)
        participants[memberId] = {
            ...current,
            defaultDestinationId,
            playerDestinations: cleanDestinations(current.playerDestinations, memberId, participantIds),
            pickDestinations: cleanDestinations(current.pickDestinations, memberId, participantIds),
            faabInputs: Object.fromEntries(Object.entries(current.faabInputs).filter(([destinationId]) =>
                destinationId !== memberId && participantIds.includes(destinationId))),
        }
    }
    return { ...state, participantOrder: participantIds, participants }
}

function updateParticipant(
    state: MultiTeamTradeState,
    memberId: string,
    update: (participant: ParticipantTradeDraft) => ParticipantTradeDraft,
): MultiTeamTradeState {
    const participant = state.participants[memberId]
    if (!participant) return state
    return {
        ...state,
        participants: { ...state.participants, [memberId]: update(participant) },
    }
}

export function multiTeamTradeReducer(
    state: MultiTeamTradeState,
    action: MultiTeamTradeAction,
): MultiTeamTradeState {
    switch (action.type) {
        case 'toggle-participant': {
            const selectedParticipantIds = new Set(state.participantOrder.filter((memberId) => memberId !== action.actorMemberId))
            if (selectedParticipantIds.has(action.memberId)) selectedParticipantIds.delete(action.memberId)
            else selectedParticipantIds.add(action.memberId)
            const participantOrder = [
                action.actorMemberId,
                ...action.availableMemberIds.filter((memberId) => selectedParticipantIds.has(memberId)),
            ].filter(Boolean)
            return reconcileParticipants(state, participantOrder)
        }
        case 'set-participants': {
            const participantOrder = [
                action.actorMemberId,
                ...action.participantIds.filter((memberId) => memberId !== action.actorMemberId),
            ].filter(Boolean)
            return reconcileParticipants(state, participantOrder)
        }
        case 'toggle-asset': {
            return updateParticipant(state, action.memberId, (participant) => {
                const key = action.asset === 'player' ? 'playerDestinations' : 'pickDestinations'
                const destinations = { ...participant[key] }
                if (action.assetId in destinations) delete destinations[action.assetId]
                else destinations[action.assetId] = null
                return { ...participant, [key]: destinations }
            })
        }
        case 'select-asset': {
            return updateParticipant(state, action.memberId, (participant) => {
                const key = action.asset === 'player' ? 'playerDestinations' : 'pickDestinations'
                if (action.assetId in participant[key]) return participant
                return { ...participant, [key]: { ...participant[key], [action.assetId]: null } }
            })
        }
        case 'set-default-destination': {
            if (action.memberId === action.toMemberId || !state.participantOrder.includes(action.toMemberId)) return state
            return updateParticipant(state, action.memberId, (participant) => ({
                ...participant,
                defaultDestinationId: action.toMemberId,
            }))
        }
        case 'set-asset-destination': {
            if (action.memberId === action.toMemberId || !state.participantOrder.includes(action.toMemberId)) return state
            return updateParticipant(state, action.memberId, (participant) => {
                const key = action.asset === 'player' ? 'playerDestinations' : 'pickDestinations'
                if (!(action.assetId in participant[key])) return participant
                return {
                    ...participant,
                    [key]: {
                        ...participant[key],
                        [action.assetId]: action.toMemberId === participant.defaultDestinationId ? null : action.toMemberId,
                    },
                }
            })
        }
        case 'set-faab':
            if (!/^\d*$/.test(action.value) || action.memberId === action.toMemberId ||
                !state.participantOrder.includes(action.toMemberId)) return state
            return updateParticipant(state, action.memberId, (participant) => ({
                ...participant,
                faabInputs: { ...participant.faabInputs, [action.toMemberId]: action.value },
            }))
        case 'prefill':
            return action.state
        case 'reset':
            return createMultiTeamTradeState(action.actorMemberId)
    }
}

export function resolvedDestination(
    state: MultiTeamTradeState,
    memberId: string,
    asset: 'player' | 'pick',
    assetId: string,
): string {
    const participant = state.participants[memberId]
    if (!participant) return ''
    const destinations = asset === 'player' ? participant.playerDestinations : participant.pickDestinations
    return destinations[assetId] ?? participant.defaultDestinationId
}

export function buildMultiTeamTradeItems(
    state: MultiTeamTradeState,
    faabEnabled: boolean,
): MultiTeamTradeItemPayload[] {
    return state.participantOrder.flatMap((memberId) => {
        const participant = state.participants[memberId]
        if (!participant?.defaultDestinationId) return []
        const players = Object.keys(participant.playerDestinations).map((playerId) => ({
            kind: 'player' as const,
            fromMemberId: memberId,
            toMemberId: resolvedDestination(state, memberId, 'player', playerId),
            playerId,
        }))
        const picks = Object.keys(participant.pickDestinations).map((pickId) => ({
            kind: 'pick' as const,
            fromMemberId: memberId,
            toMemberId: resolvedDestination(state, memberId, 'pick', pickId),
            pickId,
        }))
        const faab = faabEnabled ? Object.entries(participant.faabInputs).flatMap(([toMemberId, value]) => {
            const faabAmount = parseInt(value || '0', 10) || 0
            return faabAmount > 0 ? [{
                kind: 'faab' as const,
                fromMemberId: memberId,
                toMemberId,
                faabAmount,
            }] : []
        }) : []
        return [...players, ...picks, ...faab]
    })
}

function isMultiTeamTradeItemPayload(value: unknown): value is MultiTeamTradeItemPayload {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const item = value as Record<string, unknown>
    if (typeof item.fromMemberId !== 'string' || item.fromMemberId.length === 0 ||
        typeof item.toMemberId !== 'string' || item.toMemberId.length === 0) return false
    if (item.kind === 'player') {
        return typeof item.playerId === 'string' && item.playerId.length > 0 &&
            item.pickId === undefined && item.faabAmount === undefined
    }
    if (item.kind === 'pick') {
        return typeof item.pickId === 'string' && item.pickId.length > 0 &&
            item.playerId === undefined && item.faabAmount === undefined
    }
    if (item.kind === 'faab') {
        return Number.isInteger(item.faabAmount) && (item.faabAmount as number) > 0 &&
            item.playerId === undefined && item.pickId === undefined
    }
    return false
}

export function isMultiTeamTradeSubmittable(
    participantIds: readonly string[],
    items: readonly unknown[],
): boolean {
    const participants = new Set(participantIds.filter(Boolean))
    if (participants.size < 3 || items.length === 0) return false
    const involved = new Set<string>()
    for (const item of items) {
        if (!isMultiTeamTradeItemPayload(item)) return false
        if (!participants.has(item.fromMemberId) || !participants.has(item.toMemberId) ||
            item.fromMemberId === item.toMemberId) return false
        involved.add(item.fromMemberId)
        involved.add(item.toMemberId)
    }
    return [...participants].every((memberId) => involved.has(memberId))
}

export function multiTeamTradeStateFromTrade(trade: Trade, actorMemberId: string): MultiTeamTradeState {
    const tradeParticipantIds = trade.participants.length > 0
        ? trade.participants.map((participant) => participant.memberId)
        : [trade.proposerMemberId, trade.recipientMemberId].filter(Boolean)
    const participantOrder = [actorMemberId, ...tradeParticipantIds.filter((memberId) => memberId !== actorMemberId)]
    const state: MultiTeamTradeState = {
        participantOrder,
        participants: Object.fromEntries(participantOrder.map((memberId) => [memberId, {
            ...emptyParticipant(memberId, participantOrder),
            defaultDestinationId: '',
        }])),
    }

    for (const item of trade.routedItems) {
        if (!item.fromMemberId || !item.toMemberId || item.fromMemberId === item.toMemberId) continue
        const participant = state.participants[item.fromMemberId]
        if (!participant) continue
        if (!participant.defaultDestinationId) participant.defaultDestinationId = item.toMemberId
        if (item.kind === 'player') participant.playerDestinations[item.playerId] = item.toMemberId
        else if (item.kind === 'pick') participant.pickDestinations[item.pickId] = item.toMemberId
        else {
            participant.faabInputs[item.toMemberId] = String(
                (parseInt(participant.faabInputs[item.toMemberId] ?? '0', 10) || 0) + item.amount,
            )
        }
    }

    for (const [memberId, participant] of Object.entries(state.participants)) {
        participant.defaultDestinationId ||= defaultDestinationFor(memberId, participantOrder)
        for (const destinations of [participant.playerDestinations, participant.pickDestinations]) {
            for (const [assetId, destinationId] of Object.entries(destinations)) {
                if (destinationId === participant.defaultDestinationId) destinations[assetId] = null
            }
        }
    }
    return state
}
