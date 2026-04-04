import { useState } from 'react'
import { Alert } from 'react-native'
import { Matchup } from '@/lib/scoring'
import { setPlayerSlot, autoSetLineup, canPlaySlot, LineupSlot, LineupPlayer } from '@/lib/lineup'
import { isIREligible, toggleIR, dropPlayer } from '@/lib/roster'
import { todayDateString } from '@/lib/shared/dates'

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[] }
type Sel = { kind: 'starter'; index: number } | { kind: 'bench'; index: number } | { kind: 'ir'; index: number }
type PendingIRActivate = { rosterPlayerId: string }

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
    const [irOverflowPending, setIROverflowPending] = useState<PendingIRActivate | null>(null)
    const [irOverflowSaving, setIROverflowSaving] = useState(false)

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

        const getPlayer = (s: Sel): LineupPlayer | null =>
            s.kind === 'starter' ? starters[s.index]?.player ?? null
            : s.kind === 'bench' ? bench[s.index] ?? null
            : ir[s.index] ?? null
        const getSlot = (s: Sel): string =>
            s.kind === 'starter' ? starters[s.index]?.slotType ?? 'BE'
            : s.kind === 'bench' ? 'BE'
            : 'IR'

        const aPlayer = getPlayer(selected)
        const bPlayer = getPlayer(newSel)
        const aSlot = getSlot(selected)
        const bSlot = getSlot(newSel)

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
                    setIROverflowPending({ rosterPlayerId: irPlayer.rosterPlayerId })
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

    async function handleIROverflowDrop(dropRosterPlayerId: string) {
        if (!irOverflowPending || !matchup) return
        setIROverflowSaving(true)
        try {
            await dropPlayer(dropRosterPlayerId)
            await toggleIR(irOverflowPending.rosterPlayerId, false)
            setIROverflowPending(null)
            await loadMyLineup(matchup, selectedDate)
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setIROverflowSaving(false)
        }
    }

    async function handleIROverflowMoveToIR(moveRosterPlayerId: string) {
        if (!irOverflowPending || !matchup) return
        setIROverflowSaving(true)
        try {
            await toggleIR(moveRosterPlayerId, true)
            await toggleIR(irOverflowPending.rosterPlayerId, false)
            setIROverflowPending(null)
            await loadMyLineup(matchup, selectedDate)
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setIROverflowSaving(false)
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
        irOverflowPending,
        setIROverflowPending,
        irOverflowSaving,
        handleTap,
        handleIROverflowDrop,
        handleIROverflowMoveToIR,
        doAutoSet,
        handleAutoSet,
    }
}
