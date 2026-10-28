import { formatLeagueTime } from '@/lib/timezone'
export function draftPlayerMeta(parts: (string | null | undefined)[]): string {
    return parts.filter(Boolean).join(' · ') || '—'
}

export function draftEventTime(value: string | null | undefined, timezone?: string): string | null {
    if (!value) return null
    return formatLeagueTime(value, timezone)
}
