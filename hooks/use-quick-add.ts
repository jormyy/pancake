import { useState, useCallback } from 'react'
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
) {
    const [adding, setAdding] = useState<string | null>(null)
    const [dropPickerPlayer, setDropPickerPlayer] = useState<PlayerRow | null>(null)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [dropping, setDropping] = useState<string | null>(null)
    const [irModal, setIrModal] = useState<IRModalState>(null)

    const checkIR = useCallback(
        async (player: PlayerRow, lid: string, excludeRosterId?: string): Promise<RosterPlayer[] | null> => {
            if (!memberId) return null
            const { roster, ineligible } = await loadRosterAddGate(memberId, lid, excludeRosterId)
            if (ineligible.length > 0) {
                setIrModal({ ineligible, roster, pendingPlayer: player })
                return null
            }
            return roster
        },
        [memberId]
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
                            setAdding(player.id)
                            try {
                                await submitWaiverClaim(memberId, lid, player.id)
                                onAfterClaim?.()
                            } catch (e) {
                                Alert.alert('Error', getErrorMessage(e))
                            } finally {
                                setAdding(null)
                                refreshOwned()
                            }
                        },
                    },
                ],
            )
        },
        [memberId, refreshOwned]
    )

    async function addFreeAgentWithFallback(player: PlayerRow, lid: string) {
        if (!memberId) return
        setAdding(player.id)
        try {
            const result = await addFreeAgentOrRequestDrop(memberId, lid, player.id)
            if (result.status === 'roster_full') {
                setMyRoster(result.activeRoster)
                setDropPickerPlayer(player)
                return
            }
            await refreshOwned()
        } catch (e) {
            Alert.alert('Error', getErrorMessage(e))
        } finally {
            setAdding(null)
        }
    }

    async function proceedAfterIR(player: PlayerRow, lid: string) {
        if (waiverIds.has(player.id)) {
            claimWaiver(player, lid)
        } else {
            await addFreeAgentWithFallback(player, lid)
        }
    }

    async function continueAfterIRResolution(lid: string, roster: RosterPlayer[], remaining: RosterPlayer[]) {
        if (remaining.length > 0) {
            setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
        } else {
            const pending = irModal!.pendingPlayer
            setIrModal(null)
            await proceedAfterIR(pending, lid)
        }
    }

    async function handleAdd(player: PlayerRow) {
        if (!memberId || !leagueId) return

        if (waiverIds.has(player.id)) {
            const roster = await checkIR(player, leagueId)
            if (!roster) return
            claimWaiver(player, leagueId, () => {
                Alert.alert('Claimed', 'Waiver claim submitted.')
            })
            return
        }

        const roster = await checkIR(player, leagueId)
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
            if (result.status === 'roster_full') {
                setDropPickerPlayer(player)
                setMyRoster(result.activeRoster)
            } else {
                Alert.alert('Added', `${player.display_name} added to your roster.`)
            }
        } catch (e) {
            Alert.alert('Error', getErrorMessage(e))
        } finally {
            setAdding(null)
            refreshOwned()
        }
    }

    async function handleDropAndAdd(rosterPlayer: RosterPlayer) {
        if (!memberId || !dropPickerPlayer || !leagueId) return

        const roster = await checkIR(dropPickerPlayer, leagueId, rosterPlayer.id)
        if (!roster) return

        setDropping(rosterPlayer.id)
        try {
            await dropAndAddFreeAgent(rosterPlayer.id, memberId, leagueId, dropPickerPlayer.id)
            setDropPickerPlayer(null)
            await refreshOwned()
        } catch (e) {
            Alert.alert('Error', getErrorMessage(e))
        } finally {
            setDropping(null)
        }
    }

    async function handleIRActivate(rp: RosterPlayer) {
        if (!memberId || !leagueId) return
        const result = await resolveRosterAddIRConflict({ memberId, leagueId, activatePlayer: rp })
        if (result.status === 'locked') {
            Alert.alert('Roster locked', result.message)
        } else {
            await continueAfterIRResolution(leagueId, result.roster, result.remaining)
        }
    }

    async function handleDropAndIRActivate(toDrop: RosterPlayer, activatePlayer: RosterPlayer) {
        if (!memberId || !leagueId) return
        const result = await resolveRosterAddIRConflict({ memberId, leagueId, activatePlayer, dropPlayer: toDrop })
        if (result.status === 'locked') {
            Alert.alert('Roster locked', result.message)
        } else {
            await continueAfterIRResolution(leagueId, result.roster, result.remaining)
        }
    }

    return {
        adding,
        dropPickerPlayer, setDropPickerPlayer,
        myRoster,
        dropping,
        irModal, setIrModal,
        handleAdd,
        handleDropAndAdd,
        handleIRActivate,
        handleDropAndIRActivate,
    }
}
