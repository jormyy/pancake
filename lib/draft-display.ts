export function draftAgeLabel(age: number | null | undefined): string | null {
    if (age == null || !Number.isFinite(age)) return null
    return `Age ${Number(age).toFixed(1)}`
}

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
