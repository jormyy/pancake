import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { Alert } from 'react-native'
import { PlayerRow } from '@/lib/players'
import {
    dropAndAddFreeAgent,
    RosterPlayer,
} from '@/lib/roster'
import { addFreeAgentOrRequestDrop, loadRosterAddGate, resolveRosterAddIRConflict } from '@/lib/roster-add-flow'
import { submitWaiverClaim } from '@/lib/waivers'
import { getErrorMessage } from '@/lib/alert'

type IRModalState = {
    ineligible: RosterPlayer[]
    roster: RosterPlayer[]
    pendingPlayer: PlayerRow
} | null

export function useQuickAdd(
    memberId: string | undefined,
    leagueId: string | null,
    rosterSize: number,
    waiverIds: Set<string>,
    refreshOwned: () => void,
    refreshTransactionState?: () => void,
) {
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
        (player: PlayerRow, lid: string, onAfterClaim?: () => void) => {
            Alert.alert(
                'Place Waiver Claim',
                `You sure you wanna put in a waiver claim for ${player.display_name}? Claims process nightly.`,
                [
                    { text: 'Nah', style: 'cancel' },
                    {
                        text: 'Claim',
                        onPress: async () => {
                            if (!memberId) return
                            const generation = generationRef.current
                            const identity = ownerIdentity
                            if (!isCurrent(generation, identity)) return
                            setAdding(player.id)
                            try {
                                await submitWaiverClaim(memberId, lid, player.id)
                                if (!isCurrent(generation, identity)) return
                                onAfterClaim?.()
                                refreshTransactionState?.()
                            } catch (e) {
                                if (isCurrent(generation, identity)) Alert.alert('Error', getErrorMessage(e))
                            } finally {
                                if (isCurrent(generation, identity)) {
                                    setAdding(null)
                                    refreshOwned()
                                }
                            }
                        },
                    },
                ],
            )
        },
        [memberId, ownerIdentity, refreshOwned, refreshTransactionState, isCurrent]
    )

    const addFreeAgentWithFallback = useCallback(async (player: PlayerRow, lid: string) => {
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
            await refreshOwned()
            refreshTransactionState?.()
        } catch (e) {
            if (isCurrent(generation, identity)) Alert.alert('Error', getErrorMessage(e))
        } finally {
            if (isCurrent(generation, identity)) setAdding(null)
        }
    }, [memberId, ownerIdentity, refreshOwned, refreshTransactionState, isCurrent])

    const proceedAfterIR = useCallback(async (player: PlayerRow, lid: string) => {
        if (waiverIds.has(player.id)) {
            claimWaiver(player, lid)
        } else {
            await addFreeAgentWithFallback(player, lid)
        }
    }, [waiverIds, claimWaiver, addFreeAgentWithFallback])

    const continueAfterIRResolution = useCallback(async (lid: string, roster: RosterPlayer[], remaining: RosterPlayer[]) => {
        if (remaining.length > 0) {
            setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
        } else {
            const pending = irModal!.pendingPlayer
            setIrModal(null)
            await proceedAfterIR(pending, lid)
        }
    }, [irModal, proceedAfterIR])

    const handleAdd = useCallback(async (player: PlayerRow) => {
        if (!memberId || !leagueId) return
        const generation = generationRef.current
        const identity = ownerIdentity

        if (waiverIds.has(player.id)) {
            const roster = await checkIR(player, leagueId)
            if (!isCurrent(generation, identity)) return
            if (!roster) return
            claimWaiver(player, leagueId, () => {
                Alert.alert('Claimed', 'Waiver claim submitted.')
            })
            return
        }

        const roster = await checkIR(player, leagueId)
        if (!isCurrent(generation, identity)) return
        if (!roster) return
        const active = roster.filter((r) => !r.is_on_ir && !r.is_on_taxi)
        if (active.length >= rosterSize) {
            setDropPickerPlayer(player)
            setMyRoster(roster)
            return
        }

        setAdding(player.id)
        try {
            const result = await addFreeAgentOrRequestDrop(memberId, leagueId, player.id)
            if (!isCurrent(generation, identity)) return
            if (result.status === 'roster_full') {
                setDropPickerPlayer(player)
                setMyRoster(result.activeRoster)
            } else {
                Alert.alert('Added', `${player.display_name} added to your roster.`)
            }
        } catch (e) {
            if (isCurrent(generation, identity)) Alert.alert('Error', getErrorMessage(e))
        } finally {
            if (isCurrent(generation, identity)) {
                setAdding(null)
                refreshOwned()
                refreshTransactionState?.()
            }
        }
    }, [memberId, leagueId, ownerIdentity, rosterSize, waiverIds, checkIR, claimWaiver, refreshOwned, refreshTransactionState, isCurrent])

    const handleDropAndAdd = useCallback(async (rosterPlayer: RosterPlayer) => {
        if (!memberId || !dropPickerPlayer || !leagueId) return
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
            await refreshOwned()
            refreshTransactionState?.()
        } catch (e) {
            if (isCurrent(generation, identity)) Alert.alert('Error', getErrorMessage(e))
        } finally {
            if (isCurrent(generation, identity)) setDropping(null)
        }
    }, [memberId, leagueId, ownerIdentity, dropPickerPlayer, checkIR, refreshOwned, refreshTransactionState, isCurrent])

    const handleIRActivate = useCallback(async (rp: RosterPlayer) => {
        if (!memberId || !leagueId) return
        const generation = generationRef.current
        const identity = ownerIdentity
        const result = await resolveRosterAddIRConflict({ memberId, leagueId, activatePlayer: rp })
        if (!isCurrent(generation, identity)) return
        if (result.status === 'locked') {
            Alert.alert('Roster locked', result.message)
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
            Alert.alert('Roster locked', result.message)
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
        handleAdd,
        handleDropAndAdd,
        handleIRActivate,
        handleDropAndIRActivate,
    }), [
        ownsState, adding, dropPickerPlayer, myRoster, dropping, irModal,
        handleAdd, handleDropAndAdd, handleIRActivate, handleDropAndIRActivate,
    ])
}
