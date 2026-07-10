import { useCallback, useEffect, useRef, useState } from 'react'
import { acceptTrade, rejectTrade, vetoTrade, withdrawTrade, type Trade } from '@/lib/trades'
import { getRoster, type RosterPlayer } from '@/lib/roster'
import { confirmAction, getErrorMessage, showAlert } from '@/lib/alert'
import { tradeDisplayPerspective } from '@/lib/trade-perspective'

type PendingDrops = {
    tradeId: string
    roster: RosterPlayer[]
    needed: number
    selected: Set<string>
}

export function useTradeActions({
    memberId,
    leagueId,
    rosterSize,
    onAction,
}: {
    memberId: string
    leagueId: string
    rosterSize: number
    onAction: () => void | Promise<void>
}) {
    const identity = `${leagueId}:${memberId}`
    const identityRef = useRef(identity)
    identityRef.current = identity
    const requestSequence = useRef(0)
    const [busyTradeId, setBusyTradeId] = useState<string | null>(null)
    const [pendingDrops, setPendingDrops] = useState<PendingDrops | null>(null)
    const [droppingRosterPlayerId, setDroppingRosterPlayerId] = useState<string | null>(null)

    useEffect(() => {
        requestSequence.current += 1
        setBusyTradeId(null)
        setPendingDrops(null)
        setDroppingRosterPlayerId(null)
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
            const roster = await getRoster(memberId, leagueId)
            if (requestSequence.current !== requestId || identityRef.current !== ownerIdentity) return
            const perspective = tradeDisplayPerspective(trade, memberId)
            const activeCount = roster.filter((player) => !player.is_on_ir && !player.is_on_taxi).length
            const incomingPlayers = perspective.receives.filter((item) => item.kind === 'player').length
            const outgoingPlayerIds = new Set(
                perspective.gives.flatMap((item) => item.kind === 'player' ? [item.playerId] : []),
            )
            const overflow = activeCount - outgoingPlayerIds.size + incomingPlayers - rosterSize
            if (overflow > 0) {
                setPendingDrops({
                    tradeId: trade.id,
                    needed: overflow,
                    selected: new Set(),
                    roster: roster.filter((player) =>
                        !player.is_on_ir && !player.is_on_taxi && !outgoingPlayerIds.has(player.players.id)),
                })
                return
            }
            await acceptTrade(trade.id, memberId)
            await finishAction(requestId, ownerIdentity)
        } catch (error) {
            if (requestSequence.current === requestId && identityRef.current === ownerIdentity) {
                showAlert('Error', getErrorMessage(error) ?? 'Could not accept trade.')
            }
        } finally {
            if (requestSequence.current === requestId) setBusyTradeId(null)
        }
    }, [finishAction, identity, leagueId, memberId, rosterSize])

    const selectDrop = useCallback(async (rosterPlayerId: string) => {
        const pending = pendingDrops
        if (!pending || !memberId) return
        const selected = new Set([...pending.selected, rosterPlayerId])
        if (selected.size < pending.needed) {
            setPendingDrops({ ...pending, selected })
            return
        }
        const requestId = ++requestSequence.current
        const ownerIdentity = identity
        setDroppingRosterPlayerId(rosterPlayerId)
        try {
            await acceptTrade(pending.tradeId, memberId, [...selected])
            if (requestSequence.current !== requestId || identityRef.current !== ownerIdentity) return
            setPendingDrops(null)
            await finishAction(requestId, ownerIdentity)
        } catch (error) {
            if (requestSequence.current === requestId && identityRef.current === ownerIdentity) {
                showAlert('Error', getErrorMessage(error) ?? 'Could not accept trade.')
            }
        } finally {
            if (requestSequence.current === requestId) setDroppingRosterPlayerId(null)
        }
    }, [finishAction, identity, memberId, pendingDrops])

    const cancelDrops = useCallback(() => {
        requestSequence.current += 1
        setPendingDrops(null)
        setDroppingRosterPlayerId(null)
    }, [])

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
        cancelDrops,
        dropPicker: pendingDrops ? {
            needed: pendingDrops.needed - pendingDrops.selected.size,
            roster: pendingDrops.roster.filter((player) => !pendingDrops.selected.has(player.id)),
        } : null,
        droppingRosterPlayerId,
        reject,
        selectDrop,
        veto,
        withdraw,
    }
}
