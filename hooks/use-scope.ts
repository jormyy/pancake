import { useEffect, useMemo, useRef } from 'react'
import { sessionGeneration } from '@/lib/session-cache-registry'

export type ScopeTicket = {
    readonly live: () => boolean
    readonly commit: (apply: () => void) => boolean
}

type Condition = () => boolean

export type Scope = {
    readonly ticket: (also?: Condition) => ScopeTicket
    readonly latest: (also?: Condition) => ScopeTicket
    readonly supersede: () => void
}

export function useScope(...identity: readonly unknown[]): Scope {
    const key = JSON.stringify(identity)
    const state = useRef({ key, mounted: false, latest: 0 })
    if (state.current.key !== key) state.current = { ...state.current, key, latest: state.current.latest + 1 }
    useEffect(() => {
        state.current.mounted = true
        return () => {
            state.current.mounted = false
            state.current.latest += 1
        }
    }, [])
    return useMemo(() => {
        const issue = (newest: boolean, also?: Condition): ScopeTicket => {
            const session = sessionGeneration()
            const turn = newest ? ++state.current.latest : null
            const live = () => state.current.mounted && state.current.key === key && sessionGeneration() === session
                && (turn === null || state.current.latest === turn) && (also?.() ?? true)
            return { live, commit: apply => live() && (apply(), true) }
        }
        return {
            ticket: also => issue(false, also),
            latest: also => issue(true, also),
            supersede: () => { state.current.latest += 1 },
        }
    }, [key])
}
