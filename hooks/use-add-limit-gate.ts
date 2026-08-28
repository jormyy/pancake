import { useCallback } from 'react'
import { showAlert } from '@/lib/alert'
import { ADD_LIMIT_BLOCKED_TITLE, addLimitBlockedReason, type AddLimitSource } from '@/lib/pickup'

type AddLimitGateOptions = {
    transactionState: AddLimitSource | null | undefined
    /** Reloads the weekly add state after a block. */
    refresh?: () => void
}

/**
 * Explains a blocked pickup from cached state before a request is made. The
 * server stays authoritative: `explainBlock` only saves a round trip when the
 * cached state already carries the server's rejection sentence.
 */
export function useAddLimitGate({ transactionState, refresh }: AddLimitGateOptions) {
    const addBlockedReason = addLimitBlockedReason(transactionState)

    const explainBlock = useCallback(() => {
        if (!addBlockedReason) return false
        showAlert(ADD_LIMIT_BLOCKED_TITLE, addBlockedReason)
        refresh?.()
        return true
    }, [addBlockedReason, refresh])

    return { addBlockedReason, explainBlock }
}
