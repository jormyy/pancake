import { useCallback, useEffect, useRef } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { useWebViewport } from '@/hooks/use-web-viewport'
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

const FOCUS_RECOVERY_DELAYS = [0, 50, 150, 350, 700, 1200, 2000, 3000] as const
const INTERACTIVE_ROLES = new Set(['button', 'checkbox', 'combobox', 'link', 'menuitem', 'radio', 'switch', 'textbox'])

function nextTabIndex(currentIndex: number, key: string, count: number): number | null {
    if (key === 'ArrowRight' || key === 'ArrowDown') return (currentIndex + 1) % count
    if (key === 'ArrowLeft' || key === 'ArrowUp') return (currentIndex - 1 + count) % count
    if (key === 'Home') return 0
    if (key === 'End') return count - 1
    return null
}

function leagueTabBarAccessibilityLabel(activeTab: LeagueTab) {
    return `League sections, ${TAB_LABELS[activeTab]} selected`
}

function shouldRecoverFocus(target: HTMLElement) {
    const active = document.activeElement
    if (!active || active === target || active === document.body) return true
    if (!(active instanceof HTMLElement)) return false

    const role = active.getAttribute('role')
    if (role === 'tab') return true
    if (role && INTERACTIVE_ROLES.has(role)) return false
    if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return false
    return !active.isContentEditable
}

function focusLeagueTab(tab: LeagueTab, shouldFocus: () => boolean) {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return
    const focus = () => {
        if (!shouldFocus()) return
        const target = document.getElementById(`league-tab-${tab}`)
        if (target instanceof HTMLElement && shouldRecoverFocus(target)) target.focus()
    }
    for (const delay of FOCUS_RECOVERY_DELAYS) {
        if (delay === 0) requestAnimationFrame(focus)
        else setTimeout(focus, delay)
    }
}

export function LeagueTabBar({ activeTab, onTabChange }: LeagueTabBarProps) {
    const { viewportWidth, viewportHeight, compactLandscape } = useWebViewport()
    const compactShortPortrait = viewportWidth < 380 && viewportHeight < 760
    const compactTabs = compactLandscape || compactShortPortrait
    const pendingFocusTab = useRef<LeagueTab | null>(null)
    const focusRequestId = useRef(0)

    const scheduleTabFocus = useCallback((tab: LeagueTab) => {
        const requestId = ++focusRequestId.current
        focusLeagueTab(tab, () => focusRequestId.current === requestId)
    }, [])

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
        const nextIndex = nextTabIndex(index, event.key, LEAGUE_TABS.length)
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
