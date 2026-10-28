export function draftPlayerMeta(parts: (string | null | undefined)[]): string {
    return parts.filter(Boolean).join(' · ') || '—'
}

export function draftEventTime(value: string | null | undefined): string | null {
    if (!value) return null
    return new Date(value).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
    })
}
