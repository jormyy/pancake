import { holdPwaUpdate } from '@/lib/pwa-update-guard'
import { clearEditorDraft, readEditorDraft, saveEditorDraft } from '@/lib/editor-draft'
import { isLineupDraft } from '@/lib/lineup-draft'
import { sessionOwner } from '@/lib/session-cache-registry'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
    setPlayerSlotMoves,
    planLineupMove,
    type LineupPlayer,
    type LineupSelection,
    type LineupMoveData,
} from '@/lib/lineup'
import { activateRosterPlayerWithLineup, toggleIR } from '@/lib/roster'
import { todayLeague } from '@/lib/timezone'
import { leagueTimezone } from '@/lib/league-timezones'
// RN's Alert.alert is a silent no-op on web; showAlert/confirmAction route
// through the in-app feedback system on every platform.
import { showAlert } from '@/lib/alert'
import { confirmRosterActivation } from '@/lib/roster-activation-confirm'
import { getErrorMessage } from '@/lib/shared/errors'

type PendingActivation = { rosterPlayerId: string; source: 'ir' | 'taxi'; slotType: string | null }
type LineupActionContext = {
    memberId: string
    leagueId: string
    seasonId: string
    weekNumber: number
    seasonYear: number
}

async function reloadSavedLineup(reload: () => Promise<void>, isCurrent: () => boolean): Promise<boolean> {
    try {
        await reload()
        return true
    } catch {
        if (isCurrent()) showAlert('Lineup saved', 'Your change is saved. Refresh to see the latest lineup.', 'info')
        return false
    }
}

