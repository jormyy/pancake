import { tradeAcceptanceSummary } from '@/components/trades/acceptance-summary'
import { useCallback, useEffect, useRef, useState } from 'react'
import { acceptTrade, getTradeRosterPreview, setTradeRosterPlan, setTradeTaxiDestinations, rejectTrade, vetoTrade, withdrawTrade, type Trade, type TradeRosterPlan } from '@/lib/trades'
import { confirmAction, showAlert } from '@/lib/alert'
import type { TradeVetoMode } from '@/types/app'
import { getErrorMessage } from '@/lib/shared/errors'

export function useTradeActions({
    memberId,
    leagueId,
    onAction,
    onRosterPlanSaved,
    beforeAccept,
    onRosterError,
    enabled = true,
}: {
    memberId: string
    leagueId: string
    onAction: () => void | Promise<unknown>
    beforeAccept?: () => Promise<boolean>
    onRosterError?: (error: unknown) => Promise<boolean>
    onRosterPlanSaved?: (tradeId: string, plan: TradeRosterPlan) => void
    enabled?: boolean
    tradeVetoMode?: TradeVetoMode
    tradeVetoWindowHours?: number
}) {
    const enabledRef = useRef(enabled)
    enabledRef.current = enabled
    const identity = `${leagueId}:${memberId}`
    const identityRef = useRef(identity)
    identityRef.current = identity
    const mountedRef = useRef(false)
    const requestSequence = useRef(0)
    const mutationInFlight = useRef(false)
    const [busyTradeId, setBusyTradeId] = useState<string | null>(null)

    useEffect(() => {
        mountedRef.current = true
        requestSequence.current += 1
        mutationInFlight.current = false
        setBusyTradeId(null)
        return () => {
            mountedRef.current = false
            requestSequence.current += 1
            mutationInFlight.current = false
        }
    }, [identity])

    const finishAction = useCallback((requestId: number, ownerIdentity: string, onComplete = onAction) => {
        if (!mountedRef.current || requestSequence.current !== requestId || identityRef.current !== ownerIdentity) return
        void Promise.resolve().then(onComplete).catch(() => undefined)
    }, [onAction])

    const runTerminalAction = useCallback(async (
        tradeId: string,
        operation: (tradeId: string, memberId: string) => Promise<void>,
        fallbackMessage: string,
        onComplete?: () => void | Promise<unknown>,
    ) => {
        if (!enabledRef.current || !mountedRef.current || !memberId || identityRef.current !== identity || mutationInFlight.current) return
        mutationInFlight.current = true
        const requestId = ++requestSequence.current
        const ownerIdentity = identity
        setBusyTradeId(tradeId)
        try {
            await operation(tradeId, memberId)
            finishAction(requestId, ownerIdentity, onComplete)
        } catch (error) {
            if (mountedRef.current && requestSequence.current === requestId && identityRef.current === ownerIdentity) {
                const handled = operation === acceptTrade && await onRosterError?.(error)
                if (!handled && mountedRef.current && requestSequence.current === requestId && identityRef.current === ownerIdentity) showAlert('Error', getErrorMessage(error) ?? fallbackMessage)
            }
        } finally {
            if (mountedRef.current && requestSequence.current === requestId) {
                mutationInFlight.current = false
                setBusyTradeId(null)
            }
        }
    }, [finishAction, identity, memberId, onRosterError])

    const accept = useCallback(async (trade: Trade) => {
        if (!enabledRef.current || !mountedRef.current || !memberId || !leagueId || mutationInFlight.current) return
        try {
            if (beforeAccept && !await beforeAccept()) return
        } catch (error) {
            if (enabledRef.current && mountedRef.current && identityRef.current === identity) showAlert('Error', getErrorMessage(error))
            return
        }
        if (!enabledRef.current || !mountedRef.current || identityRef.current !== identity) return
        let confirmedPlan: TradeRosterPlan | undefined
        let message = ''
        try {
            const teams = await getTradeRosterPreview(trade.id)
            if (!enabledRef.current || !mountedRef.current || identityRef.current !== identity) return
            const invalid = teams.find((team) => team.error)
            if (invalid) {
                showAlert('Complete the roster plan', `${invalid.teamName}: ${invalid.error}`)
                return
            }
            const ownPlan = teams.find((team) => team.memberId === memberId)
            if (!ownPlan?.plan) throw new Error('The roster plan did not load. Reopen the trade and try again.')
            confirmedPlan = ownPlan.plan
            message = tradeAcceptanceSummary(trade, teams, memberId)
        } catch (error) {
            if (enabledRef.current && mountedRef.current && identityRef.current === identity) showAlert('Could not check roster plans', getErrorMessage(error))
            return
        }
        if (!enabledRef.current || !mountedRef.current || identityRef.current !== identity || mutationInFlight.current) return
        return confirmAction('Accept trade?', message,
            () => runTerminalAction(trade.id, (tradeId, ownMemberId) => acceptTrade(tradeId, ownMemberId, confirmedPlan), 'Could not accept trade.'), 'Accept', false)
    }, [beforeAccept, identity, leagueId, memberId, runTerminalAction])

    const setTaxiDestination = useCallback((trade: Trade, playerId: string, toTaxi: boolean) => {
        const playerIds = trade.routedItems.flatMap((item) => item.kind === 'player' && item.toMemberId === memberId &&
            (item.playerId === playerId ? toTaxi : item.toTaxi) ? [item.playerId] : [])
        return runTerminalAction(trade.id,
            (tradeId, receiverId) => setTradeTaxiDestinations(tradeId, receiverId, playerIds),
            'Could not save the taxi destination.')
    }, [memberId, runTerminalAction])

    const setRosterPlan = useCallback((trade: Trade, plan: TradeRosterPlan) => {
        let savedPlan = plan
        return runTerminalAction(trade.id, async (tradeId, receiverId) => {
            savedPlan = await setTradeRosterPlan(tradeId, receiverId, plan)
        }, 'Could not save the roster plan.',
        onRosterPlanSaved ? () => onRosterPlanSaved(trade.id, savedPlan) : undefined)
    }, [onRosterPlanSaved, runTerminalAction])

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
        setTaxiDestination,
        setRosterPlan,
        busyTradeId,
        reject,
        veto,
        withdraw,
    }
}
