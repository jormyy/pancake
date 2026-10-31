import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { PlayerRow } from '@/lib/players'
import {
    toggleIR,
    dropPlayer,
    RosterPlayer,
} from '@/lib/roster'
import { addFreeAgentOrRequestDrop, loadRosterAddGate, resolveRosterAddIRConflict } from '@/lib/roster-add-flow'
import { useAddLimitGate } from '@/hooks/use-add-limit-gate'
import { isIREligible, isTaxiEligible } from '@pancake/core'
import { canAddToIR, hasOpenIRSlot, pickupDestinations, reportPickupError, type PickupDestination } from '@/lib/pickup'
import { showAlert, showSuccess } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import type { MemberTransactionState } from '@/lib/league'
import { getRosterProblems } from '@/lib/roster-problems'

/** What a pickup needs to know about its player. */
type QuickAddPlayer = Pick<PlayerRow, 'id' | 'display_name'> & { injury_status?: string | null; years_exp?: number | null; career_regular_season_games?: number | null }

export type PickupClaimSelection = { dropPlayerId: string; destination: PickupDestination }

type PickupAction = 'add' | 'claim'

type IRModalState = {
    ineligible: RosterPlayer[]
    roster: RosterPlayer[]
    pendingPlayer: QuickAddPlayer
    /** What continues once IR is resolved: the add itself, or the claim flow. */
    action: PickupAction
    serverMessage?: string
} | null

type QuickAddOptions = {
    taxiSlots?: number
    rosterSize?: number
    irSlots?: number
    allowIR?: boolean
    memberId: string | undefined
    leagueId: string | null
    /** Reloads whatever the screen shows about ownership and the weekly add state, after a change or a block. */
    onChanged: () => void
    transactionState?: MemberTransactionState | null
    /** Opens the claim flow: for a claim once IR is clear, or when the server says an added player is still on waivers. */
    onClaimInstead?: (player: QuickAddPlayer, selection?: PickupClaimSelection) => void
}

