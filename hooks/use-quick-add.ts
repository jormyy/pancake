import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { PlayerRow } from '@/lib/players'
import {
    dropAndAddFreeAgent,
    RosterPlayer,
} from '@/lib/roster'
import { addFreeAgentOrRequestDrop, loadRosterAddGate, resolveRosterAddIRConflict } from '@/lib/roster-add-flow'
import { useAddLimitGate } from '@/hooks/use-add-limit-gate'
import { reportPickupError } from '@/lib/pickup'
import { showAlert, showSuccess } from '@/lib/alert'
import type { MemberTransactionState } from '@/lib/league'

type IRModalState = {
    ineligible: RosterPlayer[]
    roster: RosterPlayer[]
    pendingPlayer: PlayerRow
} | null

export type QuickAddOptions = {
    memberId: string | undefined
    leagueId: string | null
    refreshOwned: () => void
    refreshTransactionState?: () => void
    transactionState?: MemberTransactionState | null
    /** Opens the claim flow when the server says the player is still on waivers. */
    onClaimInstead?: (player: PlayerRow) => void
}

export function useQuickAdd({
    memberId,
    leagueId,
    refreshOwned,
    refreshTransactionState,
    transactionState,
    onClaimInstead,
}: QuickAddOptions) {
    const [adding, setAdding] = useState<string | null>(null)
    const [dropPickerPlayer, setDropPickerPlayer] = useState<PlayerRow | null>(null)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [dropping, setDropping] = useState<string | null>(null)
    const [irModal, setIrModal] = useState<IRModalState>(null)
    const ownerIdentity = memberId && leagueId ? `${memberId}:${leagueId}` : null
    const renderedOwnerRef = useRef(ownerIdentity)
    const activeOwnerRef = useRef(ownerIdentity)
    const generationRef = useRef(0)
    const [stateOwnerIdentity, setStateOwnerIdentity] = useState(ownerIdentity)
    activeOwnerRef.current = ownerIdentity
    if (renderedOwnerRef.current !== ownerIdentity) {
        renderedOwnerRef.current = ownerIdentity
        generationRef.current += 1
    }
    const ownsState = stateOwnerIdentity === ownerIdentity
    const isCurrent = useCallback((generation: number, identity: string | null) =>
        generationRef.current === generation && activeOwnerRef.current === identity, [])
    const { addBlockedReason, explainBlock } = useAddLimitGate({ transactionState, refresh: refreshTransactionState })
    const report = useCallback((error: unknown, player?: PlayerRow) => reportPickupError(error, {
        refresh: refreshTransactionState,
        onLimitReached: () => setDropPickerPlayer(null),
        claim: onClaimInstead && player ? () => onClaimInstead(player) : undefined,
    }), [refreshTransactionState, onClaimInstead])

    useEffect(() => {
        generationRef.current += 1
        setStateOwnerIdentity(ownerIdentity)
        setAdding(null)
        setDropPickerPlayer(null)
        setMyRoster([])
        setDropping(null)
        setIrModal(null)
    }, [ownerIdentity])

    // Resolves to the roster when it has no ineligible IR players; otherwise
    // opens the IR modal, which continues the add once IR is clear.
    const checkIR = useCallback(
        async (player: PlayerRow, lid: string, excludeRosterId?: string): Promise<RosterPlayer[] | null> => {
            if (!memberId) return null
            const generation = generationRef.current
            const identity = ownerIdentity
            const { roster, ineligible } = await loadRosterAddGate(memberId, lid, excludeRosterId)
            if (!isCurrent(generation, identity)) return null
            if (ineligible.length > 0) {
                setIrModal({ ineligible, roster, pendingPlayer: player })
                return null
            }
            return roster
        },
        [memberId, ownerIdentity, isCurrent]
    )

    // The server decides between an add and a full roster; a full roster opens
    // the drop picker with the roster already in hand.
    const addFreeAgent = useCallback(async (player: PlayerRow, lid: string, roster: RosterPlayer[]) => {
        if (!memberId) return
        const generation = generationRef.current
        const identity = ownerIdentity
        setAdding(player.id)
        try {
            const result = await addFreeAgentOrRequestDrop(memberId, lid, player.id, roster)
            if (!isCurrent(generation, identity)) return
            if (result.status === 'roster_full') {
                setMyRoster(result.activeRoster)
                setDropPickerPlayer(player)
                return
            }
            showSuccess('Added', `${player.display_name} added to your roster.`)
            refreshTransactionState?.()
        } catch (e) {
            if (isCurrent(generation, identity)) report(e, player)
        } finally {
            if (isCurrent(generation, identity)) {
                setAdding(null)
                refreshOwned()
            }
        }
    }, [memberId, ownerIdentity, refreshOwned, refreshTransactionState, isCurrent, report])

    const continueAfterIRResolution = useCallback(async (lid: string, roster: RosterPlayer[], remaining: RosterPlayer[]) => {
        if (remaining.length > 0) {
            setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
        } else {
            const pending = irModal!.pendingPlayer
            setIrModal(null)
            if (explainBlock()) return
            await addFreeAgent(pending, lid, roster)
        }
    }, [irModal, addFreeAgent, explainBlock])

    const handleAdd = useCallback(async (player: PlayerRow) => {
        if (!memberId || !leagueId) return
        if (explainBlock()) return
        const roster = await checkIR(player, leagueId)
        if (roster) await addFreeAgent(player, leagueId, roster)
    }, [memberId, leagueId, checkIR, addFreeAgent, explainBlock])

    const handleDropAndAdd = useCallback(async (rosterPlayer: RosterPlayer) => {
        if (!memberId || !dropPickerPlayer || !leagueId) return
        if (explainBlock()) {
            setDropPickerPlayer(null)
            return
        }
        const generation = generationRef.current
        const identity = ownerIdentity

        if (!await checkIR(dropPickerPlayer, leagueId, rosterPlayer.id)) return
        if (!isCurrent(generation, identity)) return

        setDropping(rosterPlayer.id)
        try {
            await dropAndAddFreeAgent(rosterPlayer.id, memberId, leagueId, dropPickerPlayer.id)
            if (!isCurrent(generation, identity)) return
            setDropPickerPlayer(null)
            refreshTransactionState?.()
        } catch (e) {
            if (isCurrent(generation, identity)) report(e, dropPickerPlayer)
        } finally {
            if (isCurrent(generation, identity)) {
                setDropping(null)
                refreshOwned()
            }
        }
    }, [memberId, leagueId, ownerIdentity, dropPickerPlayer, checkIR, refreshOwned, refreshTransactionState, isCurrent, explainBlock, report])

    const handleIRActivate = useCallback(async (rp: RosterPlayer) => {
        if (!memberId || !leagueId) return
        const generation = generationRef.current
        const identity = ownerIdentity
        const result = await resolveRosterAddIRConflict({ memberId, leagueId, activatePlayer: rp })
        if (!isCurrent(generation, identity)) return
        if (result.status === 'locked') {
            showAlert('Roster locked', result.message)
        } else {
            await continueAfterIRResolution(leagueId, result.roster, result.remaining)
        }
    }, [memberId, leagueId, ownerIdentity, continueAfterIRResolution, isCurrent])

    const handleDropAndIRActivate = useCallback(async (toDrop: RosterPlayer, activatePlayer: RosterPlayer) => {
        if (!memberId || !leagueId) return
        const generation = generationRef.current
        const identity = ownerIdentity
        const result = await resolveRosterAddIRConflict({ memberId, leagueId, activatePlayer, dropPlayer: toDrop })
        if (!isCurrent(generation, identity)) return
        if (result.status === 'locked') {
            showAlert('Roster locked', result.message)
        } else {
            await continueAfterIRResolution(leagueId, result.roster, result.remaining)
        }
    }, [memberId, leagueId, ownerIdentity, continueAfterIRResolution, isCurrent])

    return useMemo(() => ({
        adding: ownsState ? adding : null,
        dropPickerPlayer: ownsState ? dropPickerPlayer : null, setDropPickerPlayer,
        myRoster: ownsState ? myRoster : [],
        dropping: ownsState ? dropping : null,
        irModal: ownsState ? irModal : null, setIrModal,
        addBlockedReason,
        handleAdd,
        handleDropAndAdd,
        handleIRActivate,
        handleDropAndIRActivate,
    }), [
        ownsState, adding, dropPickerPlayer, myRoster, dropping, irModal, addBlockedReason,
        handleAdd, handleDropAndAdd, handleIRActivate, handleDropAndIRActivate,
    ])
}
