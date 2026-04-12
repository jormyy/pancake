import { useState } from 'react'
import { Alert } from 'react-native'
import { Matchup } from '@/lib/scoring'
import { setPlayerSlot, autoSetLineup, canPlaySlot, LineupSlot, LineupPlayer } from '@/lib/lineup'
import { isIREligible, toggleIR, toggleTaxi, dropPlayer } from '@/lib/roster'
import { todayDateString } from '@/lib/shared/dates'

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[]; taxi: LineupPlayer[] }
type Sel = { kind: 'starter'; index: number } | { kind: 'bench'; index: number } | { kind: 'ir'; index: number } | { kind: 'taxi'; index: number }
// rosterPlayerId = the player being activated from IR/taxi; source tells us which toggle to call
type PendingActivation = { rosterPlayerId: string; source: 'ir' | 'taxi' }

export function useLineupActions({
    matchup,
    myLineup,
    league,
    selectedDate,
    startedTeams,
    loadMyLineup,
}: {
    matchup: Matchup | null | undefined
    myLineup: LineupData | null
    league: any
    selectedDate: string
    startedTeams: Set<string>
    loadMyLineup: (m: Matchup, date: string) => Promise<void>
}) {
    const [selected, setSelected] = useState<Sel | null>(null)
    const [saving, setSaving] = useState(false)
    const [autoSetting, setAutoSetting] = useState(false)
    const [autoSetModalVisible, setAutoSetModalVisible] = useState(false)
    const [activationOverflowPending, setActivationOverflowPending] = useState<PendingActivation | null>(null)
    const [activationOverflowSaving, setActivationOverflowSaving] = useState(false)

    async function handleTap(newSel: Sel) {
        if (selectedDate < todayDateString()) {
            Alert.alert('Past lineup', 'Lineups for past days cannot be changed.')
            setSelected(null)
            return
        }

        if (!selected) { setSelected(newSel); return }
        if (selected.kind === newSel.kind && selected.index === newSel.index) {
            setSelected(null); return
        }
        setSelected(null)
        if (!matchup || !myLineup) return

        const starters = myLineup.starters
        const bench = myLineup.bench
        const ir = myLineup.ir

        const taxi = myLineup.taxi

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
                            await setPlayerSlot(matchup.myMemberId, league.id, matchup.seasonId, matchup.weekNumber, selectedDate, irPlayer.playerId, slotType)
                        }
                    }
                }
                await loadMyLineup(matchup, selectedDate)
            } catch (e: any) {
                Alert.alert('Error', e.message)
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
                            await setPlayerSlot(matchup.myMemberId, league.id, matchup.seasonId, matchup.weekNumber, selectedDate, taxiPlayer.playerId, slotType)
                        }
                    }
                }
                await loadMyLineup(matchup, selectedDate)
            } catch (e: any) {
                Alert.alert('Error', e.message)
            } finally {
                setSaving(false)
            }
            return
        }

        const aLocked = !!(aPlayer?.nbaTeam && startedTeams.has(aPlayer.nbaTeam))
        const bLocked = !!(bPlayer?.nbaTeam && startedTeams.has(bPlayer.nbaTeam))
        if (aLocked || bLocked) {
            const who = aLocked ? aPlayer! : bPlayer!
            Alert.alert('Lineup locked', `${who.displayName}'s game has already started. No lineup changes are allowed once a game begins.`)
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
            const saves: Promise<void>[] = []
            if (aPlayer) saves.push(setPlayerSlot(matchup.myMemberId, league.id, matchup.seasonId, matchup.weekNumber, selectedDate, aPlayer.playerId, bSlot))
            if (bPlayer) saves.push(setPlayerSlot(matchup.myMemberId, league.id, matchup.seasonId, matchup.weekNumber, selectedDate, bPlayer.playerId, aSlot))
            await Promise.all(saves)
            await loadMyLineup(matchup, selectedDate)
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSaving(false)
        }
    }

    async function activatePending() {
        if (!activationOverflowPending) return
        if (activationOverflowPending.source === 'ir') {
            await toggleIR(activationOverflowPending.rosterPlayerId, false)
        } else {
            await toggleTaxi(activationOverflowPending.rosterPlayerId, false)
        }
    }

    async function handleOverflowDrop(dropRosterPlayerId: string) {
        if (!activationOverflowPending || !matchup) return
        setActivationOverflowSaving(true)
        try {
            await dropPlayer(dropRosterPlayerId)
            await activatePending()
            setActivationOverflowPending(null)
            await loadMyLineup(matchup, selectedDate)
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setActivationOverflowSaving(false)
        }
    }

    async function handleOverflowMoveToIR(moveRosterPlayerId: string) {
        if (!activationOverflowPending || !matchup) return
        setActivationOverflowSaving(true)
        try {
            await toggleIR(moveRosterPlayerId, true)
            await activatePending()
            setActivationOverflowPending(null)
            await loadMyLineup(matchup, selectedDate)
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setActivationOverflowSaving(false)
        }
    }

    async function handleOverflowMoveToTaxi(moveRosterPlayerId: string) {
        if (!activationOverflowPending || !matchup) return
        setActivationOverflowSaving(true)
        try {
            await toggleTaxi(moveRosterPlayerId, true)
            await activatePending()
            setActivationOverflowPending(null)
            await loadMyLineup(matchup, selectedDate)
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setActivationOverflowSaving(false)
        }
    }

    async function doAutoSet(date: string | null, restOfSeason?: boolean) {
        if (!matchup) return
        setAutoSetting(true)
        try {
            await autoSetLineup(
                matchup.myMemberId, league.id, matchup.seasonId,
                matchup.weekNumber, matchup.seasonYear, date, restOfSeason,
            )
            await loadMyLineup(matchup, selectedDate)
            if (restOfSeason) {
                Alert.alert('Done', 'Lineup set for the rest of the season.')
            }
        } catch (e: any) {
            Alert.alert('Auto-set failed', e?.message ?? String(e))
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
