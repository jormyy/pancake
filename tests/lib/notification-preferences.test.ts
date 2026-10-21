import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import {
    createNotificationPreferenceWriter,
    eventEnabled,
    setNotificationCategory,
    notificationEvents,
    type NotificationPreferences,
} from '@/lib/notification-preferences'

const preferences = (tradeEnabled: boolean, waiverEnabled: boolean): NotificationPreferences => ({
    tradeEnabled,
    waiverEnabled,
    draftEnabled: true,
    activityEnabled: true,
})

const deferred = () => {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

describe('notification preference writer', () => {
    it('serializes full-snapshot writes so responses cannot reorder', async () => {
        const first = deferred()
        const write = vi.fn()
            .mockReturnValueOnce(first.promise)
            .mockResolvedValueOnce(undefined)
        const writer = createNotificationPreferenceWriter(write)

        const firstTask = writer.enqueue(preferences(false, true))
        const secondTask = writer.enqueue(preferences(false, false))
        await Promise.resolve()
        await Promise.resolve()
        expect(write).toHaveBeenCalledOnce()

        first.resolve()
        await firstTask
        await secondTask
        expect(write.mock.calls.map(([value]) => value)).toEqual([
            preferences(false, true),
            preferences(false, false),
        ])
    })

    it('continues the queue after an earlier write fails', async () => {
        const write = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(undefined)
        const writer = createNotificationPreferenceWriter(write)

        await expect(writer.enqueue(preferences(false, true))).rejects.toThrow('offline')
        await expect(writer.enqueue(preferences(false, false))).resolves.toBeUndefined()
        expect(write).toHaveBeenCalledTimes(2)
    })
})


describe('event preference resolution', () => {
    it.each(notificationEvents)('$key respects master, category, event and its default', event => {
        const base = preferences(true, true)
        expect(eventEnabled(base, event.key)).toBe(event.defaultEnabled)
        expect(eventEnabled({ ...base, events: { [event.key]: true } }, event.key)).toBe(true)
        expect(eventEnabled({ ...base, events: { [event.key]: false } }, event.key)).toBe(false)
        expect(eventEnabled({ ...base, masterEnabled: false, events: { [event.key]: true } }, event.key)).toBe(false)
        expect(eventEnabled({ ...base, categories: { [event.category]: false }, events: { [event.key]: true } }, event.key)).toBe(false)
        const disabledLegacy = { ...base, tradeEnabled: false, waiverEnabled: false, draftEnabled: false, activityEnabled: false }
        expect(eventEnabled({ ...disabledLegacy, events: { [event.key]: true } }, event.key)).toBe(false)
    })
})

it('enabling one activity category preserves the other legacy opt-outs', () => {
    const original: NotificationPreferences = { ...preferences(true, true), activityEnabled: false,
        categories: { player: true, lineup: true, matchup: true, playoff: true, league: true } }
    const next = setNotificationCategory(original, 'matchup', true)
    expect(next.activityEnabled).toBe(true)
    expect(eventEnabled(next, 'matchup_final')).toBe(true)
    for (const event of ['owned_player_status', 'lineup_empty', 'playoff_clinched', 'league_settings_changed'] as const) {
        expect(eventEnabled({ ...next, events: { [event]: true } }, event)).toBe(false)
    }
    expect(next.tradeEnabled).toBe(true)
})
