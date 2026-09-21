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

/** What a pickup needs to know about its player. */
type QuickAddPlayer = Pick<PlayerRow, 'id' | 'display_name'>

type PickupAction = 'add' | 'claim'

type IRModalState = {
    ineligible: RosterPlayer[]
    roster: RosterPlayer[]
    pendingPlayer: QuickAddPlayer
    /** What continues once IR is resolved: the add itself, or the claim flow. */
    action: PickupAction
} | null

type QuickAddOptions = {
    memberId: string | undefined
    leagueId: string | null
    /** Reloads whatever the screen shows about ownership and the weekly add state, after a change or a block. */
    onChanged: () => void
    transactionState?: MemberTransactionState | null
    /** Opens the claim flow: for a claim once IR is clear, or when the server says an added player is still on waivers. */
    onClaimInstead?: (player: QuickAddPlayer) => void
}

export function useQuickAdd({
    memberId,
    leagueId,
    onChanged,
    transactionState,
    onClaimInstead,
}: QuickAddOptions) {
    const [adding, setAdding] = useState<string | null>(null)
    const [dropPickerPlayer, setDropPickerPlayer] = useState<QuickAddPlayer | null>(null)
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
    const { addBlockedReason, explainBlock } = useAddLimitGate({ transactionState, refresh: onChanged })

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
    // opens the IR modal, which continues the pickup once IR is clear.
    const checkIR = useCallback(
        async (player: QuickAddPlayer, lid: string, action: PickupAction, excludeRosterId?: string): Promise<RosterPlayer[] | null> => {
            if (!memberId) return null
            const generation = generationRef.current
            const identity = ownerIdentity
            const { roster, ineligible } = await loadRosterAddGate(memberId, lid, excludeRosterId)
            if (!isCurrent(generation, identity)) return null
            if (ineligible.length > 0) {
                setIrModal({ ineligible, roster, pendingPlayer: player, action })
                return null
            }
            return roster
        },
        [memberId, ownerIdentity, isCurrent]
    )

    const report = useCallback((error: unknown, player?: QuickAddPlayer) => reportPickupError(error, {
        refresh: onChanged,
        onLimitReached: () => setDropPickerPlayer(null),
        claim: onClaimInstead && player ? () => onClaimInstead(player) : undefined,
        onIneligibleIr: player && leagueId
            ? (message) => { void checkIR(player, leagueId, 'add').then((roster) => { if (roster) showAlert('Error', message) }) }
            : undefined,
    }), [onChanged, onClaimInstead, leagueId, checkIR])

    // The server decides between an add and a full roster; a full roster opens
    // the drop picker with the roster already in hand.
    const addFreeAgent = useCallback(async (player: QuickAddPlayer, lid: string, roster: RosterPlayer[]) => {
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
            onChanged()
        } catch (e) {
            if (isCurrent(generation, identity)) report(e, player)
        } finally {
            if (isCurrent(generation, identity)) setAdding(null)
        }
    }, [memberId, ownerIdentity, onChanged, isCurrent, report])

    const continueAfterIRResolution = useCallback(async (lid: string, roster: RosterPlayer[], remaining: RosterPlayer[]) => {
        if (remaining.length > 0) {
            setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
            return
        }
        const { pendingPlayer, action } = irModal!
        setIrModal(null)
        if (action === 'claim') {
            onClaimInstead?.(pendingPlayer)
            return
        }
        if (explainBlock()) return
        await addFreeAgent(pendingPlayer, lid, roster)
    }, [irModal, addFreeAgent, explainBlock, onClaimInstead])

    const handleAdd = useCallback(async (player: QuickAddPlayer) => {
        if (!memberId || !leagueId) return
        if (explainBlock()) return
        const roster = await checkIR(player, leagueId, 'add')
        if (roster) await addFreeAgent(player, leagueId, roster)
    }, [memberId, leagueId, checkIR, addFreeAgent, explainBlock])

    // A claim runs the same IR gate as an add and then hands off to the claim
    // flow, which owns the add-limit gate with fresh state.
    const handleClaim = useCallback(async (player: QuickAddPlayer) => {
        if (!memberId || !leagueId) return
        const roster = await checkIR(player, leagueId, 'claim')
        if (roster) onClaimInstead?.(player)
    }, [memberId, leagueId, checkIR, onClaimInstead])

    const handleDropAndAdd = useCallback(async (rosterPlayer: RosterPlayer) => {
        if (!memberId || !dropPickerPlayer || !leagueId) return
        if (explainBlock()) {
            setDropPickerPlayer(null)
            return
        }
        const generation = generationRef.current
        const identity = ownerIdentity

        if (!await checkIR(dropPickerPlayer, leagueId, 'add', rosterPlayer.id)) return

        setDropping(rosterPlayer.id)
        try {
            await dropAndAddFreeAgent(rosterPlayer.id, memberId, leagueId, dropPickerPlayer.id)
            if (!isCurrent(generation, identity)) return
            setDropPickerPlayer(null)
            onChanged()
        } catch (e) {
            if (isCurrent(generation, identity)) report(e, dropPickerPlayer)
        } finally {
            if (isCurrent(generation, identity)) setDropping(null)
        }
    }, [memberId, leagueId, ownerIdentity, dropPickerPlayer, checkIR, onChanged, isCurrent, explainBlock, report])

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
        handleClaim,
        handleDropAndAdd,
        handleIRActivate,
        handleDropAndIRActivate,
    }), [
        ownsState, adding, dropPickerPlayer, myRoster, dropping, irModal, addBlockedReason,
        handleAdd, handleClaim, handleDropAndAdd, handleIRActivate, handleDropAndIRActivate,
    ])
}
