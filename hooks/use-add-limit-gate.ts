import { useCallback } from 'react'
import { showAlert } from '@/lib/alert'
import { ADD_LIMIT_BLOCKED_TITLE, addLimitBlockedReason, classifyPickupError, type AddLimitSource } from '@/lib/add-limit'

type AddLimitGateOptions = {
    transactionState: AddLimitSource | null | undefined
    /** Reloads the weekly add state after a block or a limit rejection. */
    refresh?: () => void
    /** Local cleanup once the server says the limit is reached (close a drop picker, etc.). */
    onLimitReached?: () => void
}

/**
 * The one client-side owner of "is a pickup blocked by the weekly add limit".
 * The server stays authoritative: `explainBlock` only saves a round trip when the
 * cached state already says the week is used up, and `reportError` turns the
 * server's own rejection into the same explanation.
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

    const reportError = useCallback((error: unknown) => {
        const failure = classifyPickupError(error)
        if (failure.limitReached) {
            onLimitReached?.()
            refresh?.()
        }
        showAlert(failure.title, failure.message)
    }, [onLimitReached, refresh])

    return { addBlockedReason, explainBlock, reportError }
}