export function useLineupActions({
    actionContext,
    actionOwner = actionContext,
    myLineup,
    league,
    selectedDate,
    startedTeams,
    reloadLineup,
}: {
    actionContext: LineupActionContext | null | undefined
    actionOwner?: Pick<LineupActionContext, 'memberId' | 'leagueId' | 'seasonId'> | null
    myLineup: LineupMoveData | null
    league: { roster_size?: number; taxi_slots?: number; timezone?: string } | null
    selectedDate: string
    startedTeams: Set<string>
    reloadLineup: (date: string) => Promise<void>
}) {
    const [selected, setSelected] = useState<LineupSelection | null>(null)
    const [saving, setSaving] = useState(false)
    const [autoSetModalVisible, setAutoSetModalVisible] = useState(false)
    const [activationOverflowPending, setActivationOverflowPending] = useState<PendingActivation | null>(null)
    const [activationOverflowSaving, setActivationOverflowSaving] = useState(false)
    const ownerIdentity = actionOwner
        ? `${actionOwner.memberId}:${actionOwner.leagueId}:${actionOwner.seasonId}:${selectedDate}`
        : null
    const draftScope = sessionOwner() && ownerIdentity ? `${sessionOwner()}:${ownerIdentity}` : null
    const [draftKind] = useState(() => `lineup:${typeof window === 'undefined' ? 'native' : window.location?.pathname ?? 'native'}`)
    const [restoredScope, setRestoredScope] = useState<string | null>(null)
    const recoveryReady = useRef(false)
    const previousLineup = useRef(myLineup)
    const draftScopeRef = useRef(draftScope)
    draftScopeRef.current = draftScope
    const busy = useRef(false)
    busy.current = saving || autoSetModalVisible || !!activationOverflowPending || activationOverflowSaving || restoredScope !== draftScope
    const canRecover = useCallback(() => recoveryReady.current && !busy.current, [])
    const hasSelection = selected !== null
    useEffect(() => hasSelection ? holdPwaUpdate('lineup selection', canRecover) : undefined, [hasSelection, canRecover])
    useEffect(() => () => { if (draftScopeRef.current) clearEditorDraft(draftKind, draftScopeRef.current) }, [draftKind])
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
        activeOwnerRef.current = ownerIdentity
        mutationGenerationRef.current += 1
        setStateOwnerIdentity(ownerIdentity)
        setSelected(null)
        setSaving(false)
        setAutoSetModalVisible(false)
        setActivationOverflowPending(null)
        setActivationOverflowSaving(false)
        return () => {
            activeOwnerRef.current = null
            mutationGenerationRef.current += 1
        }
    }, [ownerIdentity])

    useEffect(() => {
        recoveryReady.current = false
        const changed = previousLineup.current !== myLineup
        previousLineup.current = myLineup
        if (!draftScope || !myLineup) { if (changed) setSelected(null); return }
        const draft = readEditorDraft(draftKind, draftScope, isLineupDraft)
        if (restoredScope !== draftScope) {
            const player = draft?.selection ? selectionPlayer(myLineup, draft.selection) : null
            setSelected(player && player.playerId === draft?.playerId && (!player.nbaTeam || !startedTeams.has(player.nbaTeam)) ? draft.selection : null)
            setRestoredScope(draftScope)
        } else if (draft?.selection ? selectionPlayer(myLineup, draft.selection)?.playerId !== draft.playerId : changed) setSelected(null)
    }, [myLineup, draftScope, draftKind, restoredScope, startedTeams])
    useEffect(() => {
        if (!draftScope || restoredScope !== draftScope || !myLineup) return
        const player = selected ? selectionPlayer(myLineup, selected) : null
        recoveryReady.current = saveEditorDraft(draftKind, draftScope, { selection: player ? selected : null, playerId: player?.playerId ?? null })
    }, [draftScope, restoredScope, myLineup, selected, draftKind, startedTeams])

    const handleTap = useCallback(async (newSel: LineupSelection) => {
        if (saving) return
        if (selectedDate < todayLeague(league?.timezone ?? leagueTimezone(actionOwner?.leagueId))) {
            showAlert('Past lineup', 'Lineups for past days cannot be changed.', 'info')
            setSelected(null)
            return
        }

        if (!selected) {
            // A player whose game has started can't move anywhere, so explain
            // now instead of selecting him and disabling every other slot.
            const player = myLineup ? selectionPlayer(myLineup, newSel) : null
            if (player?.nbaTeam && startedTeams.has(player.nbaTeam)) {
                showAlert('Lineup locked', `${player.displayName}'s game has already started. No lineup changes are allowed once a game begins.`, 'info')
                return
            }
            setSelected(newSel)
            return
        }
        if (selected.kind === newSel.kind && selected.index === newSel.index) {
            setSelected(null); return
        }
        const releaseUpdate = holdPwaUpdate('lineup interaction')
        try {
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

            const mutationGeneration = mutationGenerationRef.current
            const mutationOwner = ownerIdentity
            const execute = async () => {
                if (!mutationIsCurrent(mutationGeneration, mutationOwner)) return
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
                    if (mutationIsCurrent(mutationGeneration, mutationOwner)) {
                        await reloadSavedLineup(() => reloadLineup(selectedDate), () => mutationIsCurrent(mutationGeneration, mutationOwner))
                    }
                } catch (e) {
                    if (mutationIsCurrent(mutationGeneration, mutationOwner)) showAlert('Error', getErrorMessage(e))
                } finally {
                    if (mutationIsCurrent(mutationGeneration, mutationOwner)) setSaving(false)
                }
            }
            if (plan.kind === 'activate' && plan.activateSource === 'taxi') {
                const reserve = myLineup.taxi?.find(player => player.rosterPlayerId === plan.activateRosterPlayerId)
                if (reserve) confirmRosterActivation({ source: 'taxi', reserveName: reserve.displayName }, execute)
            } else await execute()
        } finally { releaseUpdate() }
    }, [selectedDate, selected, actionContext, actionOwner?.leagueId, myLineup, league, startedTeams, reloadLineup, ownerIdentity, saving])

    async function resolveOverflow(freeAction: 'drop' | 'ir', rosterPlayerId: string) {
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
        const reserve = allPlayers.find(player => player.rosterPlayerId === activationOverflowPending.rosterPlayerId)
        const chosen = allPlayers.find(player => player.rosterPlayerId === rosterPlayerId)
        if (!reserve || !chosen) return
        const mutationGeneration = mutationGenerationRef.current
        const mutationOwner = ownerIdentity
        confirmRosterActivation({
            source: activationOverflowPending.source,
            reserveName: reserve.displayName,
            freeing: { name: chosen.displayName, action: freeAction },
        }, async () => {
            if (!mutationIsCurrent(mutationGeneration, mutationOwner)) return
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
                if (!mutationIsCurrent(mutationGeneration, mutationOwner)) return
                setActivationOverflowPending(null)
                await reloadSavedLineup(() => reloadLineup(selectedDate), () => mutationIsCurrent(mutationGeneration, mutationOwner))
            } catch (e) {
                if (mutationIsCurrent(mutationGeneration, mutationOwner)) showAlert('Error', getErrorMessage(e))
            } finally {
                if (mutationIsCurrent(mutationGeneration, mutationOwner)) setActivationOverflowSaving(false)
            }
        })
    }

    const handleOverflowDrop = (id: string) => resolveOverflow('drop', id)
    const handleOverflowMoveToIR = (id: string) => resolveOverflow('ir', id)

    function handleAutoSet() {
        setAutoSetModalVisible(true)
    }

    return {
        canRecover,
        selected: ownsActionState ? selected : null,
        setSelected,
        saving: ownsActionState ? saving : false,
        autoSetModalVisible: ownsActionState ? autoSetModalVisible : false,
        setAutoSetModalVisible,
        activationOverflowPending: ownsActionState ? activationOverflowPending : null,
        setActivationOverflowPending,
        activationOverflowSaving: ownsActionState ? activationOverflowSaving : false,
        handleTap,
        handleOverflowDrop,
        handleOverflowMoveToIR,
        handleAutoSet,
    }
}

function selectionPlayer(lineup: LineupMoveData, selection: LineupSelection): LineupPlayer | null {
    if (selection.kind === 'starter') return lineup.starters[selection.index]?.player ?? null
    if (selection.kind === 'bench') return lineup.bench[selection.index] ?? null
    if (selection.kind === 'ir') return lineup.ir?.[selection.index] ?? null
    return lineup.taxi?.[selection.index] ?? null
}
