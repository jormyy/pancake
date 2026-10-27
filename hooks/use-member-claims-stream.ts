import { useEffect } from 'react'
import { notifyMemberClaimsChanged } from '@/lib/claim-updates'
import { sessionGeneration } from '@/lib/session-cache-registry'

export function useMemberClaimsStream(memberId: string | undefined, userId: string | null, validated: boolean) {
    useEffect(() => {
        if (!memberId || !userId || !validated) return
        let disposed = false
        let cleanup: (() => void) | undefined
        const generation = sessionGeneration()
        const changed = () => {
            if (!disposed && generation === sessionGeneration()) notifyMemberClaimsChanged(memberId)
        }
        void import('@/lib/realtime').then(({ subscribeToTableChanges, unsubscribeFromTableChanges, reportRealtimeCleanup }) => {
            if (disposed || generation !== sessionGeneration()) return
            const channel = subscribeToTableChanges(`member-claims:${memberId}:${userId}`, {
                mode: 'per-watch',
                watches: [{ table: 'waiver_claims', filter: `member_id=eq.${memberId}`, onChange: changed }],
                onStatus: status => { if (status === 'SUBSCRIBED') changed() },
            })
            cleanup = () => reportRealtimeCleanup('member claims', unsubscribeFromTableChanges(channel))
        }).catch(error => { if (!disposed) console.error('Could not subscribe to member claims.', error) })
        return () => { disposed = true; cleanup?.() }
    }, [memberId, userId, validated])
}
