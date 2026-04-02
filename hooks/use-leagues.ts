import { fetchUserLeagues } from '@/lib/league'
import { useAsyncData } from '@/hooks/use-async-data'
import { useAuth } from '@/hooks/use-auth'

export type LeagueMembership = Awaited<ReturnType<typeof fetchUserLeagues>>[number]

export function useLeagues() {
    const { user } = useAuth()
    const { data, loading, error, refresh } = useAsyncData(
        async () => {
            if (!user) return [] as LeagueMembership[]
            return fetchUserLeagues(user.id)
        },
        [user?.id],
    )
    return { memberships: data ?? [], loading, error, refresh }
}
