import { useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { tradeVetoDescription } from '@/components/commissioner/settings-policy'
import { useCommissionerAdminActions } from '@/hooks/use-commissioner-admin-actions'
import { useCommissionerOverrides } from '@/hooks/use-commissioner-overrides'
import { useCommissionerSettingsResource } from '@/hooks/use-commissioner-settings-resource'

export function useCommissionerSettingsController() {
    const { currentLeague: league, isCommissioner, refresh } = useLeagueContext()
    const { back, replace } = useRouter()
    const settings = useCommissionerSettingsResource({
        league,
        isCommissioner,
        refresh,
        onSaved: back,
    })
    const overrides = useCommissionerOverrides(league?.id, settings.members)
    const admin = useCommissionerAdminActions({
        league,
        refresh,
        onDeleted: back,
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
