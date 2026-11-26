import { useCallback, useEffect, useState } from 'react'
import { useScope } from '@/hooks/use-scope'
import { checkRosterHold, rosterHoldPartnerLabel, type RosterHoldConflict } from '@/lib/waivers'
import { confirmAction, showAlert } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'

export function useRosterHoldCheck({
    memberId,
    addPlayerId,
    dropPlayerIds,
    toIr = false,
    toTaxi = false,
    enabled = true,
}: {
    memberId: string | undefined
    addPlayerId?: string | null
    dropPlayerIds?: string[]
    toIr?: boolean
    toTaxi?: boolean
    enabled?: boolean
}) {
    const [conflicts, setConflicts] = useState<RosterHoldConflict[]>([])
    const [checking, setChecking] = useState(false)
    const [undoingTradeId, setUndoingTradeId] = useState<string | null>(null)
    const [undoNotice, setUndoNotice] = useState<string | null>(null)
    const scope = useScope(memberId)
    const dropKey = (dropPlayerIds ?? []).join(',')

    const run = useCallback(async () => {
        const ticket = scope.latest()
        if (!enabled || !memberId) {
            setConflicts([])
            setChecking(false)
            return []
        }
        setChecking(true)
        try {
            const next = await checkRosterHold(memberId, {
                addPlayerId: addPlayerId ?? undefined,
                dropPlayerIds: dropKey ? dropKey.split(',') : [],
                toIr,
                toTaxi,
            })
            ticket.commit(() => setConflicts(next))
            return next
        } catch {
            ticket.commit(() => setConflicts([]))
            return []
        } finally {
            ticket.commit(() => setChecking(false))
        }
    }, [addPlayerId, dropKey, enabled, memberId, scope, toIr, toTaxi])

    useEffect(() => { void run() }, [run])
    useEffect(() => {
        if (!undoNotice) return
        const timer = setTimeout(() => setUndoNotice(null), 5000)
        return () => clearTimeout(timer)
    }, [undoNotice])

    const undoAcceptance = useCallback((conflict: RosterHoldConflict) => {
        if (!memberId) return
        const label = rosterHoldPartnerLabel(conflict.partnerTeamNames)
        const withLabel = label ? ` with ${label}` : ''
        confirmAction('Undo acceptance', `Undo your acceptance of the trade${withLabel}? The offer stays open, other teams keep their answers, and you can accept again.`, async () => {
            const ticket = scope.ticket()
            setUndoingTradeId(conflict.tradeId)
            try {
                const { undoTradeAcceptance } = await import('@/lib/trades')
                await undoTradeAcceptance(conflict.tradeId, memberId, conflict.version)
                ticket.commit(() => {
                    setConflicts((current) => current.filter((row) => row.tradeId !== conflict.tradeId))
                    setUndoNotice(`Acceptance undone. Your trade${withLabel} stays open.`)
                })
                await run()
            } catch (error) {
                if (ticket.live()) showAlert('Error', getErrorMessage(error))
                await run()
            } finally {
                ticket.commit(() => setUndoingTradeId(null))
            }
        }, 'Undo acceptance')
    }, [memberId, run, scope])

    return { conflicts, checking, recheck: run, undoAcceptance, undoingTradeId, undoNotice }
}
