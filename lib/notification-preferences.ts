import { supabase } from '@/lib/supabase'

export type NotificationPreferences = {
    tradeEnabled: boolean
    waiverEnabled: boolean
    draftEnabled: boolean
    activityEnabled: boolean
}

export function createNotificationPreferenceWriter(
    write: (preferences: NotificationPreferences) => Promise<void>,
) {
    let queue: Promise<void> = Promise.resolve()
    return {
        enqueue(preferences: NotificationPreferences): Promise<void> {
            const task = queue.catch(() => undefined).then(() => write(preferences))
            queue = task
            return task
        },
    }
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
    tradeEnabled: true,
    waiverEnabled: true,
    draftEnabled: true,
    activityEnabled: true,
}

type PreferenceRow = {
    trade_enabled: boolean
    waiver_enabled: boolean
    draft_enabled: boolean
    activity_enabled: boolean
}

export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
    const { data, error } = await supabase
        .from('notification_preferences')
        .select('trade_enabled, waiver_enabled, draft_enabled, activity_enabled')
        .eq('user_id', userId)
        .maybeSingle()
    if (error) throw error
    if (!data) return DEFAULT_PREFERENCES
    const row = data as PreferenceRow
    return {
        tradeEnabled: row.trade_enabled,
        waiverEnabled: row.waiver_enabled,
        draftEnabled: row.draft_enabled,
        activityEnabled: row.activity_enabled,
    }
}

export async function updateNotificationPreferences(
    userId: string,
    preferences: NotificationPreferences,
): Promise<void> {
    const { error } = await supabase
        .from('notification_preferences')
        .upsert({
            user_id: userId,
            trade_enabled: preferences.tradeEnabled,
            waiver_enabled: preferences.waiverEnabled,
            draft_enabled: preferences.draftEnabled,
            activity_enabled: preferences.activityEnabled,
            updated_at: new Date().toISOString(),
        })
    if (error) throw error
}
