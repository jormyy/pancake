import { useCallback, useEffect, useRef, useState } from 'react'
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
// RN's Alert.alert is a silent no-op on web; showAlert/confirmAction route
// through the in-app feedback system on every platform.
import { confirmAction, showAlert, showSuccess } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'

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
    const ownerIdentity = actionContext
        ? `${actionContext.memberId}:${actionContext.leagueId}:${actionContext.seasonId}:${selectedDate}`
        : null
    const renderedOwnerRef = useRef(ownerIdentity)
    const activeOwnerRef = useRef(ownerIdentity)
    const mutationGenerationRef = useRef(0)
    const [stateOwnerIdentity, setStateOwnerIdentity] = useState(ownerIdentity)
    activeOwnerRef.current = ownerIdentity
    if (renderedOwnerRef.current !== ownerIdentity) {
        renderedOwnerRef.current = ownerIdentity
        mutationGenerationRef.current += 1
    }
    const ownsActionState = stateOwnerIdentity === ownerIdentity
    const mutationIsCurrent = (generation: number, identity: string | null) =>
        mutationGenerationRef.current === generation && activeOwnerRef.current === identity

    useEffect(() => {
        mutationGenerationRef.current += 1
        setStateOwnerIdentity(ownerIdentity)
        setSelected(null)
        setSaving(false)
        setAutoSetting(false)
        setAutoSetModalVisible(false)
        setActivationOverflowPending(null)
        setActivationOverflowSaving(false)
    }, [ownerIdentity])

    const handleTap = useCallback(async (newSel: Sel) => {
        if (selectedDate < todayET()) {
            showAlert('Past lineup', 'Lineups for past days cannot be changed.', 'info')
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
            showAlert(plan.title, plan.message, 'info')
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
        const mutationGeneration = mutationGenerationRef.current
        const mutationOwner = ownerIdentity
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
            if (mutationIsCurrent(mutationGeneration, mutationOwner)) await reloadLineup(selectedDate)
        } catch (e) {
            if (mutationIsCurrent(mutationGeneration, mutationOwner)) showAlert('Error', getErrorMessage(e))
        } finally {
            if (mutationIsCurrent(mutationGeneration, mutationOwner)) setSaving(false)
        }
    }, [selectedDate, selected, actionContext, myLineup, league, startedTeams, reloadLineup, ownerIdentity])

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
            showAlert('Lineup locked', `${lockedPlayer.displayName}'s game has already started. No lineup changes are allowed once a game begins.`, 'info')
            return
        }
        setActivationOverflowSaving(true)
        const mutationGeneration = mutationGenerationRef.current
        const mutationOwner = ownerIdentity
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
            if (!mutationIsCurrent(mutationGeneration, mutationOwner)) return
            setActivationOverflowPending(null)
            await reloadLineup(selectedDate)
        } catch (e) {
            if (mutationIsCurrent(mutationGeneration, mutationOwner)) showAlert('Error', getErrorMessage(e))
        } finally {
            if (mutationIsCurrent(mutationGeneration, mutationOwner)) setActivationOverflowSaving(false)
        }
    }

    const handleOverflowDrop = (id: string) => resolveOverflow('drop', id)
    const handleOverflowMoveToIR = (id: string) => resolveOverflow('ir', id)
    const handleOverflowMoveToTaxi = (id: string) => resolveOverflow('taxi', id)

    async function doAutoSet(date: string | null, restOfSeason?: boolean) {
        if (!actionContext || !league) return
        setAutoSetting(true)
        const mutationGeneration = mutationGenerationRef.current
        const mutationOwner = ownerIdentity
        try {
            const result = await autoSetLineup(
                actionContext.memberId, actionContext.leagueId, actionContext.seasonId,
                actionContext.weekNumber, actionContext.seasonYear, date, restOfSeason,
            )
            if (!mutationIsCurrent(mutationGeneration, mutationOwner)) return
            await reloadLineup(selectedDate)
            if (restOfSeason && result?.failed) {
                confirmAction(
                    'Lineup partly optimized',
                    `Optimized ${result.optimized} of ${result.dates} dates; ${result.failed} failed.`,
                    () => { void doAutoSet(null, true) },
                    'Retry failed dates',
                    false,
                )
            } else if (restOfSeason && result && result.dates === 0) {
                showAlert('Season is over', 'There are no remaining dates this season to optimize.', 'info')
            } else if (restOfSeason) {
                showSuccess('Done', 'Lineup set for the rest of the season.')
            }
        } catch (e) {
            if (mutationIsCurrent(mutationGeneration, mutationOwner)) {
                showAlert('Auto-set failed', getErrorMessage(e) ?? String(e))
            }
        } finally {
            if (mutationIsCurrent(mutationGeneration, mutationOwner)) setAutoSetting(false)
        }
    }

    function handleAutoSet() {
        setAutoSetModalVisible(true)
    }

    return {
        selected: ownsActionState ? selected : null,
        setSelected,
        saving: ownsActionState ? saving : false,
        autoSetting: ownsActionState ? autoSetting : false,
        autoSetModalVisible: ownsActionState ? autoSetModalVisible : false,
        setAutoSetModalVisible,
        activationOverflowPending: ownsActionState ? activationOverflowPending : null,
        setActivationOverflowPending,
        activationOverflowSaving: ownsActionState ? activationOverflowSaving : false,
        handleTap,
        handleOverflowDrop,
        handleOverflowMoveToIR,
        handleOverflowMoveToTaxi,
        doAutoSet,
        handleAutoSet,
    }
}
