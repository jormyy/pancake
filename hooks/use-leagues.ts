import { useEffect, useState, useCallback } from 'react'
import { fetchUserLeagues } from '@/lib/league'
import { useAuth } from '@/hooks/use-auth'

export type LeagueMembership = Awaited<ReturnType<typeof fetchUserLeagues>>[number]

export function useLeagues() {
    const { user } = useAuth()
    const [memberships, setMemberships] = useState<LeagueMembership[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        if (!user) return
        setLoading(true)
        setError(null)
        try {
            const data = await fetchUserLeagues(user.id)
            setMemberships(data)
        } catch (e: any) {
            setError(e.message)
        } finally {
            setLoading(false)
        }
    }, [user])

    useEffect(() => {
        load()
    }, [load])

    return { memberships, loading, error, refresh: load }
}
