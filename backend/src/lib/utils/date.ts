/** Returns today's date string in ET (YYYY-MM-DD).
 * NBA game_date values use ET, so callers must use this — UTC rolls over ~5 hours early. */
export function todayET(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}
