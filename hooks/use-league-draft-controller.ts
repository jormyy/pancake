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
    const requestSequence = useRef(0)
    const inFlightRequest = useRef<{ leagueId: string; promise: Promise<void> } | null>(null)
    const refreshQueued = useRef(false)
    activeLeagueIdRef.current = leagueId
    const [draftLoading, setDraftLoading] = useState(false)
    const [nominationMode, setNominationMode] = useState<NominationOrderMode>('user_nominated')
    const [draftTimerSeconds, setDraftTimerSecondsState] = useState<DraftTimerOption>(30)
    const [rookieRounds, setRookieRounds] = useState<RookieRoundOption>(3)
    const [rookieTimerExpiryBehavior, setRookieTimerExpiryBehavior] =
        useState<RookieTimerExpiryBehavior>('auto_pick')
    const [activeDraft, setActiveDraft] = useState<Draft | null>(null)
    const [activeDraftLoading, setActiveDraftLoading] = useState(true)
    const [activeDraftError, setActiveDraftError] = useState<string | null>(null)

    useEffect(() => {
        requestSequence.current += 1
        inFlightRequest.current = null
        refreshQueued.current = false
        setActiveDraft(null)
        setActiveDraftError(null)
        setActiveDraftLoading(Boolean(leagueId))
    }, [leagueId])

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
        confirmAction(
            'Start Auction Draft?',
            `This will begin the auction draft for all teams with a ${draftTimerSeconds}-second timer and ${NOMINATION_ORDER_MODE_LABELS[nominationMode].toLowerCase()} nomination order. This cannot be undone.`,
            async () => {
                setDraftLoading(true)
                try {
                    const draft = await startDraft(leagueId, nominationMode, {
                        isMock: false,
                        timerSeconds: draftTimerSeconds,
                    })
                    openDraftRoom(draft.id, draft.draftType)
                } catch (error) {
                    showAlert('Could not start draft', error instanceof Error ? error.message : undefined)
                } finally {
                    setDraftLoading(false)
                }
            },
            'Start Auction',
        )
    }

    const handleJoinDraftRoom = async () => {
        if (!leagueId) return
        setDraftLoading(true)
        try {
            const draft = activeDraft ?? await getJoinableDraft(leagueId, { includeCompletedRookie: true })
            if (!draft || (!OPEN_DRAFT_STATUSES.has(draft.status) && draft.status !== 'completed')) {
                setActiveDraft(null)
                showAlert('No active draft found')
                return
            }
            openDraftRoom(draft.id, draft.draftType)
        } catch (error) {
            showAlert('Error', error instanceof Error ? error.message : undefined)
        } finally {
            setDraftLoading(false)
        }
    }

    const handleStartRookieDraft = async () => {
        if (!leagueId) return
        confirmAction(
            'Start Rookie Draft?',
            `This will begin the rookie snake draft for ${rookieRounds} rounds with a ${draftTimerSeconds}-second timer and ${ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS[rookieTimerExpiryBehavior].toLowerCase()} timeout behavior. This cannot be undone.`,
            async () => {
                setDraftLoading(true)
                try {
                    const result = await startRookieDraft(leagueId, {
                        isMock: false,
                        timerSeconds: draftTimerSeconds,
                        rounds: rookieRounds,
                        timerExpiryBehavior: rookieTimerExpiryBehavior,
                    })
                    openDraftRoom(result.draft.id, result.draft.draftType)
                } catch (error) {
                    showAlert('Could not start rookie draft', error instanceof Error ? error.message : undefined)
                } finally {
                    setDraftLoading(false)
                }
            },
            'Start Rookie',
        )
    }

    const handleReseedRookiePicks = async () => {
        if (!leagueId) return
        setDraftLoading(true)
        try {
            const draft = await getActiveRookieDraft(leagueId)
            if (!draft) {
                showAlert('No active rookie draft found')
                return
            }
            await reseedRookieDraftPicks(draft.id)
            showAlert('Done', 'Pick slots updated to reflect traded picks.')
        } catch (error) {
            showAlert('Error', error instanceof Error ? error.message : undefined)
        } finally {
            setDraftLoading(false)
        }
    }

    return {
        activeDraft,
        activeDraftError,
        activeDraftLoading,
        draftLoading,
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
