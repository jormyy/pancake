import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { useDraftActivity } from '@/components/league/draft-room/useDraftActivity'
import { acquireJoinableDraft, type Draft } from '@/lib/draft'
import { useLeagueContext } from '@/contexts/league-context'
import { showAlert } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'

type LaunchResult = 'opened' | 'missing' | 'error' | 'stale' | 'deferred'

// The "No active draft" page. It has its own URL so it never collides with the
// auction room at /draft-room.
const NO_DRAFT_ROUTE = '/draft'

export function useDraftRoomLauncher(
    leagueId: string | undefined,
    options: { notifyOnError?: boolean; renderAuctionInline?: boolean; scopeKey?: string } = {},
) {
    const router = useRouter()
    const { current } = useLeagueContext()
    const memberId = options.scopeKey ?? (current?.leagues.id === leagueId ? current?.id : undefined)
    const activity = useDraftActivity(JSON.stringify([leagueId ?? null, memberId ?? null]))
    const { identity: resourceKey, epoch, capture, canRead, isCurrent } = activity
    const pendingRef = useRef<{ key: string; fallbackOnMissing: boolean } | null>(null)
    const activeResourceKeyRef = useRef(resourceKey)
    activeResourceKeyRef.current = resourceKey
    const generationRef = useRef(0)
    const inFlightRef = useRef<{ key: string; epoch: number; promise: Promise<LaunchResult>; release: () => void } | null>(null)
    const [request, setRequest] = useState<{
        key: string
        loading: boolean
        error: string | null
        draft: Draft | null
    } | null>(null)

    useEffect(() => () => { generationRef.current += 1 }, [])
    useEffect(() => () => {
        if (inFlightRef.current?.key === resourceKey && inFlightRef.current.epoch === epoch) {
            inFlightRef.current.release()
            inFlightRef.current = null
        }
    }, [resourceKey, epoch])

    const openDraftRoom = useCallback((launchOptions: { fallbackOnMissing?: boolean } = {}) => {
        const fallbackOnMissing = launchOptions.fallbackOnMissing ?? true
        const capturedKey = resourceKey
        if (activeResourceKeyRef.current !== capturedKey) return Promise.resolve<LaunchResult>('stale')
        if (!canRead()) {
            pendingRef.current = { key: capturedKey, fallbackOnMissing }
            setRequest({ key: capturedKey, loading: true, error: null, draft: null })
            return Promise.resolve<LaunchResult>('deferred')
        }
        if (!leagueId) {
            pendingRef.current = null
            if (fallbackOnMissing && !options.renderAuctionInline) router.push(NO_DRAFT_ROUTE)
            return Promise.resolve<LaunchResult>('missing')
        }
        const readEpoch = capture()
        if (inFlightRef.current?.key === capturedKey && inFlightRef.current.epoch === readEpoch) return inFlightRef.current.promise
        inFlightRef.current?.release()
        pendingRef.current = { key: capturedKey, fallbackOnMissing }

        const generation = ++generationRef.current
        setRequest({ key: capturedKey, loading: true, error: null, draft: null })
        const ownsRequest = () => (
            isCurrent(readEpoch) && activeResourceKeyRef.current === capturedKey
            && generationRef.current === generation
        )
        const read = acquireJoinableDraft(leagueId, { memberId, includeCompletedRookie: true, canRead: ownsRequest })
        const promise = (async (): Promise<LaunchResult> => {
            try {
                const draft = await read.promise
                if (!ownsRequest()) {
                    if (activeResourceKeyRef.current === capturedKey && generationRef.current === generation) pendingRef.current = { key: capturedKey, fallbackOnMissing }
                    return 'stale'
                }
                pendingRef.current = null
                if (!draft) {
                    if (fallbackOnMissing && !options.renderAuctionInline) router.push(NO_DRAFT_ROUTE)
                    return 'missing'
                }
                const pathname = draft.draftType === 'snake'
                    ? '/(modals)/rookie-draft-room'
                    : '/(modals)/draft-room'
                setRequest({ key: capturedKey, loading: false, error: null, draft })
                if (!options.renderAuctionInline || draft.draftType === 'snake') router.push({ pathname, params: { draftId: draft.id } })
                return 'opened'
            } catch (error) {
                if (!ownsRequest()) return 'stale'
                pendingRef.current = null
                const message = getErrorMessage(error)
                setRequest({ key: capturedKey, loading: false, error: message, draft: null })
                if (options.notifyOnError) showAlert('Could not open draft room', message)
                return 'error'
            } finally {
                read.release()
                if (ownsRequest()) {
                    setRequest((current) => current?.key === capturedKey
                        ? { ...current, loading: false }
                        : current)
                }
                if (inFlightRef.current?.key === capturedKey && inFlightRef.current.epoch === readEpoch) inFlightRef.current = null
            }
        })()
        inFlightRef.current = { key: capturedKey, epoch: readEpoch, promise, release: read.release }
        return promise
    }, [leagueId, memberId, resourceKey, options.renderAuctionInline, options.notifyOnError, router, canRead, capture, isCurrent])

    useEffect(() => {
        if (pendingRef.current?.key !== resourceKey) { pendingRef.current = null; return }
        if (canRead() && inFlightRef.current?.epoch !== capture()) void openDraftRoom({ fallbackOnMissing: pendingRef.current.fallbackOnMissing })
    }, [resourceKey, epoch, canRead, openDraftRoom, capture])

    const ownsState = request?.key === resourceKey
    return {
        openDraftRoom,
        draft: ownsState ? request.draft : null,
        draftLoading: ownsState ? request.loading : false,
        draftError: ownsState ? request.error : null,
        draftChecked: Boolean(ownsState && !request.loading),
    }
}
