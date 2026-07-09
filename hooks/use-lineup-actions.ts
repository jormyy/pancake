import { useCallback, useState } from 'react'
import { Alert } from 'react-native'
import {
    setPlayerSlotMoves,
    autoSetLineup,
    planLineupMove,
    type LineupSlot,
    type LineupPlayer,
    type LineupSelection,
} from '@/lib/lineup'
import { activateRosterPlayerWithLineup, toggleIR, toggleTaxi } from '@/lib/roster'
import { todayET } from '@/lib/shared/dates'
import { getErrorMessage } from '@/lib/alert'

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir?: LineupPlayer[]; taxi?: LineupPlayer[] }
type Sel = LineupSelection
type PendingActivation = { rosterPlayerId: string; source: 'ir' | 'taxi'; slotType: string | null }
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

        const plan = planLineupMove({
            lineup: myLineup,
            league,
            startedTeams,
            from: selected,
            to: newSel,
        })

        if (plan.kind === 'invalid') {
            Alert.alert(plan.title, plan.message)
            return
        }

        if (plan.kind === 'overflow') {
            setActivationOverflowPending({
                rosterPlayerId: plan.rosterPlayerId,
                source: plan.source,
                slotType: plan.slotType,
            })
            return
        }

        setSaving(true)
        try {
            if (plan.kind === 'activate') {
                await activateRosterPlayerWithLineup({
                    activateRosterPlayerId: plan.activateRosterPlayerId,
                    activateSource: plan.activateSource,
                    freeRosterPlayerId: plan.freeRosterPlayerId,
                    freeAction: plan.freeAction,
                    memberId: actionContext.memberId,
                    leagueId: actionContext.leagueId,
                    seasonId: actionContext.seasonId,
                    gameDate: selectedDate,
                    weekNumber: actionContext.weekNumber,
                    slotType: plan.slotType,
                })
            } else if (plan.kind === 'toggle-ir') {
                await toggleIR(plan.rosterPlayerId, true)
            } else if (plan.kind === 'toggle-taxi') {
                await toggleTaxi(plan.rosterPlayerId, true)
            } else {
                await setPlayerSlotMoves(
                    {
                        memberId: actionContext.memberId,
                        leagueId: actionContext.leagueId,
                        seasonId: actionContext.seasonId,
                        weekNumber: actionContext.weekNumber,
                        gameDate: selectedDate,
                    },
                    plan.moves,
                )
            }
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
            await activateRosterPlayerWithLineup({
                activateRosterPlayerId: activationOverflowPending.rosterPlayerId,
                activateSource: activationOverflowPending.source,
                freeRosterPlayerId: rosterPlayerId,
                freeAction,
                memberId: actionContext.memberId,
                leagueId: actionContext.leagueId,
                seasonId: actionContext.seasonId,
                gameDate: selectedDate,
                weekNumber: actionContext.weekNumber,
                slotType: activationOverflowPending.slotType,
            })
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
