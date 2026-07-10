import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { getJoinableDraft } from '@/lib/draft'
import { getErrorMessage, showAlert } from '@/lib/alert'

type LaunchResult = 'opened' | 'missing' | 'error' | 'stale'

export function useDraftRoomLauncher(
    leagueId: string | undefined,
    options: { notifyOnError?: boolean } = {},
) {
    const router = useRouter()
    const resourceKey = leagueId ?? null
    const activeResourceKeyRef = useRef(resourceKey)
    activeResourceKeyRef.current = resourceKey
    const generationRef = useRef(0)
    const inFlightRef = useRef<{ key: string; promise: Promise<LaunchResult> } | null>(null)
    const [request, setRequest] = useState<{
        key: string
        loading: boolean
        error: string | null
    } | null>(null)

    const openDraftRoom = useCallback((launchOptions: { fallbackOnMissing?: boolean } = {}) => {
        const fallbackOnMissing = launchOptions.fallbackOnMissing ?? true
        const capturedKey = leagueId
        if (!capturedKey) {
            if (fallbackOnMissing) router.push('/draft-room')
            return Promise.resolve<LaunchResult>('missing')
        }
        if (inFlightRef.current?.key === capturedKey) return inFlightRef.current.promise

        const generation = ++generationRef.current
        setRequest({ key: capturedKey, loading: true, error: null })
        const ownsRequest = () => (
            activeResourceKeyRef.current === capturedKey
            && generationRef.current === generation
        )
        const promise = (async (): Promise<LaunchResult> => {
            try {
                const draft = await getJoinableDraft(capturedKey, { includeCompletedRookie: true })
                if (!ownsRequest()) return 'stale'
                if (!draft) {
                    if (fallbackOnMissing) router.push('/draft-room')
                    return 'missing'
                }
                const pathname = draft.draftType === 'snake'
                    ? '/(modals)/rookie-draft-room'
                    : '/(modals)/draft-room'
                router.push({ pathname, params: { draftId: draft.id } })
                return 'opened'
            } catch (error) {
                if (!ownsRequest()) return 'stale'
                const message = getErrorMessage(error)
                setRequest({ key: capturedKey, loading: false, error: message })
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
    }, [leagueId, options.notifyOnError, router])

    const ownsState = request?.key === resourceKey
    return {
        openDraftRoom,
        draftLoading: ownsState ? request.loading : false,
        draftError: ownsState ? request.error : null,
        draftChecked: Boolean(ownsState && !request.loading),
    }
}
