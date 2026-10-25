import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { colors, radii, spacing, textStyles } from '@/constants/tokens'
import {
    eventEnabled,
    setNotificationCategory,
    notificationCategories,
    notificationEvents,
    type NotificationCategory,
    type NotificationPreferences,
} from '@/lib/notification-preferences'
import { SettingsGroup, SettingsRow, SettingsToggle } from './SettingsGroup'
import { notificationSwitchKeyboardProps } from './NotificationSwitchKeyboard'

const legacyKeys = { trade: 'tradeEnabled', waiver: 'waiverEnabled', draft: 'draftEnabled' } as const

export function NotificationSettings({ preferences, disabled, onChange }: {
    preferences: NotificationPreferences
    disabled: boolean
    onChange: (update: (current: NotificationPreferences) => NotificationPreferences) => void
}) {
    const [expanded, setExpanded] = useState<Partial<Record<NotificationCategory, boolean>>>({ trade: true, draft: true, waiver: true })
    const master = preferences.masterEnabled !== false
    function categoryEnabled(category: NotificationCategory, current = preferences) {
        const legacy = category in legacyKeys ? current[legacyKeys[category as keyof typeof legacyKeys]] : current.activityEnabled
        return legacy && current.categories?.[category] !== false
    }
    function toggleCategory(category: NotificationCategory) {
        onChange(current => setNotificationCategory(current, category, !categoryEnabled(category, current)))
    }
    const anyExpanded = Object.values(expanded).some(Boolean)
    return (
        <View style={styles.content}>
            <SettingsGroup>
                <SettingsRow label="All notifications" role="switch" checked={master} disabled={disabled}
                    onPress={() => onChange(current => ({ ...current, masterEnabled: current.masterEnabled === false }))}
                    accessory={<SettingsToggle on={master} />} />
                <SettingsRow label={anyExpanded ? 'Collapse all' : 'Expand all'} disabled={disabled}
                    onPress={() => setExpanded(Object.fromEntries(Object.keys(notificationCategories).map(key => [key, !anyExpanded])))} />
            </SettingsGroup>
            {(Object.keys(notificationCategories) as NotificationCategory[]).map(category => (
                <View key={category} style={styles.card}>
                    <View style={styles.header}>
                        <Pressable style={styles.heading} role="button" aria-expanded={!!expanded[category]}
                            accessibilityLabel={`${notificationCategories[category]} events`}
                            onPress={() => setExpanded(current => ({ ...current, [category]: !current[category] }))}>
                            <Text style={textStyles.rowTitle} numberOfLines={1}>{notificationCategories[category]}</Text>
                            <MaterialIcons name={expanded[category] ? 'expand-less' : 'expand-more'} size={22} color={colors.textMuted} />
                        </Pressable>
                        <Pressable style={styles.categorySwitch} role="switch" aria-checked={categoryEnabled(category)}
                            accessibilityLabel={`All ${notificationCategories[category].toLowerCase()} notifications`}
                            accessibilityState={{ disabled: disabled || !master, checked: categoryEnabled(category) }}
                            disabled={disabled || !master} onPress={() => toggleCategory(category)}
                            {...notificationSwitchKeyboardProps(() => toggleCategory(category), disabled || !master)}>
                            <SettingsToggle on={categoryEnabled(category)} />
                        </Pressable>
                    </View>
                    {expanded[category] ? notificationEvents.filter(event => event.category === category && event.key !== 'watched_player_dropped').map(event => (
                        <Pressable key={event.key} style={[styles.event, (!master || !categoryEnabled(category)) && styles.dimmed]}
                            role="switch" aria-checked={eventEnabled(preferences, event.key)}
                            accessibilityLabel={`${notificationCategories[category]}: ${event.label}`}
                            accessibilityState={{ disabled: disabled || !master || !categoryEnabled(category), checked: eventEnabled(preferences, event.key) }}
                            disabled={disabled || !master || !categoryEnabled(category)}
                            {...notificationSwitchKeyboardProps(() => onChange(current => ({ ...current, events: { ...current.events, [event.key]: !eventEnabled(current, event.key) } })), disabled || !master || !categoryEnabled(category))}
                            onPress={() => onChange(current => ({ ...current, events: { ...current.events, [event.key]: !eventEnabled(current, event.key) } }))}>
                            <Text style={[textStyles.body, styles.label]} numberOfLines={1}>{event.label}</Text>
                            <SettingsToggle on={eventEnabled(preferences, event.key)} />
                        </Pressable>
                    )) : null}
                </View>
            ))}
        </View>
    )
}

const styles = StyleSheet.create({
    content: { gap: spacing.md },
    card: { backgroundColor: colors.bgCard, borderColor: colors.borderLight, borderWidth: 1, borderRadius: radii.lg, overflow: 'hidden' },
    header: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
    heading: { flex: 1, minWidth: 0, paddingLeft: spacing.lg, paddingVertical: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    categorySwitch: { minWidth: 64, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    event: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, borderTopWidth: 1, borderTopColor: colors.separator },
    label: { flex: 1, minWidth: 0 },
    dimmed: { opacity: 0.5 },
})
