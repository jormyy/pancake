import type { CommissionerAction } from '@/lib/commissioner-settings-policy'
import { useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { tradeVetoDescription } from '@/lib/commissioner-settings-policy'
import { useCommissionerAdminActions } from '@/hooks/use-commissioner-admin-actions'
import { useCommissionerOverrides } from '@/hooks/use-commissioner-overrides'
import { useCommissionerSettingsResource } from '@/hooks/use-commissioner-settings-resource'
import { useAuth } from '@/hooks/use-auth'

export function useCommissionerSettingsController() {
    const { currentLeague: league, isCommissioner, refresh } = useLeagueContext()
    const { user } = useAuth()
    const { back, dismissTo, canGoBack } = useRouter()
    const finishSettings = () => {
        if (canGoBack()) back()
        else dismissTo('/league?tab=settings')
    }
    const settings = useCommissionerSettingsResource({
        league,
        ownerId: user?.id ?? null,
        isCommissioner,
        refresh,
        onSaved: finishSettings,
    })
    const overrides = useCommissionerOverrides(user?.id ?? null, league?.id, settings.members)
    const admin = useCommissionerAdminActions({
        ownerId: settings.authorityReady ? user?.id ?? null : null,
        league,
        refresh,
        scheduleStart: settings.playoffCalendar?.ranges?.find(week => !settings.playoffCalendar?.skippedWeeks?.includes(week.week_number))?.week_start,
        onDeleted: () => {
            if (canGoBack()) back()
            else dismissTo('/league')
        },
    })

    const authorize = (action: () => void | Promise<unknown>) => async () => {
        if (await settings.revalidateAuthority()) await action()
    }
    const guardAction = (action: CommissionerAction): CommissionerAction => ({ ...action, onPress: authorize(action.onPress) })

    return {
        ...settings,
        ...overrides,
        ...admin,
        handleFaabOverride: authorize(overrides.handleFaabOverride),
        handleAddCountOverride: authorize(overrides.handleAddCountOverride),
        handleDeleteLeague: authorize(admin.handleDeleteLeague),
        lifecycle: { ...admin.lifecycle, actions: admin.lifecycle.actions.map(guardAction) },
        lowerPriorityActions: admin.lowerPriorityActions.map(guardAction),
        isCommissioner,
        navigateBack: finishSettings,
        tradeVetoModeDescription: tradeVetoDescription(settings.draft.tradeVetoMode),
    }
}
