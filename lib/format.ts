/** Shared formatting utilities — consolidated from multiple screens */

export function getInitials(name: string): string {
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return name.slice(0, 2).toUpperCase()
}

export const shortDateFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
})

/** NBA CDN headshot URL. Returns null when nbaId is absent. */
export function playerHeadshotUrl(nbaId: string | null | undefined): string | null {
    if (!nbaId) return null
    return `https://cdn.nba.com/headshots/nba/latest/260x190/${nbaId}.png`
}

/** "Damian Lillard" → "D. Lillard" */
export function shortName(name: string): string {
    const parts = name.trim().split(/\s+/)
    if (parts.length < 2) return name
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

/** 2025 → "'25" */
export function yearShort(year: number): string {
    return `'${String(year).slice(2)}`
}

/** ISO string → "2h ago", "3d ago", etc. */
export function timeAgo(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diffMs / 60_000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
}

/** Predicate: roster player is on IR but no longer IR-eligible (should be moved off). */
export function isIneligibleIR(rp: { is_on_ir: boolean; players?: { injury_status: string | null } | null }): boolean {
    if (!rp.is_on_ir) return false
    const status = rp.players?.injury_status?.toUpperCase()
    return !status || !['OFS', 'INJ', 'OUT', 'IR', 'IR-R'].includes(status)
}
