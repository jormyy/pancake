import { useCallback, useEffect, useRef } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { useWebViewport } from '@/hooks/use-web-viewport'
import { nextRovingIndex } from '@/components/ui/rovingFocus'
import { scheduleWebFocusRecovery, shouldRecoverFocus } from '@/components/ui/webFocus'
import { LEAGUE_TABS, type LeagueTab } from '@/lib/league/tabs'

type LeagueTabBarProps = {
    activeTab: LeagueTab
    onTabChange: (tab: LeagueTab) => void
    compact?: boolean
}

const TAB_LABELS = Object.fromEntries(
    LEAGUE_TABS.map((tab) => [tab.key, tab.label]),
) as Record<LeagueTab, string>

type WebKeyboardEvent = {
    key: string
    preventDefault?: () => void
}

type WebKeyDownProps = {
    onKeyDown?: (event: WebKeyboardEvent) => void
}

function leagueTabBarAccessibilityLabel(activeTab: LeagueTab) {
    return `League sections, ${TAB_LABELS[activeTab]} selected`
}

function focusLeagueTab(tab: LeagueTab, shouldFocus: () => boolean): (() => void) | null {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return null
    const focus = () => {
        if (!shouldFocus()) return
        const target = document.getElementById(`league-tab-${tab}`)
        if (target instanceof HTMLElement && shouldRecoverFocus(target)) target.focus()
    }
    return scheduleWebFocusRecovery(focus)
}

export function LeagueTabBar({ activeTab, onTabChange }: LeagueTabBarProps) {
    const { viewportWidth, viewportHeight, compactLandscape } = useWebViewport()
    const compactShortPortrait = viewportWidth < 380 && viewportHeight < 760
    const compactTabs = compactLandscape || compactShortPortrait
    const pendingFocusTab = useRef<LeagueTab | null>(null)
    const focusRequestId = useRef(0)
    const cancelFocusRecovery = useRef<(() => void) | null>(null)

    const scheduleTabFocus = useCallback((tab: LeagueTab) => {
        const requestId = ++focusRequestId.current
        cancelFocusRecovery.current?.()
        cancelFocusRecovery.current = focusLeagueTab(tab, () => focusRequestId.current === requestId)
    }, [])

    useEffect(() => () => cancelFocusRecovery.current?.(), [])

    useEffect(() => {
        if (pendingFocusTab.current !== activeTab) return
        pendingFocusTab.current = null
        scheduleTabFocus(activeTab)
    }, [activeTab, scheduleTabFocus])

    function selectTab(tab: LeagueTab) {
        pendingFocusTab.current = tab
        onTabChange(tab)
        scheduleTabFocus(tab)
    }

    function handleKeyDown(event: WebKeyboardEvent, index: number) {
        const nextIndex = nextRovingIndex(index, event.key, LEAGUE_TABS.length)
        if (nextIndex == null) return

        event.preventDefault?.()
        selectTab(LEAGUE_TABS[nextIndex].key)
    }
    const tabBarAccessibilityLabel = leagueTabBarAccessibilityLabel(activeTab)

    // Horizontal scroll (like SegmentedControl's scrollable mode) keeps the
    // full descriptive tab labels on every breakpoint instead of swapping in
    // ambiguous short names ("Picks") on compact screens.
    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.tabScroll}
            contentContainerStyle={[styles.tabRow, compactTabs && styles.tabRowCompact]}
            role="tablist"
            aria-label={tabBarAccessibilityLabel}
            aria-orientation="horizontal"
            accessibilityRole="tablist"
            accessibilityLabel={tabBarAccessibilityLabel}
        >
            {LEAGUE_TABS.map((tab, index) => {
                const active = activeTab === tab.key
                const tabId = `league-tab-${tab.key}`
                const panelId = active ? `league-panel-${tab.key}` : undefined
                const webKeyProps: WebKeyDownProps = Platform.OS === 'web'
                    ? { onKeyDown: (event) => handleKeyDown(event, index) }
                    : {}
                return (
                    <Pressable
                        key={tab.key}
                        nativeID={tabId}
                        style={[styles.tabChip, compactTabs && styles.tabChipCompact, active && styles.tabChipActive]}
                        onPress={() => selectTab(tab.key)}
                        role="tab"
                        aria-label={tab.label}
                        aria-selected={active}
                        aria-controls={panelId}
                        tabIndex={active ? 0 : -1}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={tab.label}
                        {...webKeyProps}
                    >
                        <Text
                            style={[styles.tabChipText, compactTabs && styles.tabChipTextCompact, active && styles.tabChipTextActive]}
                            numberOfLines={1}
                        >
                            {tab.label}
                        </Text>
                    </Pressable>
                )
            })}
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    tabScroll: {
        flexGrow: 0,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    tabRow: {
        flexDirection: 'row',
        gap: spacing.sm,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
    },
    tabRowCompact: {
        gap: spacing.xs,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
    },
    tabChip: {
        minHeight: 44,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        justifyContent: 'center',
        alignItems: 'center',
    },
    tabChipCompact: {
        paddingHorizontal: spacing.md,
    },
    tabChipActive: { backgroundColor: colors.primary },
    tabChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    tabChipTextCompact: { fontSize: fontSize.xs },
    tabChipTextActive: { color: colors.textWhite },
})
