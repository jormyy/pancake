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
    function handleStopDraft() {
        if (!draftId) return
        confirmAction(
            'Stop draft?',
            confirmCopy.stop,
            () => {
                void (async () => {
                    try {
                        await stopDraft(draftId)
                        onStopped()
                    } catch (e) {
                        showAlert('Could not stop draft', getErrorMessage(e))
                    }
                })()
            },
            'Stop Draft',
        )
    }

    function handleResetDraft() {
        if (!draftId) return
        confirmAction(
            'Reset draft?',
            confirmCopy.reset,
            () => {
                void (async () => {
                    try {
                        await resetDraft(draftId)
                        await refresh()
                        onReset?.()
                    } catch (e) {
                        showAlert('Could not reset draft', getErrorMessage(e))
                    }
                })()
            },
            'Reset Draft',
        )
    }

    function handlePauseDraft() {
        if (!draftId) return
        confirmAction(
            'Pause draft?',
            confirmCopy.pause,
            () => {
                void (async () => {
                    try {
                        await pauseDraft(draftId)
                        await refresh()
                    } catch (e) {
                        showAlert('Could not pause draft', getErrorMessage(e))
                    }
                })()
            },
            'Pause Draft',
        )
    }

    function handleResumeDraft() {
        if (!draftId) return
        confirmAction(
            'Resume draft?',
            confirmCopy.resume,
            () => {
                void (async () => {
                    try {
                        await resumeDraft(draftId)
                        await refresh()
                    } catch (e) {
                        showAlert('Could not resume draft', getErrorMessage(e))
                    }
                })()
            },
            'Resume Draft',
        )
    }

    return { handleStopDraft, handleResetDraft, handlePauseDraft, handleResumeDraft }
}
