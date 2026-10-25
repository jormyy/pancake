import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useRouter } from 'expo-router'
import {
    acquireJoinableDraft,
    NOMINATION_ORDER_MODE_LABELS,
    ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS,
    startDraft,
    type Draft,
    type NominationOrderMode,
    type RookieTimerExpiryBehavior,
} from '@/lib/draft'
import { getActiveRookieDraft, getRookieStartWarning, reseedRookieDraftPicks, startRookieDraft } from '@/lib/rookieDraft'
import { confirmAction, showAlert, showSuccess } from '@/lib/alert'
import { formatDraftDuration, normalizeDraftTimerSeconds, type DraftTimerOption, type RookieRoundOption } from '@/lib/draft-options'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

const OPEN_DRAFT_STATUSES = new Set(['pending', 'in_progress', 'paused'])

// Persistent cache so draft-status-gated panels (Auctions, Draft Board)
// render instantly on revisit while the fresh status fetch updates in place.
// null is a valid cached status (no joinable draft), hence the wrapper.
const ACTIVE_DRAFT_CACHE_PREFIX = 'pancake:active-draft:v1:'
type ActiveDraftCacheEntry = { draft: Draft | null }
const readActiveDraftCache = (leagueId: string) =>
    readPersistentCache<ActiveDraftCacheEntry>(`${ACTIVE_DRAFT_CACHE_PREFIX}${leagueId}`) ?? undefined
const writeActiveDraftCache = (leagueId: string, draft: Draft | null) =>
    writePersistentCache<ActiveDraftCacheEntry>(`${ACTIVE_DRAFT_CACHE_PREFIX}${leagueId}`, { draft })

