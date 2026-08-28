import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { PlayerRow } from '@/lib/players'
import {
    dropAndAddFreeAgent,
    RosterPlayer,
} from '@/lib/roster'
import { addFreeAgentOrRequestDrop, loadRosterAddGate, resolveRosterAddIRConflict } from '@/lib/roster-add-flow'
import { submitWaiverClaim } from '@/lib/waivers'
import { useAddLimitGate } from '@/hooks/use-add-limit-gate'
import { confirmAction, showAlert, showSuccess } from '@/lib/alert'
import type { MemberTransactionState } from '@/lib/league'

type IRModalState = {
    ineligible: RosterPlayer[]
    roster: RosterPlayer[]
    pendingPlayer: PlayerRow
} | null

export type QuickAddOptions = {
    memberId: string | undefined
    leagueId: string | null
    rosterSize: number
    waiverIds: Set<string>
    refreshOwned: () => void
    refreshTransactionState?: () => void
    transactionState?: MemberTransactionState | null
    /** Opens the claim flow when the server says the player is still on waivers. */
    onClaimInstead?: (player: PlayerRow) => void
}

export function useQuickAdd({
    memberId,
    leagueId,
    rosterSize,
    waiverIds,
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
    const closeDropPicker = useCallback(() => setDropPickerPlayer(null), [])
    const { addBlockedReason, explainBlock, reportError } = useAddLimitGate({
        transactionState,
        refresh: refreshTransactionState,
        onLimitReached: closeDropPicker,
    })

    useEffect(() => {
        generationRef.current += 1
        setStateOwnerIdentity(ownerIdentity)
        setAdding(null)
        setDropPickerPlayer(null)
        setMyRoster([])
        setDropping(null)
        setIrModal(null)
    }, [ownerIdentity])

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

    const claimWaiver = useCallback(
        (player: PlayerRow, lid: string) => {
            confirmAction(
                'Place Waiver Claim',
                `You sure you wanna put in a waiver claim for ${player.display_name}? Claims process nightly.`,
                async () => {
                    if (!memberId) return
                    const generation = generationRef.current
                    const identity = ownerIdentity
                    if (!isCurrent(generation, identity)) return
                    setAdding(player.id)
                    try {
                        await submitWaiverClaim(memberId, lid, player.id)
                        if (!isCurrent(generation, identity)) return
                        showSuccess('Claimed', 'Waiver claim submitted.')
                        refreshTransactionState?.()
                    } catch (e) {
                        if (isCurrent(generation, identity)) reportError(e)
                    } finally {
                        if (isCurrent(generation, identity)) {
                            setAdding(null)
                            refreshOwned()
                        }
                    }
                },
                'Claim',
                false,
            )
        },
        [memberId, ownerIdentity, refreshOwned, refreshTransactionState, isCurrent, reportError]
    )

    const addFreeAgent = useCallback(async (player: PlayerRow, lid: string) => {
        if (!memberId) return
        const generation = generationRef.current
        const identity = ownerIdentity
        setAdding(player.id)
        try {
            const result = await addFreeAgentOrRequestDrop(memberId, lid, player.id)
            if (!isCurrent(generation, identity)) return
            if (result.status === 'roster_full') {
                setMyRoster(result.activeRoster)
                setDropPickerPlayer(player)
                return
            }
            showSuccess('Added', `${player.display_name} added to your roster.`)
            refreshTransactionState?.()
        } catch (e) {
            if (isCurrent(generation, identity)) reportError(e, onClaimInstead && (() => onClaimInstead(player)))
        } finally {
            if (isCurrent(generation, identity)) {
                setAdding(null)
                refreshOwned()
            }
        }
    }, [memberId, ownerIdentity, refreshOwned, refreshTransactionState, isCurrent, reportError, onClaimInstead])

    // The one dispatch for a pickup once IR is clear: waivers get a claim, a full
    // roster gets the drop picker, everything else is added directly.
    const proceedAfterIR = useCallback(async (player: PlayerRow, lid: string, roster: RosterPlayer[]) => {
        if (waiverIds.has(player.id)) {
            claimWaiver(player, lid)
            return
        }
        const active = roster.filter((r) => !r.is_on_ir && !r.is_on_taxi)
        if (active.length >= rosterSize) {
            setDropPickerPlayer(player)
            setMyRoster(roster)
            return
        }
        await addFreeAgent(player, lid)
    }, [waiverIds, claimWaiver, rosterSize, addFreeAgent])

    const continueAfterIRResolution = useCallback(async (lid: string, roster: RosterPlayer[], remaining: RosterPlayer[]) => {
        if (remaining.length > 0) {
            setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
        } else {
            const pending = irModal!.pendingPlayer
            setIrModal(null)
            if (explainBlock()) return
            await proceedAfterIR(pending, lid, roster)
        }
    }, [irModal, proceedAfterIR, explainBlock])

    const handleAdd = useCallback(async (player: PlayerRow) => {
        if (!memberId || !leagueId) return
        if (explainBlock()) return
        const generation = generationRef.current
        const identity = ownerIdentity
        const roster = await checkIR(player, leagueId)
        if (!isCurrent(generation, identity) || !roster) return
        await proceedAfterIR(player, leagueId, roster)
    }, [memberId, leagueId, ownerIdentity, checkIR, proceedAfterIR, isCurrent, explainBlock])

    const handleDropAndAdd = useCallback(async (rosterPlayer: RosterPlayer) => {
        if (!memberId || !dropPickerPlayer || !leagueId) return
        if (explainBlock()) {
            setDropPickerPlayer(null)
            return
        }
        const generation = generationRef.current
        const identity = ownerIdentity

        const roster = await checkIR(dropPickerPlayer, leagueId, rosterPlayer.id)
        if (!isCurrent(generation, identity)) return
        if (!roster) return

        setDropping(rosterPlayer.id)
        try {
            await dropAndAddFreeAgent(rosterPlayer.id, memberId, leagueId, dropPickerPlayer.id)
            if (!isCurrent(generation, identity)) return
            setDropPickerPlayer(null)
            refreshTransactionState?.()
        } catch (e) {
            if (isCurrent(generation, identity)) reportError(e, onClaimInstead && (() => onClaimInstead(dropPickerPlayer)))
        } finally {
            if (isCurrent(generation, identity)) {
                setDropping(null)
                refreshOwned()
            }
        }
    }, [memberId, leagueId, ownerIdentity, dropPickerPlayer, checkIR, refreshOwned, refreshTransactionState, isCurrent, explainBlock, reportError, onClaimInstead])

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
