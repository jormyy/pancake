import { useEffect, useState } from 'react'
import { onSessionCachesCleared, sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'

// List screens don't carry jersey numbers, so rows batch one read per tick and share the cache.
const jerseys = new Map<string, Promise<string | null>>()
let pending = new Map<string, (jersey: string | null) => void>()

onSessionCachesCleared(() => {
    jerseys.clear()
    for (const resolve of pending.values()) resolve(null)
    pending = new Map()
})

async function flushJerseys() {
    const { supabase } = await import('@/lib/supabase')
    const batch = pending
    pending = new Map()
    const generation = sessionGeneration()
    const ids = [...batch.keys()]
    for (const column of ['id', 'nba_id'] as const) {
        const matching = ids.filter(id => id.startsWith(`${column}:`))
        for (let offset = 0; offset < matching.length; offset += 100) {
            const group = matching.slice(offset, offset + 100)
            try {
                const { data, error } = await supabase.from('players').select('id,nba_id,jersey_number').in(column, group.map(id => id.slice(column.length + 1)))
                if (error) throw error
                const values = new Map((data ?? []).map(player => [`${column}:${player[column]}`, player.jersey_number]))
                for (const id of group) batch.get(id)?.(generation === sessionGeneration() ? values.get(id) ?? null : null)
            } catch {
                for (const id of group) {
                    if (generation === sessionGeneration()) jerseys.delete(id)
                    batch.get(id)?.(null)
                }
            }
        }
    }
}

function readJersey(key: string) {
    const cached = jerseys.get(key)
    if (cached) return cached
    const request = new Promise<string | null>(resolve => {
        pending.set(key, resolve)
        if (pending.size === 1) queueMicrotask(() => { void flushJerseys() })
    })
    jerseys.set(key, request)
    return request
}

/** A player's jersey number: the supplied value when the screen has one, otherwise a shared batched read. */
export function useJerseyNumber(playerId?: string | null, nbaId?: string | null, jerseyNumber?: string | null) {
    const key = playerId ? `id:${playerId}` : nbaId ? `nba_id:${nbaId}` : null
    const generation = sessionGeneration()
    const [loaded, setLoaded] = useState<{ key: string; generation: number; jersey: string | null } | null>(null)
    useEffect(() => {
        if (!key || jerseyNumber !== undefined || !sessionOwner()) return
        let active = true
        void readJersey(key).then(value => {
            if (active && generation === sessionGeneration()) setLoaded({ key, generation, jersey: value })
        })
        return () => { active = false }
    }, [key, jerseyNumber, generation])
    if (jerseyNumber !== undefined) return jerseyNumber
    return loaded && loaded.key === key && loaded.generation === generation ? loaded.jersey : null
}
