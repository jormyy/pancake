import { notificationEvents, notificationCategories, notificationEnabled, type NotificationCategory, type NotificationEvent } from '@/supabase/functions/_shared/notificationsPreferences'
import { withPwaMutation } from '@/lib/shared/pwa-mutation'
import { supabase } from '@/lib/supabase'

export type NotificationPreferences = {
    tradeEnabled: boolean
    waiverEnabled: boolean
    draftEnabled: boolean
    activityEnabled: boolean
    masterEnabled?: boolean
    categories?: Partial<Record<NotificationCategory, boolean>>
    events?: Partial<Record<NotificationEvent, boolean>>
}

export function createNotificationPreferenceWriter(
    write: (preferences: NotificationPreferences) => Promise<void>,
) {
    let queue: Promise<void> = Promise.resolve()
    return {
        enqueue(preferences: NotificationPreferences): Promise<void> {
            const previous = queue
            const task = withPwaMutation('notification preferences', () => previous.catch(() => undefined).then(() => write(preferences)))
            queue = task
            return task
        },
    }
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
    tradeEnabled: true,
    waiverEnabled: true,
    draftEnabled: true,
    activityEnabled: true,
    masterEnabled: true,
    categories: {},
    events: {},
}

type PreferenceRow = {
    trade_enabled: boolean
    waiver_enabled: boolean
    draft_enabled: boolean
    activity_enabled: boolean
    master_enabled?: boolean
    category_settings?: NotificationPreferences['categories']
    event_settings?: NotificationPreferences['events']
}

export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
    const { data, error } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()
    if (error) throw error
    if (!data) return DEFAULT_NOTIFICATION_PREFERENCES
    const row = data as PreferenceRow
    return {
        tradeEnabled: row.trade_enabled,
        waiverEnabled: row.waiver_enabled,
        draftEnabled: row.draft_enabled,
        activityEnabled: row.activity_enabled,
        masterEnabled: row.master_enabled ?? true,
        categories: row.category_settings ?? {},
        events: row.event_settings ?? {},
    }
}

export async function updateNotificationPreferences(
    userId: string,
    preferences: NotificationPreferences,
): Promise<void> {
    return withPwaMutation('updateNotificationPreferences', async () => {
        const { error } = await supabase
            .from('notification_preferences')
            .upsert({
                user_id: userId,
                trade_enabled: preferences.tradeEnabled,
                waiver_enabled: preferences.waiverEnabled,
                draft_enabled: preferences.draftEnabled,
                activity_enabled: preferences.activityEnabled,
                master_enabled: preferences.masterEnabled ?? true,
                category_settings: preferences.categories ?? {},
                event_settings: preferences.events ?? {},
                updated_at: new Date().toISOString(),
            })
        if (error) throw error
    })
}

export { notificationEvents, notificationCategories }
export type { NotificationCategory, NotificationEvent }

export function eventEnabled(preferences: NotificationPreferences, event: NotificationEvent): boolean {
    const definition = notificationEvents.find(item => item.key === event)!
    return notificationEnabled({
        trade_enabled: preferences.tradeEnabled,
        waiver_enabled: preferences.waiverEnabled,
        draft_enabled: preferences.draftEnabled,
        activity_enabled: preferences.activityEnabled,
        master_enabled: preferences.masterEnabled,
        category_settings: preferences.categories,
        event_settings: preferences.events,
    }, definition.category, event)
}

export function setNotificationCategory(
    preferences: NotificationPreferences,
    category: NotificationCategory,
    enabled: boolean,
): NotificationPreferences {
    const next = { ...preferences, categories: { ...preferences.categories, [category]: enabled } }
    if (category === 'trade') next.tradeEnabled = enabled
    else if (category === 'waiver') next.waiverEnabled = enabled
    else if (category === 'draft') next.draftEnabled = enabled
    else if (enabled && !preferences.activityEnabled) {
        next.activityEnabled = true
        next.categories = { ...next.categories, player: false, lineup: false, matchup: false, playoff: false, league: false, [category]: true }
    }
    return next
}
