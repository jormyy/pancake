import { useCallback, useState } from 'react'
import { Alert } from 'react-native'
import { setPlayerSlot, setPlayerSlotMoves, autoSetLineup, canPlaySlot, LineupSlot, LineupPlayer } from '@/lib/lineup'
import { activateRosterPlayerWithOverflow, isIREligible, toggleIR, toggleTaxi } from '@/lib/roster'
import { todayET } from '@/lib/shared/dates'
import { getErrorMessage } from '@/lib/alert'

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir?: LineupPlayer[]; taxi?: LineupPlayer[] }
type Sel = { kind: 'starter'; index: number } | { kind: 'bench'; index: number } | { kind: 'ir'; index: number } | { kind: 'taxi'; index: number }
type PendingActivation = { rosterPlayerId: string; source: 'ir' | 'taxi' }
export type LineupActionContext = {
    memberId: string
    leagueId: string
    seasonId: string
    weekNumber: number
    seasonYear: number
}

export function useLineupActions({
    actionContext,
    myLineup,
    league,
    selectedDate,
    startedTeams,
    reloadLineup,
}: {
    actionContext: LineupActionContext | null | undefined
    myLineup: LineupData | null
    league: { roster_size?: number; taxi_slots?: number } | null
    selectedDate: string
    startedTeams: Set<string>
    reloadLineup: (date: string) => Promise<void>
}) {
    const [selected, setSelected] = useState<Sel | null>(null)
    const [saving, setSaving] = useState(false)
    const [autoSetting, setAutoSetting] = useState(false)
    const [autoSetModalVisible, setAutoSetModalVisible] = useState(false)
    const [activationOverflowPending, setActivationOverflowPending] = useState<PendingActivation | null>(null)
    const [activationOverflowSaving, setActivationOverflowSaving] = useState(false)

    const handleTap = useCallback(async (newSel: Sel) => {
        if (selectedDate < todayET()) {
            Alert.alert('Past lineup', 'Lineups for past days cannot be changed.')
            setSelected(null)
            return
        }

        if (!selected) { setSelected(newSel); return }
        if (selected.kind === newSel.kind && selected.index === newSel.index) {
            setSelected(null); return
        }
        setSelected(null)
        if (!actionContext || !myLineup || !league) return

        const starters = myLineup.starters
        const bench = myLineup.bench
        const ir = myLineup.ir ?? []
        const taxi = myLineup.taxi ?? []

        const getPlayer = (s: Sel): LineupPlayer | null =>
            s.kind === 'starter' ? starters[s.index]?.player ?? null
            : s.kind === 'bench' ? bench[s.index] ?? null
            : s.kind === 'ir' ? ir[s.index] ?? null
            : taxi[s.index] ?? null
        const getSlot = (s: Sel): string =>
            s.kind === 'starter' ? starters[s.index]?.slotType ?? 'BE'
            : s.kind === 'bench' ? 'BE'
            : s.kind === 'ir' ? 'IR'
            : 'TX'

        const aPlayer = getPlayer(selected)
        const bPlayer = getPlayer(newSel)
        const aSlot = getSlot(selected)
        const bSlot = getSlot(newSel)
        const isLocked = (player: LineupPlayer | null) => !!(player?.nbaTeam && startedTeams.has(player.nbaTeam))
        const lockedPlayer = isLocked(aPlayer) ? aPlayer : isLocked(bPlayer) ? bPlayer : null
        if (lockedPlayer) {
            Alert.alert('Lineup locked', `${lockedPlayer.displayName}'s game has already started. No lineup changes are allowed once a game begins.`)
            return
        }

        // Disallow direct IR ↔ taxi swaps
        if ((aSlot === 'IR' && bSlot === 'TX') || (aSlot === 'TX' && bSlot === 'IR')) {
            Alert.alert('Invalid move', 'Cannot swap directly between IR and Taxi Squad.')
            return
        }

        if (aSlot === 'IR' || bSlot === 'IR') {
            const irSel   = aSlot === 'IR' ? selected : newSel
            const actSel  = aSlot === 'IR' ? newSel   : selected
            const irPlayer  = getPlayer(irSel)
            const actPlayer = getPlayer(actSel)

            if (actPlayer && !isIREligible(actPlayer.injuryStatus)) {
                Alert.alert('Not eligible', `${actPlayer.displayName} must be OUT or IR-designated to be placed on Injured Reserve.`)
                return
            }

            if (irPlayer && !actPlayer) {
                const rosterSize: number = league?.roster_size ?? 20
                const activeCount = starters.filter(s => s.player !== null).length + bench.length
                if (activeCount >= rosterSize) {
                    setActivationOverflowPending({ rosterPlayerId: irPlayer.rosterPlayerId, source: 'ir' })
                    return
                }
            }

            setSaving(true)
            try {
                if (actPlayer) await toggleIR(actPlayer.rosterPlayerId, true)
                if (irPlayer) {
                    await toggleIR(irPlayer.rosterPlayerId, false)
                    if (actSel.kind === 'starter') {
                        const slotType = starters[actSel.index]?.slotType
                        if (slotType && canPlaySlot(irPlayer.eligiblePositions, slotType)) {
                            await setPlayerSlot(actionContext.memberId, actionContext.leagueId, actionContext.seasonId, actionContext.weekNumber, selectedDate, irPlayer.playerId, slotType)
                        }
                    }
                }
                await reloadLineup(selectedDate)
            } catch (e) {
                Alert.alert('Error', getErrorMessage(e))
            } finally {
                setSaving(false)
            }
            return
        }

        if (aSlot === 'TX' || bSlot === 'TX') {
            const taxiSel  = aSlot === 'TX' ? selected : newSel
            const actSel   = aSlot === 'TX' ? newSel   : selected
            const taxiPlayer = getPlayer(taxiSel)
            const actPlayer  = getPlayer(actSel)

            if (actPlayer) {
                // Moving active → taxi: check taxi slot availability
                const taxiLimit: number = league?.taxi_slots ?? 0
                if (taxiLimit === 0) {
                    Alert.alert('Taxi squad disabled', 'This league has no taxi squad slots configured.')
                    return
                }
                if (taxi.length >= taxiLimit) {
                    Alert.alert('Taxi squad full', `Your taxi squad is full (${taxiLimit} slots).`)
                    return
                }
            }

            if (taxiPlayer && !actPlayer) {
                // Activating a taxi player: check active roster space
                const rosterSize: number = league?.roster_size ?? 20
                const activeCount = starters.filter(s => s.player !== null).length + bench.length
                if (activeCount >= rosterSize) {
                    setActivationOverflowPending({ rosterPlayerId: taxiPlayer.rosterPlayerId, source: 'taxi' })
                    return
                }
            }

            setSaving(true)
            try {
                if (actPlayer) await toggleTaxi(actPlayer.rosterPlayerId, true)
                if (taxiPlayer) {
                    await toggleTaxi(taxiPlayer.rosterPlayerId, false)
                    if (actSel.kind === 'starter') {
                        const slotType = starters[actSel.index]?.slotType
                        if (slotType && canPlaySlot(taxiPlayer.eligiblePositions, slotType)) {
                            await setPlayerSlot(actionContext.memberId, actionContext.leagueId, actionContext.seasonId, actionContext.weekNumber, selectedDate, taxiPlayer.playerId, slotType)
                        }
                    }
                }
                await reloadLineup(selectedDate)
            } catch (e) {
                Alert.alert('Error', getErrorMessage(e))
            } finally {
                setSaving(false)
            }
            return
        }

        if (aPlayer && bSlot !== 'BE' && !canPlaySlot(aPlayer.eligiblePositions, bSlot)) {
            Alert.alert('Invalid move', `${aPlayer.displayName} can't play ${bSlot}`); return
        }
        if (bPlayer && aSlot !== 'BE' && !canPlaySlot(bPlayer.eligiblePositions, aSlot)) {
            Alert.alert('Invalid move', `${bPlayer.displayName} can't play ${aSlot}`); return
        }

        setSaving(true)
        try {
            await setPlayerSlotMoves(
                {
                    memberId: actionContext.memberId,
                    leagueId: actionContext.leagueId,
                    seasonId: actionContext.seasonId,
                    weekNumber: actionContext.weekNumber,
                    gameDate: selectedDate,
                },
                [
                    ...(aPlayer ? [{ playerId: aPlayer.playerId, slotType: bSlot }] : []),
                    ...(bPlayer ? [{ playerId: bPlayer.playerId, slotType: aSlot }] : []),
                ],
            )
            await reloadLineup(selectedDate)
        } catch (e) {
            Alert.alert('Error', getErrorMessage(e))
        } finally {
            setSaving(false)
        }
    }, [selectedDate, selected, actionContext, myLineup, league, startedTeams, reloadLineup])

    async function resolveOverflow(freeAction: 'drop' | 'ir' | 'taxi', rosterPlayerId: string) {
        if (!activationOverflowPending || !actionContext) return
        const starterPlayers = myLineup?.starters
            .map((slot) => slot.player)
            .filter((player): player is LineupPlayer => player != null) ?? []
        const allPlayers = [
            ...starterPlayers,
            ...(myLineup?.bench ?? []),
            ...(myLineup?.ir ?? []),
            ...(myLineup?.taxi ?? []),
        ]
        const lockedPlayer = allPlayers.find(
            (player) =>
                (player.rosterPlayerId === rosterPlayerId || player.rosterPlayerId === activationOverflowPending.rosterPlayerId) &&
                player.nbaTeam &&
                startedTeams.has(player.nbaTeam),
        )
        if (lockedPlayer) {
            Alert.alert('Lineup locked', `${lockedPlayer.displayName}'s game has already started. No lineup changes are allowed once a game begins.`)
            return
        }
        setActivationOverflowSaving(true)
        try {
            await activateRosterPlayerWithOverflow(
                activationOverflowPending.rosterPlayerId,
                activationOverflowPending.source,
                rosterPlayerId,
                freeAction,
            )
            setActivationOverflowPending(null)
            await reloadLineup(selectedDate)
        } catch (e) {
            Alert.alert('Error', getErrorMessage(e))
        } finally {
            setActivationOverflowSaving(false)
        }
    }

    const handleOverflowDrop = (id: string) => resolveOverflow('drop', id)
    const handleOverflowMoveToIR = (id: string) => resolveOverflow('ir', id)
    const handleOverflowMoveToTaxi = (id: string) => resolveOverflow('taxi', id)

    async function doAutoSet(date: string | null, restOfSeason?: boolean) {
        if (!actionContext || !league) return
        setAutoSetting(true)
        try {
            await autoSetLineup(
                actionContext.memberId, actionContext.leagueId, actionContext.seasonId,
                actionContext.weekNumber, actionContext.seasonYear, date, restOfSeason,
            )
            await reloadLineup(selectedDate)
            if (restOfSeason) {
                Alert.alert('Done', 'Lineup set for the rest of the season.')
            }
        } catch (e) {
            Alert.alert('Auto-set failed', getErrorMessage(e) ?? String(e))
        } finally {
            setAutoSetting(false)
        }
    }

    function handleAutoSet() {
        setAutoSetModalVisible(true)
    }

    return {
        selected,
        setSelected,
        saving,
        autoSetting,
        autoSetModalVisible,
        setAutoSetModalVisible,
        activationOverflowPending,
        setActivationOverflowPending,
        activationOverflowSaving,
        handleTap,
        handleOverflowDrop,
        handleOverflowMoveToIR,
        handleOverflowMoveToTaxi,
        doAutoSet,
        handleAutoSet,
    }
}
