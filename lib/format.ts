import { compactPlayerName } from '@/lib/compact-player-name'
/** Shared formatting utilities — consolidated from multiple screens */

import { API_URL } from '@/lib/shared/api'

export function getInitials(name: string | null | undefined): string {
    // Names flow in from `display_name`, which is nullable in the DB despite the
    // callers' non-null casts — tolerate null so an Avatar can't crash a render.
    const safe = (name ?? '').trim()
    const words = safe.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w))
    // Prefer tokens that start with a letter so "Team #1" → "T", not "#".
    const letterWords = words.filter((w) => /^[a-zA-Z]/.test(w))
    const pick = letterWords.length ? letterWords : words
    if (pick.length >= 2) return (pick[0][0] + pick[pick.length - 1][0]).toUpperCase()
    if (pick.length === 1) return pick[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase()
    return (safe.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2) || '?').toUpperCase()
}

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
    return compactPlayerName(name)
}

/** 2025 → "'25" */
export function yearShort(year: number): string {
    return `'${String(year).slice(2)}`
}

/** Fantasy points to one decimal, em-dash when absent: 12.3 → "12.3", null → "—" */
export function formatPoints(value: number | null | undefined): string {
    return value == null ? '—' : value.toFixed(1)
}

/** "3 picks", "1 pick" — count with pluralized noun */
export function countLabel(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** Draft clock: "0:05" and "1:15" under an hour; "2h 5m", then "28h", for slow clocks. */
export function formatCountdown(totalSeconds: number): string {
    const seconds = Math.max(0, Math.floor(totalSeconds))
    if (seconds < 3600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return hours < 10 && minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}
