import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'

type RealtimeEvent = '*' | 'INSERT' | 'UPDATE' | 'DELETE'

export type TableChangeWatch = {
    table: string
    filter?: string
    event?: RealtimeEvent
    onChange: (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void
}

export type FallbackTableChangeWatch = Omit<TableChangeWatch, 'onChange'>
