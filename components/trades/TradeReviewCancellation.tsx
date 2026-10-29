import { useEffect, useRef, useState } from 'react'
import { Text } from 'react-native'
import { Button } from '@/components/ui/Button'
import { ErrorBanner } from '@/components/ui/ErrorBanner'
import { textStyles } from '@/constants/tokens'
import { confirmAction } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import { withdrawTrade, type Trade } from '@/lib/trades'

export function TradeReviewCancellation({ trade, memberId }: { trade: Trade; memberId: string }) {
    const active = useRef(true)
    const pending = useRef(false)
    const [saving, setSaving] = useState(false)
    const [cancelled, setCancelled] = useState(false)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        active.current = true
        return () => { active.current = false }
    }, [])
    const cancel = async () => {
        if (!active.current || pending.current) return
        pending.current = true
        setSaving(true)
        setError(null)
        try {
            await withdrawTrade(trade.id, memberId)
            if (active.current) setCancelled(true)
        } catch (cause) {
            if (active.current) setError(getErrorMessage(cause))
        } finally {
            pending.current = false
            if (active.current) setSaving(false)
        }
    }
    const requestCancel = () => confirmAction('Cancel trade?', 'Both rosters stay unchanged. Saved roster choices will not run.', cancel, 'Cancel trade')
    if (cancelled) return <Text style={textStyles.body}>Trade cancelled. Saved roster choices did not run.</Text>
    if (trade.status !== 'accepted' || trade.proposerMemberId !== memberId || !trade.vetoWindowExpiresAt || Date.parse(trade.vetoWindowExpiresAt) <= Date.now()) return null
    return <>
        {error ? <ErrorBanner message={error} onRetry={requestCancel} /> : null}
        <Button title="Cancel trade" variant="secondary" disabled={saving} loading={saving}
            onPress={requestCancel} />
    </>
}
