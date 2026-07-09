import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

type RealtimeEvent = '*' | 'INSERT' | 'UPDATE' | 'DELETE'

export type TableChangeWatch = {
    table: string
    filter?: string
    event?: RealtimeEvent
}

export function subscribeToTableChanges(
    channelName: string,
    watches: TableChangeWatch[],
    onChange: () => void,
): RealtimeChannel {
    const channel = supabase.channel(channelName, { config: { private: true } })
    for (const watch of watches) {
        channel.on(
            'postgres_changes',
            {
                event: watch.event ?? '*',
                schema: 'public',
                table: watch.table,
                ...(watch.filter ? { filter: watch.filter } : {}),
            },
            onChange,
        )
    }
    return channel.subscribe()
}

export function debounceRealtimeRefresh(onChange: () => void, delayMs = 250) {
    let timer: ReturnType<typeof setTimeout> | null = null
    const trigger = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
            timer = null
            onChange()
        }, delayMs)
    }
    const cancel = () => {
        if (!timer) return
        clearTimeout(timer)
        timer = null
    }
    return { trigger, cancel }
}

export function unsubscribeFromTableChanges(channel: RealtimeChannel) {
    supabase.removeChannel(channel)
}
