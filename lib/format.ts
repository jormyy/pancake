/** Shared formatting utilities — consolidated from multiple screens */

import { isIREligible } from '@pancake/core'
import { API_URL } from '@/lib/shared/api'

export function getInitials(name: string): string {
    const words = name.trim().split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w))
    // Prefer tokens that start with a letter so "Team #1" → "T", not "#".
    const letterWords = words.filter((w) => /^[a-zA-Z]/.test(w))
    const pick = letterWords.length ? letterWords : words
    if (pick.length >= 2) return (pick[0][0] + pick[pick.length - 1][0]).toUpperCase()
    if (pick.length === 1) return pick[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase()
    return (name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2) || '?').toUpperCase()
}

export const shortDateFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
})

/**
 * Player headshot URL, routed through the app's Edge proxy
 * (`/players/headshot/:nbaId`). The direct cdn.nba.com URL is blocked
 * cross-origin in the browser (loads via curl, fails via <Image>), so every
 * avatar fell back to initials; the proxy serves it same-origin. Returns null
 * when nbaId is absent (Avatar then shows initials). Mirrors the path the
 * Dynasty Hub already uses.
 */
export function playerHeadshotUrl(nbaId: string | null | undefined): string | null {
    if (!nbaId) return null
    return `${API_URL}/players/headshot/${nbaId}`
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

/** Fantasy points to one decimal, em-dash when absent: 12.3 → "12.3", null → "—" */
export function formatPoints(value: number | null | undefined): string {
    return value == null ? '—' : value.toFixed(1)
}

/** "3 picks", "1 pick" — count with pluralized noun */
export function countLabel(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** Predicate: roster player is on IR but no longer IR-eligible (should be moved off). */
export function isIneligibleIR(rp: { is_on_ir: boolean; players?: { injury_status: string | null } | null }): boolean {
    return Boolean(rp.is_on_ir && !isIREligible(rp.players?.injury_status ?? null))
}
