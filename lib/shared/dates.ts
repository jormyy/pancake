/** Returns today's date as 'YYYY-MM-DD' string. */
export function todayDateString(): string {
    return new Date().toISOString().split('T')[0]
}
