import { useEffect, useState } from 'react'
import { playerAge } from '@/lib/player-context'
import { onSessionCachesCleared, sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'

const birthdates = new Map<string, Promise<string | null>>()
let pending = new Map<string, (birthdate: string | null) => void>()

onSessionCachesCleared(() => {
    birthdates.clear()
    for (const resolve of pending.values()) resolve(null)
    pending = new Map()
})

async function flushBirthdates() {
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
                const { data, error } = await supabase.from('players').select('id,nba_id,birthdate').in(column, group.map(id => id.slice(column.length + 1)))
                if (error) throw error
                const values = new Map((data ?? []).map(player => [`${column}:${player[column]}`, player.birthdate]))
                for (const id of group) batch.get(id)?.(generation === sessionGeneration() ? values.get(id) ?? null : null)
            } catch {
                for (const id of group) {
                    if (generation === sessionGeneration()) birthdates.delete(id)
                    batch.get(id)?.(null)
                }
            }
        }
    }
}

function readBirthdate(playerId: string) {
    const cached = birthdates.get(playerId)
    if (cached) return cached
    const request = new Promise<string | null>(resolve => {
        pending.set(playerId, resolve)
        if (pending.size === 1) queueMicrotask(() => { void flushBirthdates() })
    })
    birthdates.set(playerId, request)
    return request
}

export function usePlayerAge(playerId?: string | null, birthdate?: string | null, age?: number | null, nbaId?: string | null) {
    const key = playerId ? `id:${playerId}` : nbaId ? `nba_id:${nbaId}` : null
    const generation = sessionGeneration()
    const [loaded, setLoaded] = useState<{ playerId: string; generation: number; birthdate: string | null } | null>(null)
    useEffect(() => {
        if (!key || birthdate !== undefined || age != null || !sessionOwner()) return
        let active = true
        void readBirthdate(key).then(value => {
            if (active && generation === sessionGeneration()) setLoaded({ playerId: key, generation, birthdate: value })
        })
        return () => { active = false }
    }, [key, birthdate, age, generation])
    const value = birthdate !== undefined ? birthdate : loaded && loaded.playerId === key && loaded.generation === generation ? loaded.birthdate : null
    return age ?? (value ? playerAge(value) : null)
}
