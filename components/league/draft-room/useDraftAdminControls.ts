import { useEffect, useRef } from 'react'
import { pauseDraft, resetDraft, resumeDraft, stopDraft } from '@/lib/draft'
import { confirmAction, getErrorMessage, showAlert } from '@/lib/alert'

type DraftAdminConfirmCopy = {
    stop: string
    reset: string
    pause: string
    resume: string
}

export function useDraftAdminControls({
    draftId,
    confirmCopy,
    refresh,
    onStopped,
    onReset,
}: {
    draftId?: string
    confirmCopy: DraftAdminConfirmCopy
    refresh: () => Promise<void>
    onStopped: () => void
    onReset?: () => void
}) {
    const activeDraftIdRef = useRef(draftId)
    const generationRef = useRef(0)
    if (activeDraftIdRef.current !== draftId) {
        activeDraftIdRef.current = draftId
        generationRef.current += 1
    }
    useEffect(() => {
        activeDraftIdRef.current = draftId
        return () => {
            if (activeDraftIdRef.current === draftId) {
                activeDraftIdRef.current = undefined
                generationRef.current += 1
            }
        }
    }, [draftId])
    const ownsDraft = (capturedDraftId: string, generation: number) =>
        activeDraftIdRef.current === capturedDraftId && generationRef.current === generation

    function handleStopDraft() {
        if (!draftId) return
        const capturedDraftId = draftId
        const generation = generationRef.current
        confirmAction(
            'Stop draft?',
            confirmCopy.stop,
            () => {
                void (async () => {
                    if (!ownsDraft(capturedDraftId, generation)) return
                    try {
                        await stopDraft(capturedDraftId)
                        if (ownsDraft(capturedDraftId, generation)) onStopped()
                    } catch (e) {
                        if (ownsDraft(capturedDraftId, generation)) {
                            showAlert('Could not stop draft', getErrorMessage(e))
                        }
                    }
                })()
            },
            'Stop Draft',
        )
    }

    function handleResetDraft() {
        if (!draftId) return
        const capturedDraftId = draftId
        const generation = generationRef.current
        confirmAction(
            'Reset draft?',
            confirmCopy.reset,
            () => {
                void (async () => {
                    if (!ownsDraft(capturedDraftId, generation)) return
                    try {
                        await resetDraft(capturedDraftId)
                        if (!ownsDraft(capturedDraftId, generation)) return
                        await refresh()
                        if (ownsDraft(capturedDraftId, generation)) onReset?.()
                    } catch (e) {
                        if (ownsDraft(capturedDraftId, generation)) {
                            showAlert('Could not reset draft', getErrorMessage(e))
                        }
                    }
                })()
            },
            'Reset Draft',
        )
    }

    function handlePauseDraft() {
        if (!draftId) return
        const capturedDraftId = draftId
        const generation = generationRef.current
        confirmAction(
            'Pause draft?',
            confirmCopy.pause,
            () => {
                void (async () => {
                    if (!ownsDraft(capturedDraftId, generation)) return
                    try {
                        await pauseDraft(capturedDraftId)
                        if (!ownsDraft(capturedDraftId, generation)) return
                        await refresh()
                    } catch (e) {
                        if (ownsDraft(capturedDraftId, generation)) {
                            showAlert('Could not pause draft', getErrorMessage(e))
                        }
                    }
                })()
            },
            'Pause Draft',
        )
    }

    function handleResumeDraft() {
        if (!draftId) return
        const capturedDraftId = draftId
        const generation = generationRef.current
        confirmAction(
            'Resume draft?',
            confirmCopy.resume,
            () => {
                void (async () => {
                    if (!ownsDraft(capturedDraftId, generation)) return
                    try {
                        await resumeDraft(capturedDraftId)
                        if (!ownsDraft(capturedDraftId, generation)) return
                        await refresh()
                    } catch (e) {
                        if (ownsDraft(capturedDraftId, generation)) {
                            showAlert('Could not resume draft', getErrorMessage(e))
                        }
                    }
                })()
            },
            'Resume Draft',
        )
    }

    return { handleStopDraft, handleResetDraft, handlePauseDraft, handleResumeDraft }
}
