import { useCallback } from 'react'
import { confirmAction, showAlert } from '@/lib/alert'
import { ADD_LIMIT_BLOCKED_TITLE, addLimitBlockedReason, classifyPickupError, type AddLimitSource } from '@/lib/add-limit'

type AddLimitGateOptions = {
    transactionState: AddLimitSource | null | undefined
    /** Reloads the weekly add state after a block or a limit rejection. */
    refresh?: () => void
    /** Local cleanup once the server says the limit is reached (close a drop picker, etc.). */
    onLimitReached?: () => void
}

/**
 * The one client-side owner of "is a pickup blocked by the weekly add limit"
 * and of explaining a rejected pickup. The server stays authoritative:
 * `explainBlock` only saves a round trip when the cached state already says the
 * week is used up, and `reportError` turns the server's own rejection into the
 * same explanation. A player the server still holds on waivers (the entry is
 * past its window but not processed yet) is offered the claim flow instead.
 */
export function useAddLimitGate({ transactionState, refresh, onLimitReached }: AddLimitGateOptions) {
    const addBlockedReason = addLimitBlockedReason(transactionState)

    const explainBlock = useCallback(() => {
        const reason = addLimitBlockedReason(transactionState)
        if (!reason) return false
        showAlert(ADD_LIMIT_BLOCKED_TITLE, reason)
        refresh?.()
        return true
    }, [transactionState, refresh])

    const reportError = useCallback((error: unknown, claim?: false | (() => void)) => {
        const failure = classifyPickupError(error)
        if (failure.limitReached) {
            onLimitReached?.()
            refresh?.()
        }
        if (failure.onWaivers && claim) {
            confirmAction(failure.title, `${failure.message} Claims are processed on the next waiver run.`, claim, 'Claim', false)
            return
        }
        showAlert(failure.title, failure.message)
    }, [onLimitReached, refresh])

    return { addBlockedReason, explainBlock, reportError }
}
