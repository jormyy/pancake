import { getGameDay } from '@/lib/games'
import { todayET } from '@/lib/shared/dates'
import { useCallback, useEffect, useRef, useState } from 'react'
import { acceptTrade, setTradeRosterPlan, setTradeTaxiDestinations, rejectTrade, vetoTrade, withdrawTrade, type Trade, type TradeRosterPlan } from '@/lib/trades'
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
    tradeVetoMode = 'member_vote',
    tradeVetoWindowHours = 24,
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

    const finishAction = useCallback(async (requestId: number, ownerIdentity: string, onComplete = onAction) => {
        if (!mountedRef.current || requestSequence.current !== requestId || identityRef.current !== ownerIdentity) return
        await onComplete()
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
            await finishAction(requestId, ownerIdentity, onComplete)
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
        const assets = (direction: 'fromMemberId' | 'toMemberId') => trade.routedItems
            .filter(item => item[direction] === memberId)
            .map(item => item.kind === 'player' ? item.playerName : item.kind === 'pick' ? `${item.seasonYear} round ${item.round} pick` : `$${item.amount} FAAB`)
            .join(', ') || 'nothing'
        const everyoneAccepted = (!trade.isMultiTeam || trade.participants.length > 0) && trade.participants.every(participant => participant.memberId === memberId || participant.acceptedAt != null)
        let gamesClear = false
        if (everyoneAccepted && (tradeVetoMode === 'disabled' || tradeVetoWindowHours === 0)) {
            try {
                const { startedTeams } = await getGameDay(todayET())
                gamesClear = !trade.routedItems.some(item => item.kind === 'player' && item.nbaTeam && startedTeams.has(item.nbaTeam))
            } catch {}
        }
        if (!enabledRef.current || !mountedRef.current || identityRef.current !== identity || mutationInFlight.current) return
        const message = `You give: ${assets('fromMemberId')}. You receive: ${assets('toMemberId')}.`
            + (gamesClear ? ' This trade completes immediately.' : ' This trade completes when everyone accepts and player games and review allow it.')
        return confirmAction('Accept trade?', message,
            () => runTerminalAction(trade.id, acceptTrade, 'Could not accept trade.'), 'Accept', false)
    }, [beforeAccept, identity, leagueId, memberId, runTerminalAction, tradeVetoMode, tradeVetoWindowHours])

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
