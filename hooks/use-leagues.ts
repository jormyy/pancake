import { fetchUserLeagues } from '@/lib/league'
import { useAsyncData } from '@/hooks/use-async-data'
import { useAuth } from '@/hooks/use-auth'
import type { LeagueMembership } from '@/types/app'

export type { LeagueMembership }

export function useLeagues() {
    const { user } = useAuth()
    const { data, loading, error, refresh } = useAsyncData(
        async () => {
            if (!user) return [] as LeagueMembership[]
            const rows = await fetchUserLeagues(user.id)
            return rows as LeagueMembership[]
        },
        [user?.id],
    )
    return { memberships: data ?? [], loading, error, refresh }
}
