import { describe, expect, it, vi } from 'vitest'

const { readPreferences } = vi.hoisted(() => ({ readPreferences: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: readPreferences }) }) }),
} }))
import {
    createNotificationPreferenceWriter,
    eventEnabled,
    getNotificationPreferences,
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


describe('stored notification preference JSON', () => {
    const row = {
        trade_enabled: true, waiver_enabled: true, draft_enabled: true, activity_enabled: true, master_enabled: true,
    }
    const malformed: { label: string; value: unknown }[] = [
        { label: 'null', value: null },
        { label: 'array', value: [true, false] },
        { label: 'string', value: 'true' },
        { label: 'number', value: 1 },
        { label: 'boolean', value: true },
        { label: 'non-boolean values', value: { trade: 'false', draft: 1, trade_offered: 0, draft_timer_expiring: 'true', owned_player_ruled_out: 1 } },
        { label: 'unknown keys', value: { unknown: true, constructor: true, toString: false } },
    ]
    it.each(malformed)('$label falls back to the catalog defaults', async ({ value }) => {
        readPreferences.mockResolvedValueOnce({ data: { ...row, category_settings: value, event_settings: value }, error: null })
        const loaded = await getNotificationPreferences('user')
        expect(loaded.categories).toEqual({})
        expect(loaded.events).toEqual({})
        for (const event of notificationEvents) expect(eventEnabled(loaded, event.key)).toBe(event.defaultEnabled)
    })

    it('keeps known booleans and rejects malformed siblings and unknown keys', async () => {
        readPreferences.mockResolvedValueOnce({ data: { ...row,
            category_settings: { trade: false, draft: true, matchup: 'false', unknown: true },
            event_settings: { trade_offered: true, draft_on_clock: false, draft_timer_expiring: 'true', unknown: true },
        }, error: null })
        const loaded = await getNotificationPreferences('user')
        expect(loaded.categories).toEqual({ trade: false, draft: true })
        expect(loaded.events).toEqual({ trade_offered: true, draft_on_clock: false })
        expect(eventEnabled(loaded, 'trade_offered')).toBe(false)
        expect(eventEnabled(loaded, 'draft_on_clock')).toBe(false)
        expect(eventEnabled(loaded, 'draft_timer_expiring')).toBe(false)
    })

    it.each(malformed)('$label cannot override legacy opt-outs', async ({ value }) => {
        readPreferences.mockResolvedValueOnce({ data: { ...row,
            trade_enabled: false, waiver_enabled: false, draft_enabled: false, activity_enabled: false,
            category_settings: value, event_settings: value,
        }, error: null })
        const loaded = await getNotificationPreferences('user')
        for (const event of notificationEvents) expect(eventEnabled(loaded, event.key)).toBe(false)
    })

    it.each(malformed)('$label cannot override event opt-outs', async ({ value }) => {
        readPreferences.mockResolvedValueOnce({ data: { ...row, category_settings: value,
            event_settings: Object.fromEntries(notificationEvents.map(event => [event.key, false])),
        }, error: null })
        const loaded = await getNotificationPreferences('user')
        for (const event of notificationEvents) expect(eventEnabled(loaded, event.key)).toBe(false)
    })

    it.each(malformed)('$label cannot override category opt-outs', async ({ value }) => {
        readPreferences.mockResolvedValueOnce({ data: { ...row, event_settings: value,
            category_settings: Object.fromEntries(notificationEvents.map(event => [event.category, false])),
        }, error: null })
        const loaded = await getNotificationPreferences('user')
        for (const event of notificationEvents) expect(eventEnabled(loaded, event.key)).toBe(false)
    })

    it('keeps a master opt-out when valid maps enable every event', async () => {
        readPreferences.mockResolvedValueOnce({ data: { ...row, master_enabled: false,
            category_settings: Object.fromEntries(notificationEvents.map(event => [event.category, true])),
            event_settings: Object.fromEntries(notificationEvents.map(event => [event.key, true])),
        }, error: null })
        const loaded = await getNotificationPreferences('user')
        for (const event of notificationEvents) expect(eventEnabled(loaded, event.key)).toBe(false)
    })
})
