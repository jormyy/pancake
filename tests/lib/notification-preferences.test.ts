import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import {
    createNotificationPreferenceWriter,
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
