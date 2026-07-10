import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useRouter } from 'expo-router'
import {
    getJoinableDraft,
    NOMINATION_ORDER_MODE_LABELS,
    ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS,
    startDraft,
    type Draft,
    type NominationOrderMode,
    type RookieTimerExpiryBehavior,
} from '@/lib/draft'
import { getActiveRookieDraft, reseedRookieDraftPicks, startRookieDraft } from '@/lib/rookieDraft'
import { confirmAction, showAlert } from '@/lib/alert'
import { normalizeDraftTimerSeconds, type DraftTimerOption, type RookieRoundOption } from '@/lib/draft-options'

const OPEN_DRAFT_STATUSES = new Set(['pending', 'in_progress', 'paused'])

export function useLeagueDraftController(leagueId: string | undefined) {
    const { push } = useRouter()
    const activeLeagueIdRef = useRef(leagueId)
    const renderedLeagueIdRef = useRef(leagueId)
    const mutationGenerationRef = useRef(0)
    const requestSequence = useRef(0)
    const inFlightRequest = useRef<{ leagueId: string; promise: Promise<void> } | null>(null)
    const refreshQueued = useRef(false)
    activeLeagueIdRef.current = leagueId
    if (renderedLeagueIdRef.current !== leagueId) {
        renderedLeagueIdRef.current = leagueId
        mutationGenerationRef.current += 1
    }
    const [draftLoadingOwner, setDraftLoadingOwner] = useState<string | null>(null)
    const [nominationMode, setNominationMode] = useState<NominationOrderMode>('user_nominated')
    const [draftTimerSeconds, setDraftTimerSecondsState] = useState<DraftTimerOption>(30)
    const [rookieRounds, setRookieRounds] = useState<RookieRoundOption>(3)
    const [rookieTimerExpiryBehavior, setRookieTimerExpiryBehavior] =
        useState<RookieTimerExpiryBehavior>('auto_pick')
    const [activeDraft, setActiveDraft] = useState<Draft | null>(null)
    const [activeDraftLoading, setActiveDraftLoading] = useState(true)
    // True once the first status fetch for this league has resolved, so
    // panels can wait for it and never flash loading UI on later refreshes.
    const [activeDraftLoaded, setActiveDraftLoaded] = useState(false)
    const [activeDraftError, setActiveDraftError] = useState<string | null>(null)

    useEffect(() => {
        requestSequence.current += 1
        inFlightRequest.current = null
        refreshQueued.current = false
        setActiveDraft(null)
        setActiveDraftError(null)
        setActiveDraftLoading(Boolean(leagueId))
        setActiveDraftLoaded(false)
        setDraftLoadingOwner(null)
    }, [leagueId])

    const ownsAction = useCallback((capturedLeagueId: string, generation: number) => (
        activeLeagueIdRef.current === capturedLeagueId && mutationGenerationRef.current === generation
    ), [])

    const fetchActiveDraft = useCallback((lid: string): Promise<void> => {
        const existing = inFlightRequest.current
        if (existing?.leagueId === lid) {
            refreshQueued.current = true
            return existing.promise
        }
        const requestId = ++requestSequence.current
        const request = { leagueId: lid, promise: Promise.resolve() }
        setActiveDraftLoading(true)
        request.promise = getJoinableDraft(lid, { includeCompletedRookie: true })
            .then((nextDraft) => {
                if (activeLeagueIdRef.current !== lid || requestSequence.current !== requestId) return
                setActiveDraft(nextDraft)
                setActiveDraftError(null)
            })
            .catch((error: unknown) => {
                if (activeLeagueIdRef.current !== lid || requestSequence.current !== requestId) return
                setActiveDraftError(error instanceof Error ? error.message : 'Could not load active draft')
            })
            .finally(() => {
                if (inFlightRequest.current !== request) return
                inFlightRequest.current = null
                if (activeLeagueIdRef.current !== lid || requestSequence.current !== requestId) return
                setActiveDraftLoaded(true)
                if (refreshQueued.current) {
                    refreshQueued.current = false
                    void fetchActiveDraft(lid)
                } else {
                    setActiveDraftLoading(false)
                }
            })
        inFlightRequest.current = request
        return request.promise
    }, [])

    useFocusEffect(useCallback(() => {
        if (leagueId) void fetchActiveDraft(leagueId)
    }, [fetchActiveDraft, leagueId]))

    const openDraftRoom = useCallback((draftId: string, draftType: string) => {
        push({
            pathname: draftType === 'snake' ? '/(modals)/rookie-draft-room' : '/(modals)/draft-room',
            params: { draftId },
        })
    }, [push])

    const handleStartDraft = async () => {
        if (!leagueId) return
        const capturedLeagueId = leagueId
        const generation = mutationGenerationRef.current
        confirmAction(
            'Start Auction Draft?',
            `This will begin the auction draft for all teams with a ${draftTimerSeconds}-second timer and ${NOMINATION_ORDER_MODE_LABELS[nominationMode].toLowerCase()} nomination order. This cannot be undone.`,
            async () => {
                if (!ownsAction(capturedLeagueId, generation)) return
                setDraftLoadingOwner(capturedLeagueId)
                try {
                    const draft = await startDraft(capturedLeagueId, nominationMode, {
                        isMock: false,
                        timerSeconds: draftTimerSeconds,
                    })
                    if (ownsAction(capturedLeagueId, generation)) openDraftRoom(draft.id, draft.draftType)
                } catch (error) {
                    if (ownsAction(capturedLeagueId, generation)) {
                        showAlert('Could not start draft', error instanceof Error ? error.message : undefined)
                    }
                } finally {
                    if (ownsAction(capturedLeagueId, generation)) setDraftLoadingOwner(null)
                }
            },
            'Start Auction',
        )
    }

    const handleJoinDraftRoom = async () => {
        if (!leagueId) return
        const capturedLeagueId = leagueId
        const generation = mutationGenerationRef.current
        setDraftLoadingOwner(capturedLeagueId)
        try {
            const draft = activeDraft?.leagueId === capturedLeagueId
                ? activeDraft
                : await getJoinableDraft(capturedLeagueId, { includeCompletedRookie: true })
            if (!ownsAction(capturedLeagueId, generation)) return
            if (!draft || (!OPEN_DRAFT_STATUSES.has(draft.status) && draft.status !== 'completed')) {
                setActiveDraft(null)
                showAlert('No active draft found')
                return
            }
            openDraftRoom(draft.id, draft.draftType)
        } catch (error) {
            if (ownsAction(capturedLeagueId, generation)) {
                showAlert('Error', error instanceof Error ? error.message : undefined)
            }
        } finally {
            if (ownsAction(capturedLeagueId, generation)) setDraftLoadingOwner(null)
        }
    }

    const handleStartRookieDraft = async () => {
        if (!leagueId) return
        const capturedLeagueId = leagueId
        const generation = mutationGenerationRef.current
        confirmAction(
            'Start Rookie Draft?',
            `This will begin the rookie snake draft for ${rookieRounds} rounds with a ${draftTimerSeconds}-second timer and ${ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS[rookieTimerExpiryBehavior].toLowerCase()} timeout behavior. This cannot be undone.`,
            async () => {
                if (!ownsAction(capturedLeagueId, generation)) return
                setDraftLoadingOwner(capturedLeagueId)
                try {
                    const result = await startRookieDraft(capturedLeagueId, {
                        isMock: false,
                        timerSeconds: draftTimerSeconds,
                        rounds: rookieRounds,
                        timerExpiryBehavior: rookieTimerExpiryBehavior,
                    })
                    if (ownsAction(capturedLeagueId, generation)) {
                        openDraftRoom(result.draft.id, result.draft.draftType)
                    }
                } catch (error) {
                    if (ownsAction(capturedLeagueId, generation)) {
                        showAlert('Could not start rookie draft', error instanceof Error ? error.message : undefined)
                    }
                } finally {
                    if (ownsAction(capturedLeagueId, generation)) setDraftLoadingOwner(null)
                }
            },
            'Start Rookie',
        )
    }

    const handleReseedRookiePicks = async () => {
        if (!leagueId) return
        const capturedLeagueId = leagueId
        const generation = mutationGenerationRef.current
        setDraftLoadingOwner(capturedLeagueId)
        try {
            const draft = await getActiveRookieDraft(capturedLeagueId)
            if (!ownsAction(capturedLeagueId, generation)) return
            if (!draft) {
                showAlert('No active rookie draft found')
                return
            }
            await reseedRookieDraftPicks(draft.id)
            if (ownsAction(capturedLeagueId, generation)) {
                showAlert('Done', 'Pick slots updated to reflect traded picks.')
            }
        } catch (error) {
            if (ownsAction(capturedLeagueId, generation)) {
                showAlert('Error', error instanceof Error ? error.message : undefined)
            }
        } finally {
            if (ownsAction(capturedLeagueId, generation)) setDraftLoadingOwner(null)
        }
    }

    return {
        activeDraft,
        activeDraftError,
        activeDraftLoading,
        activeDraftLoaded,
        draftLoading: draftLoadingOwner === leagueId,
        draftTimerSeconds,
        fetchActiveDraft,
        handleJoinDraftRoom,
        handleReseedRookiePicks,
        handleStartDraft,
        handleStartRookieDraft,
        nominationMode,
        openDraftRoom,
        retryActiveDraft: () => leagueId && fetchActiveDraft(leagueId),
        rookieRounds,
        rookieTimerExpiryBehavior,
        setDraftTimerSeconds: (value: DraftTimerOption) => setDraftTimerSecondsState(normalizeDraftTimerSeconds(value)),
        setNominationMode,
        setRookieRounds,
        setRookieTimerExpiryBehavior,
    }
}