export function useLeagueDraftController(leagueId: string | undefined, options: { memberId?: string; authorized?: boolean } = {}) {
    const { push } = useRouter()
    const activity = useBrowserReadActivity()
    const focused = useRef(false)
    const owner = sessionOwner()
    const ownerGeneration = sessionGeneration()
    const resourceKey = JSON.stringify([owner, ownerGeneration, leagueId, options.memberId])
    const activeResource = useRef(resourceKey)
    activeResource.current = resourceKey
    const admission = () => focused.current && options.authorized !== false && owner != null
        && sessionOwner() === owner && sessionGeneration() === ownerGeneration
        && activity.isCurrent(activity.revision) && activeResource.current === resourceKey
    const admissionRef = useRef(admission)
    admissionRef.current = admission
    const activeLeagueIdRef = useRef(leagueId)
    const activeMemberIdRef = useRef(options.memberId)
    activeMemberIdRef.current = options.memberId
    const renderedLeagueIdRef = useRef(resourceKey)
    const mutationGenerationRef = useRef(0)
    const requestSequence = useRef(0)
    const inFlightRequest = useRef<{ leagueId: string; promise: Promise<void>; release: () => void } | null>(null)
    const pendingJoinReads = useRef(new Set<() => void>())
    const refreshQueued = useRef(false)
    activeLeagueIdRef.current = leagueId
    if (renderedLeagueIdRef.current !== resourceKey) {
        renderedLeagueIdRef.current = resourceKey
        mutationGenerationRef.current += 1
    }
    const [draftLoadingOwner, setDraftLoadingOwner] = useState<string | null>(null)
    const [nominationMode, setNominationMode] = useState<NominationOrderMode>('user_nominated')
    const [draftTimerSeconds, setDraftTimerSecondsState] = useState<DraftTimerOption>(60)
    const [rookieRounds, setRookieRounds] = useState<RookieRoundOption>(3)
    const [rookieTimerExpiryBehavior, setRookieTimerExpiryBehavior] =
        useState<RookieTimerExpiryBehavior>('auto_pick')
    const initialCached = leagueId ? readActiveDraftCache(resourceKey) : undefined
    const [draftOwnerKey, setDraftOwnerKey] = useState(resourceKey)
    const [activeDraft, setActiveDraft] = useState<Draft | null>(initialCached?.draft ?? null)
    const [activeDraftLoading, setActiveDraftLoading] = useState(true)
    // True once the first status fetch for this league has resolved (or the
    // persistent cache answered), so panels can render immediately and never
    // flash loading UI on later refreshes.
    const [activeDraftLoaded, setActiveDraftLoaded] = useState(initialCached !== undefined)
    const [activeDraftError, setActiveDraftError] = useState<string | null>(null)

    const releasePendingReads = useCallback(() => {
        inFlightRequest.current?.release()
        for (const release of pendingJoinReads.current) release()
        pendingJoinReads.current.clear()
    }, [])

    useEffect(() => {
        requestSequence.current += 1
        releasePendingReads()
        inFlightRequest.current = null
        refreshQueued.current = false
        setDraftOwnerKey(resourceKey)
        const cached = leagueId ? readActiveDraftCache(resourceKey) : undefined
        setActiveDraft(cached?.draft ?? null)
        setActiveDraftError(null)
        setActiveDraftLoading(Boolean(leagueId))
        setActiveDraftLoaded(cached !== undefined)
        setDraftLoadingOwner(null)
    }, [leagueId, resourceKey, releasePendingReads])

    const ownsAction = useCallback((capturedLeagueId: string, generation: number) => (
        admissionRef.current() && activeLeagueIdRef.current === capturedLeagueId && mutationGenerationRef.current === generation
    ), [])

    const fetchActiveDraft = useCallback((lid: string): Promise<void> => {
        if (activeLeagueIdRef.current !== lid) return Promise.resolve()
        if (!admissionRef.current()) { refreshQueued.current = true; return Promise.resolve() }
        const permits = admissionRef.current
        const key = activeResource.current
        const existing = inFlightRequest.current
        if (existing?.leagueId === lid) {
            refreshQueued.current = true
            return existing.promise
        }
        refreshQueued.current = false
        const requestId = ++requestSequence.current
        const canRead = () => activeLeagueIdRef.current === lid && requestSequence.current === requestId
            && activeResource.current === key && permits() && admissionRef.current()
        const read = acquireJoinableDraft(lid, { memberId: activeMemberIdRef.current, includeCompletedRookie: true, canRead })
        const request = { leagueId: lid, promise: Promise.resolve(), release: read.release }
        setActiveDraftLoading(true)
        request.promise = read.promise
            .then((nextDraft) => {
                if (!canRead()) return
                writeActiveDraftCache(key, nextDraft)
                setActiveDraft(nextDraft)
                setActiveDraftError(null)
            })
            .catch((error: unknown) => {
                if (!canRead()) return
                setActiveDraftError(error instanceof Error ? error.message : 'Could not load active draft')
            })
            .finally(() => {
                request.release()
                if (inFlightRequest.current !== request) return
                inFlightRequest.current = null
                if (!canRead()) return
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

    const suspend = useCallback(() => {
        if (inFlightRequest.current || pendingJoinReads.current.size) refreshQueued.current = true
        requestSequence.current += 1
        if (pendingJoinReads.current.size) setDraftLoadingOwner(null)
        releasePendingReads()
        inFlightRequest.current = null
        setActiveDraftLoading(false)
    }, [releasePendingReads])

    useFocusEffect(useCallback(() => {
        focused.current = true
        if (leagueId && activeResource.current === resourceKey) void fetchActiveDraft(leagueId)
        return () => { focused.current = false; suspend() }
    }, [fetchActiveDraft, leagueId, resourceKey, suspend]))

    useEffect(() => {
        if (!admissionRef.current()) suspend()
        else if (leagueId && refreshQueued.current) void fetchActiveDraft(leagueId)
    }, [activity.revision, options.authorized, leagueId, fetchActiveDraft, suspend])

    const openDraftRoom = useCallback((draftId: string, draftType: string) => {
        push({
            pathname: draftType === 'snake' ? '/(modals)/rookie-draft-room' : '/(modals)/draft-room',
            params: { draftId },
        })
    }, [push])

    const handleStartDraft = async () => {
        if (!leagueId || !admissionRef.current()) return
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
        if (!leagueId || !admissionRef.current()) return
        const capturedLeagueId = leagueId
        const generation = mutationGenerationRef.current
        const permits = admissionRef.current
        let released = false
        const canRead = () => !released && permits() && ownsAction(capturedLeagueId, generation)
        const read = acquireJoinableDraft(capturedLeagueId, { memberId: options.memberId, includeCompletedRookie: true, canRead })
        const release = () => {
            released = true
            read.release()
            pendingJoinReads.current.delete(release)
        }
        pendingJoinReads.current.add(release)
        setDraftLoadingOwner(capturedLeagueId)
        try {
            const draft = await read.promise
            if (!canRead()) return
            if (!draft || (!OPEN_DRAFT_STATUSES.has(draft.status) && draft.status !== 'completed')) {
                setActiveDraft(null)
                showAlert('No active draft found')
                return
            }
            openDraftRoom(draft.id, draft.draftType)
        } catch (error) {
            if (canRead()) {
                showAlert('Error', error instanceof Error ? error.message : undefined)
            }
        } finally {
            if (canRead()) setDraftLoadingOwner(null)
            release()
        }
    }

    const handleStartRookieDraft = async () => {
        if (!leagueId || !admissionRef.current()) return
        const capturedLeagueId = leagueId
        const generation = mutationGenerationRef.current
        const selectedOptions = { isMock: false, timerSeconds: draftTimerSeconds, rounds: rookieRounds, timerExpiryBehavior: rookieTimerExpiryBehavior }
        setDraftLoadingOwner(capturedLeagueId)
        try {
            const warning = await getRookieStartWarning(capturedLeagueId, selectedOptions)
            if (!ownsAction(capturedLeagueId, generation)) return
            const warningText = warning.code === 'opening_night_unpublished'
                ? 'Opening night is not published yet. Its completion cutoff is unknown.'
                : warning.code === 'opening_night_overrun'
                    ? `This draft could run past opening night. Unfinished picks will be auto-picked at ${new Date(warning.openingNightCutoff!).toLocaleString()}.`
                    : 'Unfinished picks will be auto-picked at 09:00 Eastern on opening day.'
            confirmAction(
                'Start Rookie Draft?',
                `${rookieRounds} rounds · ${formatDraftDuration(draftTimerSeconds)} per pick · ${ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS[rookieTimerExpiryBehavior]}. ${warningText}`,
                async () => {
                    if (!ownsAction(capturedLeagueId, generation)) return
                    setDraftLoadingOwner(capturedLeagueId)
                    try {
                        const result = await startRookieDraft(capturedLeagueId, selectedOptions)
                        if (ownsAction(capturedLeagueId, generation)) openDraftRoom(result.draft.id, result.draft.draftType)
                    } catch (error) {
                        if (ownsAction(capturedLeagueId, generation)) showAlert('Could not start rookie draft', error instanceof Error ? error.message : undefined)
                    } finally {
                        if (ownsAction(capturedLeagueId, generation)) setDraftLoadingOwner(null)
                    }
                },
                'Start Rookie',
            )
        } catch (error) {
            if (ownsAction(capturedLeagueId, generation)) showAlert('Could not check opening night', error instanceof Error ? error.message : undefined)
        } finally {
            if (ownsAction(capturedLeagueId, generation)) setDraftLoadingOwner(null)
        }
    }

    const handleReseedRookiePicks = async () => {
        if (!leagueId || !admissionRef.current()) return
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
                showSuccess('Done', 'Pick slots updated to reflect traded picks.')
            }
        } catch (error) {
            if (ownsAction(capturedLeagueId, generation)) {
                showAlert('Error', error instanceof Error ? error.message : undefined)
            }
        } finally {
            if (ownsAction(capturedLeagueId, generation)) setDraftLoadingOwner(null)
        }
    }

    const ownsState = draftOwnerKey === resourceKey
    return {
        activeDraft: ownsState ? activeDraft : null,
        activeDraftError: ownsState ? activeDraftError : null,
        activeDraftLoading: ownsState ? activeDraftLoading : Boolean(leagueId),
        activeDraftLoaded: ownsState && activeDraftLoaded,
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
