import { useCallback, useEffect, useRef, useState } from 'react'
import { acceptTrade, rejectTrade, vetoTrade, withdrawTrade, type Trade } from '@/lib/trades'
import { confirmAction, getErrorMessage, showAlert } from '@/lib/alert'

export function useTradeActions({
    memberId,
    leagueId,
    onAction,
}: {
    memberId: string
    leagueId: string
    onAction: () => void | Promise<void>
}) {
    const identity = `${leagueId}:${memberId}`
    const identityRef = useRef(identity)
    identityRef.current = identity
    const requestSequence = useRef(0)
    const [busyTradeId, setBusyTradeId] = useState<string | null>(null)

    useEffect(() => {
        requestSequence.current += 1
        setBusyTradeId(null)
    }, [identity])

    const finishAction = useCallback(async (requestId: number, ownerIdentity: string) => {
        if (requestSequence.current !== requestId || identityRef.current !== ownerIdentity) return
        await onAction()
    }, [onAction])

    const accept = useCallback(async (trade: Trade) => {
        if (!memberId || !leagueId) return
        const requestId = ++requestSequence.current
        const ownerIdentity = identity
        setBusyTradeId(trade.id)
        try {
            await acceptTrade(trade.id, memberId)
            await finishAction(requestId, ownerIdentity)
        } catch (error) {
            if (requestSequence.current === requestId && identityRef.current === ownerIdentity) {
                showAlert('Error', getErrorMessage(error) ?? 'Could not accept trade.')
            }
        } finally {
            if (requestSequence.current === requestId) setBusyTradeId(null)
        }
    }, [finishAction, identity, leagueId, memberId])

    const runTerminalAction = useCallback(async (
        tradeId: string,
        operation: (tradeId: string, memberId: string) => Promise<void>,
        fallbackMessage: string,
    ) => {
        if (!memberId) return
        const requestId = ++requestSequence.current
        const ownerIdentity = identity
        setBusyTradeId(tradeId)
        try {
            await operation(tradeId, memberId)
            await finishAction(requestId, ownerIdentity)
        } catch (error) {
            if (requestSequence.current === requestId && identityRef.current === ownerIdentity) {
                showAlert('Error', getErrorMessage(error) ?? fallbackMessage)
            }
        } finally {
            if (requestSequence.current === requestId) setBusyTradeId(null)
        }
    }, [finishAction, identity, memberId])

    const reject = useCallback((tradeId: string) => {
        confirmAction('Reject Trade', 'Are you sure you want to reject this trade?',
            () => runTerminalAction(tradeId, rejectTrade, 'Could not reject trade.'), 'Reject')
    }, [runTerminalAction])
    const withdraw = useCallback((tradeId: string) => {
        confirmAction('Withdraw Trade', 'Are you sure you want to withdraw this offer?',
            () => runTerminalAction(tradeId, withdrawTrade, 'Could not withdraw trade.'), 'Withdraw')
    }, [runTerminalAction])
    const veto = useCallback((tradeId: string) => {
        confirmAction('Veto Trade', 'Are you sure you want to veto this accepted trade?',
            () => runTerminalAction(tradeId, vetoTrade, 'Could not veto trade.'), 'Veto')
    }, [runTerminalAction])

    return {
        accept,
        busyTradeId,
        reject,
        veto,
        withdraw,
    }
}
