import { useCallback, useEffect, useRef, useState } from 'react'
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
    const [withdrawingTradeId, setWithdrawingTradeId] = useState<string | null>(null)
    const [withdrawNotice, setWithdrawNotice] = useState<string | null>(null)
    const sequence = useRef(0)
    const dropKey = (dropPlayerIds ?? []).join(',')

    const run = useCallback(async () => {
        const requestId = ++sequence.current
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
            if (sequence.current === requestId) setConflicts(next)
            return next
        } catch {
            if (sequence.current === requestId) setConflicts([])
            return []
        } finally {
            if (sequence.current === requestId) setChecking(false)
        }
    }, [addPlayerId, dropKey, enabled, memberId, toIr, toTaxi])

    useEffect(() => { void run() }, [run])
    useEffect(() => () => { sequence.current += 1 }, [])
    useEffect(() => {
        if (!withdrawNotice) return
        const timer = setTimeout(() => setWithdrawNotice(null), 5000)
        return () => clearTimeout(timer)
    }, [withdrawNotice])

    const withdraw = useCallback((tradeId: string, partnerTeamNames: string[] = []) => {
        if (!memberId) return
        const label = rosterHoldPartnerLabel(partnerTeamNames)
        const withLabel = label ? ` with ${label}` : ''
        confirmAction('Withdraw acceptance', `Withdraw your acceptance of the trade${withLabel}? Other teams keep their answers and you can accept again.`, async () => {
            setWithdrawingTradeId(tradeId)
            try {
                const { retractTradeAcceptance } = await import('@/lib/trades')
                await retractTradeAcceptance(tradeId, memberId)
                setWithdrawNotice(`Acceptance withdrawn. Your trade${withLabel} stays open.`)
                await run()
            } catch (error) {
                showAlert('Error', getErrorMessage(error))
            } finally {
                setWithdrawingTradeId(null)
            }
        }, 'Withdraw acceptance')
    }, [memberId, run])

    return { conflicts, checking, recheck: run, withdraw, withdrawingTradeId, withdrawNotice }
}