export function useQuickAdd({
    memberId,
    leagueId,
    irSlots = 2,
    taxiSlots = 0,
    rosterSize = 20,
    allowIR = true,
    onChanged,
    transactionState,
    onClaimInstead,
}: QuickAddOptions) {
    const [adding, setAdding] = useState<string | null>(null)
    const [dropPickerPlayer, setDropPickerPlayer] = useState<QuickAddPlayer | null>(null)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [openIR, setOpenIR] = useState(false)
    const [taxiAvailable, setTaxiAvailable] = useState(false)
    const [placementRoster, setPlacementRoster] = useState<RosterPlayer[]>([])
    const taxiExits = useRef(new Set<string>())
    const [dropping, setDropping] = useState<string | null>(null)
    const [irModal, setIrModal] = useState<IRModalState>(null)
    const ownerIdentity = memberId && leagueId ? `${memberId}:${leagueId}` : null
    const renderedOwnerRef = useRef(ownerIdentity)
    const activeOwnerRef = useRef(ownerIdentity)
    const generationRef = useRef(0)
    const pendingAdds = useRef(new Map<string, symbol>())
    const pendingDropAndAdd = useRef<symbol | null>(null)
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
        activeOwnerRef.current = ownerIdentity
        generationRef.current += 1
        setStateOwnerIdentity(ownerIdentity)
        setAdding(null)
        setDropPickerPlayer(null)
        setTaxiAvailable(false)
        setPlacementRoster([])
        taxiExits.current = new Set()
        setMyRoster([])
        setDropping(null)
        pendingDropAndAdd.current = null
        setIrModal(null)
        const reservations = pendingAdds.current
        return () => {
            generationRef.current += 1
            activeOwnerRef.current = null
            reservations.clear()
            pendingDropAndAdd.current = null
        }
    }, [ownerIdentity])

    // Resolves to the roster when it has no ineligible IR players; otherwise
    // opens the IR modal, which continues the pickup once IR is clear.
    const checkIR = useCallback(
        async (player: QuickAddPlayer, lid: string, action: PickupAction, excludeRosterId?: string): Promise<RosterPlayer[] | null> => {
            if (!memberId) return null
            const generation = generationRef.current
            const identity = ownerIdentity
            try {
                const { roster, ineligible, taxiExitIds } = await loadRosterAddGate(memberId, lid, excludeRosterId, rosterSize, taxiSlots > 0)
                if (!isCurrent(generation, identity)) return null
                taxiExits.current = taxiExitIds ?? new Set()
                if (ineligible.length > 0 || getRosterProblems(roster, rosterSize).some(problem => problem.kind === 'over_limit')) {
                    setDropPickerPlayer(null)
                    setIrModal({ ineligible, roster, pendingPlayer: player, action })
                    return null
                }
                return roster
            } catch (error) {
                if (isCurrent(generation, identity)) showAlert('Error', getErrorMessage(error))
                return null
            }
        },
        [memberId, ownerIdentity, isCurrent, rosterSize, taxiSlots]
    )

    const report = useCallback((error: unknown, player?: QuickAddPlayer) => reportPickupError(error, {
        refresh: onChanged,
        onLimitReached: () => setDropPickerPlayer(null),
        claim: onClaimInstead && player ? () => onClaimInstead(player) : undefined,
        onIneligibleIr: player && leagueId
            ? (message) => { void checkIR(player, leagueId, 'add').then((roster) => {
                if (roster) { setDropPickerPlayer(null); setIrModal({ ineligible: [], roster, pendingPlayer: player, action: 'add', serverMessage: message }) }
            }) }
            : undefined,
    }), [onChanged, onClaimInstead, leagueId, checkIR])

    // The server decides between an add and a full roster; a full roster opens
    // the drop picker with the roster already in hand.
    const addFreeAgent = useCallback(async (player: QuickAddPlayer, lid: string, roster: RosterPlayer[], toTaxi = false) => {
        if (!memberId) return
        const generation = generationRef.current
        const identity = ownerIdentity
        setAdding(player.id)
        try {
            const toIr = !toTaxi && allowIR && canAddToIR(player.injury_status, roster, irSlots)
            const result = toTaxi ? await addFreeAgentOrRequestDrop(memberId, lid, player.id, roster, false, true)
                : await addFreeAgentOrRequestDrop(memberId, lid, player.id, roster, toIr)
            if (!isCurrent(generation, identity)) return
            if (result.status === 'roster_full') {
                setOpenIR(allowIR && hasOpenIRSlot(roster, irSlots))
                setMyRoster(result.roster)
                setPlacementRoster(roster)
                setDropPickerPlayer(player)
                return
            }
            setDropPickerPlayer(null)
            setTaxiAvailable(false)
            showSuccess('Added', `${player.display_name} added to ${toIr ? 'IR' : toTaxi ? 'taxi' : 'your roster'}.`)
            onChanged()
        } catch (e) {
            if (isCurrent(generation, identity)) report(e, player)
        } finally {
            if (isCurrent(generation, identity)) setAdding((current) => current === player.id ? null : current)
        }
    }, [memberId, ownerIdentity, onChanged, isCurrent, report, allowIR, irSlots])

    const beginAdd = useCallback(async (player: QuickAddPlayer, lid: string, roster: RosterPlayer[]) => {
        const toIr = allowIR && canAddToIR(player.injury_status, roster, irSlots)
        const canTaxi = !toIr && taxiSlots > roster.filter(row => row.is_on_taxi).length
            && isTaxiEligible(player.years_exp ?? null, player.career_regular_season_games ?? null) && !taxiExits.current.has(player.id)
        setTaxiAvailable(canTaxi)
        if (!canTaxi) { await addFreeAgent(player, lid, roster); return }
        const active = roster.filter(row => !row.is_on_ir && !row.is_on_taxi)
        setPlacementRoster(roster)
        setMyRoster(active.length >= rosterSize ? roster : [])
        setDropPickerPlayer(player)
        setOpenIR(allowIR && hasOpenIRSlot(roster, irSlots))
    }, [allowIR, irSlots, taxiSlots, rosterSize, addFreeAgent])

    const continueAfterIRResolution = useCallback(async (lid: string, roster: RosterPlayer[], remaining: RosterPlayer[]) => {
        if (remaining.length > 0 || getRosterProblems(roster, rosterSize).length > 0) {
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
        await beginAdd(pendingPlayer, lid, roster)
    }, [irModal, beginAdd, explainBlock, onClaimInstead, rosterSize])

    const handleAdd = useCallback(async (player: QuickAddPlayer) => {
        if (!memberId || !leagueId || activeOwnerRef.current !== ownerIdentity) return
        if (explainBlock()) return
        if (pendingAdds.current.has(player.id)) return
        const token = Symbol('pending-player-add')
        const generation = generationRef.current
        const identity = ownerIdentity
        pendingAdds.current.set(player.id, token)
        setAdding(player.id)
        try {
            const roster = await checkIR(player, leagueId, 'claim')
            if (roster) onClaimInstead?.(player)
        } finally {
            if (pendingAdds.current.get(player.id) === token) pendingAdds.current.delete(player.id)
            if (isCurrent(generation, identity)) setAdding((current) => current === player.id ? null : current)
        }
    }, [memberId, leagueId, ownerIdentity, checkIR, onClaimInstead, explainBlock, isCurrent])

    // A claim runs the same IR gate as an add and then hands off to the claim
    // flow, which owns the add-limit gate with fresh state.
    const handleClaim = useCallback(async (player: QuickAddPlayer) => {
        if (!memberId || !leagueId) return
        const roster = await checkIR(player, leagueId, 'claim')
        if (roster) onClaimInstead?.(player)
    }, [memberId, leagueId, checkIR, onClaimInstead])

    const handleDropAndAdd = useCallback(async (rosterPlayer: RosterPlayer, destination: PickupDestination = 'active') => {
        if (!memberId || !dropPickerPlayer || !leagueId || activeOwnerRef.current !== ownerIdentity || pendingDropAndAdd.current) return
        if (explainBlock()) {
            setDropPickerPlayer(null)
            return
        }
        const generation = generationRef.current
        const identity = ownerIdentity

        const token = Symbol('pending-drop-and-add')
        pendingDropAndAdd.current = token
        setDropping(rosterPlayer.id)
        try {
            const roster = await checkIR(dropPickerPlayer, leagueId, 'claim', rosterPlayer.id)
            if (!roster || !isCurrent(generation, identity)) return
            if (!pickupDestinations(dropPickerPlayer, roster, { rosterSize, taxiSlots, irSlots, allowIR }, taxiExits.current, rosterPlayer)[destination]) {
                showAlert('Select destination', 'This drop does not free space for an eligible pickup in that slot.')
                return
            }
            onClaimInstead?.(dropPickerPlayer, { dropPlayerId: rosterPlayer.players.id, destination })
            setDropPickerPlayer(null)
        } catch (e) {
            if (isCurrent(generation, identity)) report(e, dropPickerPlayer)
        } finally {
            if (pendingDropAndAdd.current === token) pendingDropAndAdd.current = null
            if (isCurrent(generation, identity)) setDropping(null)
        }
    }, [memberId, leagueId, ownerIdentity, dropPickerPlayer, checkIR, isCurrent, explainBlock, report, rosterSize, taxiSlots, irSlots, allowIR, onClaimInstead])

    const handleMoveToIRAndAdd = useCallback(async (rosterPlayer: RosterPlayer) => {
        if (!memberId || !leagueId || !dropPickerPlayer || pendingDropAndAdd.current || !ownsState || activeOwnerRef.current !== ownerIdentity) return
        if (explainBlock()) return
        const generation = generationRef.current
        const identity = ownerIdentity
        const token = Symbol('pending-ir-and-add')
        pendingDropAndAdd.current = token
        setDropping(rosterPlayer.id)
        try {
            await toggleIR(rosterPlayer.id, true)
            if (!isCurrent(generation, identity)) return
            setDropPickerPlayer(null)
            onChanged()
            const roster = await checkIR(dropPickerPlayer, leagueId, 'add')
            if (roster) await addFreeAgent(dropPickerPlayer, leagueId, roster)
        } catch (error) {
            if (isCurrent(generation, identity)) report(error, dropPickerPlayer)
        } finally {
            if (pendingDropAndAdd.current === token) pendingDropAndAdd.current = null
            if (isCurrent(generation, identity)) setDropping(null)
        }
    }, [memberId, leagueId, dropPickerPlayer, ownsState, explainBlock, ownerIdentity, isCurrent, onChanged, checkIR, addFreeAgent, report])

    const handleIRActivate = useCallback(async (rp: RosterPlayer) => {
        if (!memberId || !leagueId) return
        const generation = generationRef.current
        const identity = ownerIdentity
        try {
            const result = await resolveRosterAddIRConflict({ memberId, leagueId, activatePlayer: rp, rosterSize })
            if (!isCurrent(generation, identity)) return
            if (result.status === 'locked') {
                showAlert('Roster locked', result.message)
            } else {
                await continueAfterIRResolution(leagueId, result.roster, result.remaining)
            }
        } catch (error) {
            if (isCurrent(generation, identity)) showAlert('Error', getErrorMessage(error))
        }
    }, [memberId, leagueId, ownerIdentity, continueAfterIRResolution, isCurrent, rosterSize])

    const handleDropAndIRActivate = useCallback(async (toDrop: RosterPlayer, activatePlayer: RosterPlayer) => {
        if (!memberId || !leagueId) return
        const generation = generationRef.current
        const identity = ownerIdentity
        try {
            const result = await resolveRosterAddIRConflict({ memberId, leagueId, activatePlayer, dropPlayer: toDrop, rosterSize })
            if (!isCurrent(generation, identity)) return
            if (result.status === 'locked') {
                showAlert('Roster locked', result.message)
            } else {
                await continueAfterIRResolution(leagueId, result.roster, result.remaining)
            }
        } catch (error) {
            if (isCurrent(generation, identity)) showAlert('Error', getErrorMessage(error))
        }
    }, [memberId, leagueId, ownerIdentity, continueAfterIRResolution, isCurrent, rosterSize])

    const handlePlacement = useCallback(async (toTaxi: boolean) => {
        if (!dropPickerPlayer || !leagueId || !ownsState || pendingDropAndAdd.current || explainBlock()) return
        const token = Symbol('placement')
        pendingDropAndAdd.current = token
        try {
            const roster = await checkIR(dropPickerPlayer, leagueId, 'add')
            if (roster) await addFreeAgent(dropPickerPlayer, leagueId, roster, toTaxi)
        } finally {
            if (pendingDropAndAdd.current === token) pendingDropAndAdd.current = null
        }
    }, [dropPickerPlayer, leagueId, ownsState, explainBlock, checkIR, addFreeAgent])

    const handleResolutionChange = useCallback(async (player: RosterPlayer, moveToIR: boolean) => {
        if (!memberId || !leagueId) return
        const generation = generationRef.current
        const identity = ownerIdentity
        try {
            if (moveToIR) await toggleIR(player.id, true)
            else await dropPlayer(player.id)
            if (!isCurrent(generation, identity)) return
            const { roster, ineligible } = await loadRosterAddGate(memberId, leagueId, undefined, rosterSize)
            if (isCurrent(generation, identity)) await continueAfterIRResolution(leagueId, roster, ineligible)
        } catch (error) {
            if (isCurrent(generation, identity)) showAlert('Error', getErrorMessage(error))
        }
    }, [memberId, leagueId, ownerIdentity, isCurrent, rosterSize, continueAfterIRResolution])

    return useMemo(() => ({
        adding: ownsState ? adding : null,
        dropPickerPlayer: ownsState ? dropPickerPlayer : null, setDropPickerPlayer,
        myRoster: ownsState ? myRoster : [],
        dropping: ownsState ? dropping : null,
        irModal: ownsState ? irModal : null, setIrModal,
        addBlockedReason,
        taxiAvailable: ownsState && taxiAvailable,
        canAddActive: ownsState && placementRoster.filter(row => !row.is_on_ir && !row.is_on_taxi).length < rosterSize,
        handleAddToTaxi: () => handlePlacement(true),
        handleAddActive: () => handlePlacement(false),
        handleResolutionDrop: (player: RosterPlayer) => handleResolutionChange(player, false),
        handleResolutionMoveToIR: (player: RosterPlayer) => handleResolutionChange(player, true),
        handleAdd,
        handleClaim,
        handleDropAndAdd,
        dropDestinations: (drop: RosterPlayer) => dropPickerPlayer
            ? pickupDestinations(dropPickerPlayer, placementRoster, { rosterSize, taxiSlots, irSlots, allowIR }, taxiExits.current, drop)
            : { active: false, taxi: false, ir: false },
        handleMoveToIRAndAdd,
        irMoveCandidates: ownsState && openIR ? myRoster.filter(player => !player.is_on_ir && !player.is_on_taxi && isIREligible(player.players.injury_status)) : [],
        handleIRActivate,
        handleDropAndIRActivate,
    }), [
        ownsState, openIR, taxiAvailable, placementRoster, rosterSize, taxiSlots, irSlots, allowIR, handlePlacement, handleResolutionChange, adding, dropPickerPlayer, myRoster, dropping, irModal, addBlockedReason,
        handleAdd, handleClaim, handleDropAndAdd, handleMoveToIRAndAdd, handleIRActivate, handleDropAndIRActivate,
    ])
}
