import { tradeAcceptanceSummary } from '@/components/trades/acceptance-summary'
import { useCallback, useEffect, useRef, useState } from 'react'
import { acceptTrade, getTradeRosterPreview, undoTradeAcceptance, setTradeRosterPlan, setTradeTaxiDestinations, rejectTrade, vetoTrade, withdrawTrade, type Trade, type TradeRosterPlan } from '@/lib/trades'
import { confirmAction, showAlert } from '@/lib/alert'
import type { TradeVetoMode } from '@/types/app'
import { getErrorMessage } from '@/lib/shared/errors'
import { useScope } from '@/hooks/use-scope'

export function useTradeActions({
    memberId,
    leagueId,
    onAction,
    onRosterPlanSaved,
    onAcceptanceUndone,
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
    onAcceptanceUndone?: (tradeId: string) => void
    enabled?: boolean
    tradeVetoMode?: TradeVetoMode
    tradeVetoWindowHours?: number
}) {
    const enabledRef = useRef(enabled)
    enabledRef.current = enabled
    const scope = useScope(leagueId, memberId)
    const mutationInFlight = useRef(false)
    const [busyTradeId, setBusyTradeId] = useState<string | null>(null)

    useEffect(() => {
        mutationInFlight.current = false
        setBusyTradeId(null)
        return () => { mutationInFlight.current = false }
    }, [leagueId, memberId])

    const runTerminalAction = useCallback(async (
        tradeId: string,
        operation: (tradeId: string, memberId: string) => Promise<void>,
        fallbackMessage: string,
        options: { onComplete?: () => void | Promise<unknown>; onError?: (error: unknown) => Promise<boolean> } = {},
    ) => {
        const ticket = scope.ticket()
        if (!enabledRef.current || !ticket.live() || !memberId || mutationInFlight.current) return
        mutationInFlight.current = true
        setBusyTradeId(tradeId)
        try {
            await operation(tradeId, memberId)
            ticket.commit(() => { void Promise.resolve().then(options.onComplete ?? onAction).catch(() => undefined) })
        } catch (error) {
            if (ticket.live()) {
                const handled = await options.onError?.(error)
                if (!handled) ticket.commit(() => showAlert('Error', getErrorMessage(error) ?? fallbackMessage))
            }
        } finally {
            ticket.commit(() => {
                mutationInFlight.current = false
                setBusyTradeId(null)
            })
        }
    }, [scope, memberId, onAction])

    const accept = useCallback(async (trade: Trade) => {
        const ticket = scope.ticket()
        if (!enabledRef.current || !ticket.live() || !memberId || !leagueId || mutationInFlight.current) return
        const owned = () => enabledRef.current && ticket.live()
        try {
            if (beforeAccept && !await beforeAccept()) return
        } catch (error) {
            if (owned()) showAlert('Error', getErrorMessage(error))
            return
        }
        if (!owned()) return
        let confirmedPlan: TradeRosterPlan | undefined
        let message = ''
        try {
            const teams = await getTradeRosterPreview(trade.id)
            if (!owned()) return
            const invalid = teams.find((team) => team.memberId === memberId && team.error)
            if (invalid) {
                showAlert('Complete the roster plan', `${invalid.teamName}: ${invalid.error}`)
                return
            }
            const ownPlan = teams.find((team) => team.memberId === memberId)
            if (!ownPlan?.plan) throw new Error('The roster plan did not load. Reopen the trade and try again.')
            confirmedPlan = ownPlan.plan
            message = tradeAcceptanceSummary(trade, teams, memberId)
        } catch (error) {
            if (owned()) showAlert('Could not check roster plans', getErrorMessage(error))
            return
        }
        if (!owned() || mutationInFlight.current) return
        return confirmAction('Accept trade?', message,
            () => runTerminalAction(trade.id, (tradeId, ownMemberId) => acceptTrade(tradeId, ownMemberId, confirmedPlan), 'Could not accept trade.', { onError: onRosterError }), 'Accept', false)
    }, [beforeAccept, scope, leagueId, memberId, onRosterError, runTerminalAction])

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
        { onComplete: onRosterPlanSaved ? () => onRosterPlanSaved(trade.id, savedPlan) : undefined })
    }, [onRosterPlanSaved, runTerminalAction])

    const reject = useCallback((tradeId: string) => {
        confirmAction('Reject Trade', 'Are you sure you want to reject this trade?',
            () => runTerminalAction(tradeId, rejectTrade, 'Could not reject trade.'), 'Reject')
    }, [runTerminalAction])
    const withdraw = useCallback((tradeId: string) => {
        confirmAction('Withdraw Trade', 'Are you sure you want to withdraw this offer?',
            () => runTerminalAction(tradeId, withdrawTrade, 'Could not withdraw trade.'), 'Withdraw')
    }, [runTerminalAction])
    const undoAcceptance = useCallback((trade: Trade) => {
        confirmAction('Undo acceptance', 'Undo your acceptance of this trade? The offer stays open, other teams keep their answers, and you can accept again.',
            () => runTerminalAction(trade.id, (tradeId, ownMemberId) => undoTradeAcceptance(tradeId, ownMemberId, trade.version), 'Could not undo acceptance.', {
                onComplete: () => {
                    onAcceptanceUndone?.(trade.id)
                    return onAction()
                },
                onError: async (error) => {
                    showAlert('Error', getErrorMessage(error) ?? 'Could not undo acceptance.')
                    await Promise.resolve().then(onAction).catch(() => undefined)
                    return true
                },
            }), 'Undo acceptance')
    }, [onAcceptanceUndone, onAction, runTerminalAction])
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
        undoAcceptance,
        veto,
        withdraw,
    }
}
