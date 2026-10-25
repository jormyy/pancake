import { beforeEach, expect, it, vi } from 'vitest'
import { useCommissionerSettingsController } from '@/hooks/use-commissioner-settings-controller'

const mocks = vi.hoisted(() => ({
    back: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), canGoBack: vi.fn(),
    settings: vi.fn(), admin: vi.fn(),
}))
vi.mock('expo-router', () => ({ useRouter: () => mocks }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: { id: 'league' }, isCommissioner: true, refresh: vi.fn() }) }))
vi.mock('@/hooks/use-commissioner-settings-resource', () => ({ useCommissionerSettingsResource: mocks.settings }))
vi.mock('@/hooks/use-commissioner-admin-actions', () => ({ useCommissionerAdminActions: mocks.admin }))
vi.mock('@/hooks/use-commissioner-overrides', () => ({ useCommissionerOverrides: () => ({ handleFaabOverride: vi.fn(), handleAddCountOverride: vi.fn() }) }))

beforeEach(() => {
    vi.clearAllMocks()
    mocks.canGoBack.mockReturnValue(false)
    mocks.settings.mockReturnValue({
        members: [], draft: { tradeVetoMode: 'disabled' },
        authorityReady: true, revalidateAuthority: vi.fn(async () => true),
    })
    mocks.admin.mockReturnValue({
        lifecycle: { label: 'Schedule Controls', detail: 'Manage the schedule.', actions: [] },
        lowerPriorityActions: [], busyAction: null, handleDeleteLeague: vi.fn(),
    })
})

it('leaves a directly opened settings page after saving', () => {
    useCommissionerSettingsController()
    mocks.settings.mock.calls[0][0].onSaved()
    expect(mocks.dismissTo).toHaveBeenCalledWith('/league?tab=settings')
    expect(mocks.back).not.toHaveBeenCalled()
})

it('leaves a directly opened archived league after confirmation', () => {
    useCommissionerSettingsController()
    mocks.admin.mock.calls[0][0].onDeleted()
    expect(mocks.dismissTo).toHaveBeenCalledWith('/league')
    expect(mocks.back).not.toHaveBeenCalled()
})

it('returns to the prior in-app screen after a normal save', () => {
    mocks.canGoBack.mockReturnValue(true)
    useCommissionerSettingsController()
    mocks.settings.mock.calls[0][0].onSaved()
    expect(mocks.back).toHaveBeenCalledOnce()
    expect(mocks.dismissTo).not.toHaveBeenCalled()
})

it('uses the current stack for the settings Back action', () => {
    mocks.canGoBack.mockReturnValue(true)
    useCommissionerSettingsController().navigateBack()
    expect(mocks.back).toHaveBeenCalledOnce()
    expect(mocks.dismissTo).not.toHaveBeenCalled()
})
