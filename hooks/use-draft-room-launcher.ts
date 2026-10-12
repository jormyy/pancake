import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { getJoinableDraft, type Draft } from '@/lib/draft'
import { showAlert } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'

type LaunchResult = 'opened' | 'missing' | 'error' | 'stale'

// The "No active draft" page. It has its own URL so it never collides with the
// auction room at /draft-room.
const NO_DRAFT_ROUTE = '/draft'

export function useDraftRoomLauncher(
    leagueId: string | undefined,
    options: { notifyOnError?: boolean; renderAuctionInline?: boolean; scopeKey?: string } = {},
) {
    const router = useRouter()
    const resourceKey = leagueId ? JSON.stringify([leagueId, options.scopeKey ?? null]) : null
    const activeResourceKeyRef = useRef(resourceKey)
    activeResourceKeyRef.current = resourceKey
    const generationRef = useRef(0)
    const inFlightRef = useRef<{ key: string; promise: Promise<LaunchResult> } | null>(null)
    const [request, setRequest] = useState<{
        key: string
        loading: boolean
        error: string | null
        draft: Draft | null
    } | null>(null)

    useEffect(() => () => { generationRef.current += 1 }, [])

    const openDraftRoom = useCallback((launchOptions: { fallbackOnMissing?: boolean } = {}) => {
        const fallbackOnMissing = launchOptions.fallbackOnMissing ?? true
        const capturedKey = resourceKey
        if (!capturedKey || !leagueId) {
            if (fallbackOnMissing && !options.renderAuctionInline) router.push(NO_DRAFT_ROUTE)
            return Promise.resolve<LaunchResult>('missing')
        }
        if (inFlightRef.current?.key === capturedKey) return inFlightRef.current.promise

        const generation = ++generationRef.current
        setRequest({ key: capturedKey, loading: true, error: null, draft: null })
        const ownsRequest = () => (
            activeResourceKeyRef.current === capturedKey
            && generationRef.current === generation
        )
        const promise = (async (): Promise<LaunchResult> => {
            try {
                const draft = await getJoinableDraft(leagueId, { includeCompletedRookie: true })
                if (!ownsRequest()) return 'stale'
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
                const message = getErrorMessage(error)
                setRequest({ key: capturedKey, loading: false, error: message, draft: null })
                if (options.notifyOnError) showAlert('Could not open draft room', message)
                return 'error'
            } finally {
                if (ownsRequest()) {
                    setRequest((current) => current?.key === capturedKey
                        ? { ...current, loading: false }
                        : current)
                }
                if (inFlightRef.current?.key === capturedKey) inFlightRef.current = null
            }
        })()
        inFlightRef.current = { key: capturedKey, promise }
        return promise
    }, [leagueId, resourceKey, options.renderAuctionInline, options.notifyOnError, router])

    const ownsState = request?.key === resourceKey
    return {
        openDraftRoom,
        draft: ownsState ? request.draft : null,
        draftLoading: ownsState ? request.loading : false,
        draftError: ownsState ? request.error : null,
        draftChecked: Boolean(ownsState && !request.loading),
    }
}
