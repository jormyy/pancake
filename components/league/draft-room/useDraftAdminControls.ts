import { useEffect, useRef, useState } from 'react'
import { pauseDraft, resetDraft, resumeDraft, stopDraft } from '@/lib/draft'
import { confirmAction, showAlert } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'

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
    canAct = () => true,
}: {
    draftId?: string
    confirmCopy: DraftAdminConfirmCopy
    refresh: () => Promise<void>
    onStopped: () => void
    onReset?: () => void
    canAct?: () => boolean
}) {
    const activeDraftIdRef = useRef(draftId)
    const generationRef = useRef(0)
    const pendingDraftsRef = useRef(new Set<string>())
    const [busyDrafts, setBusyDrafts] = useState(new Set<string>())
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
        canAct() && activeDraftIdRef.current === capturedDraftId && generationRef.current === generation

    async function runAction(
        capturedDraftId: string,
        generation: number,
        mutate: (id: string) => Promise<unknown>,
        failureTitle: string,
        after: () => void | Promise<void>,
    ) {
        if (!canAct() || !ownsDraft(capturedDraftId, generation) || pendingDraftsRef.current.has(capturedDraftId)) return
        pendingDraftsRef.current.add(capturedDraftId)
        setBusyDrafts(new Set(pendingDraftsRef.current))
        try {
            await mutate(capturedDraftId)
            if (ownsDraft(capturedDraftId, generation)) await after()
        } catch (error) {
            if (ownsDraft(capturedDraftId, generation)) showAlert(failureTitle, getErrorMessage(error))
        } finally {
            pendingDraftsRef.current.delete(capturedDraftId)
            setBusyDrafts(new Set(pendingDraftsRef.current))
        }
    }

    function handleStopDraft() {
        if (!canAct() || !draftId || pendingDraftsRef.current.has(draftId)) return
        const capturedDraftId = draftId
        const generation = generationRef.current
        confirmAction('Stop draft?', confirmCopy.stop, () => {
            void runAction(capturedDraftId, generation, stopDraft, 'Could not stop draft', onStopped)
        }, 'Stop Draft')
    }

    function handleResetDraft() {
        if (!canAct() || !draftId || pendingDraftsRef.current.has(draftId)) return
        const capturedDraftId = draftId
        const generation = generationRef.current
        confirmAction('Reset draft?', confirmCopy.reset, () => {
            void runAction(capturedDraftId, generation, resetDraft, 'Could not reset draft', async () => {
                await refresh()
                if (ownsDraft(capturedDraftId, generation)) onReset?.()
            })
        }, 'Reset Draft')
    }

    function handlePauseDraft() {
        if (!canAct() || !draftId || pendingDraftsRef.current.has(draftId)) return
        const capturedDraftId = draftId
        const generation = generationRef.current
        confirmAction('Pause draft?', confirmCopy.pause, () => {
            void runAction(capturedDraftId, generation, pauseDraft, 'Could not pause draft', refresh)
        }, 'Pause Draft')
    }

    function handleResumeDraft() {
        if (!canAct() || !draftId || pendingDraftsRef.current.has(draftId)) return
        const capturedDraftId = draftId
        const generation = generationRef.current
        confirmAction('Resume draft?', confirmCopy.resume, () => {
            void runAction(capturedDraftId, generation, resumeDraft, 'Could not resume draft', refresh)
        }, 'Resume Draft')
    }

    return { handleStopDraft, handleResetDraft, handlePauseDraft, handleResumeDraft, adminBusy: Boolean(draftId && busyDrafts.has(draftId)) }
}
