import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { useLeagues, LeagueMembership } from '@/hooks/use-leagues'
import { useAuth } from '@/hooks/use-auth'

type LeagueContextType = {
  memberships: LeagueMembership[]
  current: LeagueMembership | null
  setCurrent: (m: LeagueMembership) => void
  loading: boolean
  refresh: () => void
}

const LeagueContext = createContext<LeagueContextType | null>(null)

export function LeagueProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const { memberships, loading, refresh } = useLeagues()
  const [current, setCurrent] = useState<LeagueMembership | null>(null)

  // Auto-select first league once loaded
  useEffect(() => {
    if (memberships.length > 0 && !current) {
      setCurrent(memberships[0])
    }
    // If current league was removed, reset
    if (current && !memberships.find((m) => m.id === current.id)) {
      setCurrent(memberships[0] ?? null)
    }
  }, [memberships])

  // Reset when user changes
  useEffect(() => {
    setCurrent(null)
  }, [user?.id])

  return (
    <LeagueContext.Provider value={{ memberships, current, setCurrent, loading, refresh }}>
      {children}
    </LeagueContext.Provider>
  )
}

export function useLeagueContext() {
  const ctx = useContext(LeagueContext)
  if (!ctx) throw new Error('useLeagueContext must be used within LeagueProvider')
  return ctx
}
