import { useEffect, useSyncExternalStore } from 'react'
import { mutationSnapshot, retryMutation, subscribeMutations, replayMutations } from '@/lib/cache/mutation-queue'
import { sessionGeneration } from '@/lib/session-cache-registry'

export function usePendingMutations(accountId?: string | null, leagueId?: string | null) {
    const jobs = useSyncExternalStore(subscribeMutations, mutationSnapshot, mutationSnapshot)
    const generation = sessionGeneration()
    useEffect(() => { void replayMutations() }, [generation, accountId])
    const pending = jobs.filter(job => job.accountId === accountId && (!leagueId || !job.leagueId || job.leagueId === leagueId))
    return { pending, retry: retryMutation, isPending: (rowId: string) => pending.some(job => job.rowIds.includes(rowId)) }
}
