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
    const { back, replace, canGoBack } = useRouter()
    const finishSettings = () => {
        if (canGoBack()) back()
        else replace('/league?tab=settings')
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
        ownerId: user?.id ?? null,
        league,
        refresh,
        onDeleted: () => {
            if (canGoBack()) back()
            else replace('/league')
        },
    })

    return {
        ...settings,
        ...overrides,
        ...admin,
        isCommissioner,
        navigateBack: () => replace('/league?tab=settings'),
        tradeVetoModeDescription: tradeVetoDescription(settings.draft.tradeVetoMode),
    }
}
