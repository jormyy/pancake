import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SignInScreen from '@/app/(auth)/sign-in'
import SignUpScreen from '@/app/(auth)/sign-up'
import ChangePasswordScreen from '@/app/(modals)/change-password'

const mocks = vi.hoisted(() => ({ signIn: vi.fn(), signUp: vi.fn(), changePassword: vi.fn(), back: vi.fn(), success: vi.fn() }))

vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles },
    View: 'View', Text: 'Text', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView',
}))
vi.mock('expo-router', () => ({ Link: 'Link', Stack: { Screen: () => null } }))
vi.mock('@/components/ui', () => ({ Input: 'Input', Button: 'Button', usePageMetrics: () => ({ padX: 16 }) }))
vi.mock('@/components/ui/ModalScreen', () => ({
    ModalScreen: ({ actions, children }: React.PropsWithChildren<{ actions: React.ReactNode }>) => React.createElement('View', null, actions, children),
}))
vi.mock('@/components/auth/AuthScaffold', () => ({ AuthScaffold: ({ children }: React.PropsWithChildren) => children }))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => mocks.back }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ loading: false, restorationStatus: null }) }))
vi.mock('@/lib/auth', () => ({ signIn: mocks.signIn, signUp: mocks.signUp, changePassword: mocks.changePassword }))
vi.mock('@/lib/alert', () => ({ showSuccess: mocks.success }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const forms = [
    { name: 'sign in', Screen: SignInScreen, request: mocks.signIn, values: { Email: 'manager@example.test', Password: 'old-password' } },
    { name: 'sign up', Screen: SignUpScreen, request: mocks.signUp, values: {
        'Display name': 'Manager', Username: 'manager', Email: 'manager@example.test', Password: 'new-password',
    } },
    { name: 'change password', Screen: ChangePasswordScreen, request: mocks.changePassword, values: {
        'Current password': 'old-password', 'New password': 'new-password', 'Confirm new password': 'new-password',
    } },
]

describe('auth form submission', () => {
    let screen: ReactTestRenderer | null = null

    beforeEach(() => { vi.resetAllMocks() })
    afterEach(async () => { await act(async () => screen?.unmount()); screen = null })

    const fill = async (label: string, value: string) => {
        await act(async () => screen!.root.findAllByType('Input' as never).find((node) => node.props.label === label)!.props.onChangeText(value))
    }
    const submit = () => screen!.root.findAllByType('Input' as never).find((node) => node.props.onSubmitEditing)!.props.onSubmitEditing() as Promise<void>
    const button = () => screen!.root.findByType('Button' as never)

    it.each(forms)('admits one $name request across keyboard and button submissions', async ({ Screen, request, values }) => {
        let finish!: () => void
        request.mockReturnValue(new Promise<void>((resolve) => { finish = resolve }))
        await act(async () => { screen = create(React.createElement(Screen)) })
        for (const [label, value] of Object.entries(values)) await fill(label, value)
        let first!: Promise<void>
        await act(async () => { first = submit(); void button().props.onPress() })
        expect(button().props.loading).toBe(true)
        await act(async () => { void submit() })
        const requestCount = request.mock.calls.length
        await act(async () => { finish(); await first })
        expect(requestCount).toBe(1)
        expect(button().props.loading).toBe(false)
        if (request === mocks.changePassword) {
            expect(mocks.success).toHaveBeenCalledOnce()
            expect(mocks.back).toHaveBeenCalledOnce()
        }
    })

    it.each(forms)('allows $name correction and retry after validation or server failure', async ({ Screen, request, values }) => {
        request.mockRejectedValueOnce(new Error('Request failed')).mockResolvedValueOnce(undefined)
        await act(async () => { screen = create(React.createElement(Screen)) })
        await act(async () => { await submit() })
        expect(request).not.toHaveBeenCalled()
        for (const [label, value] of Object.entries(values)) await fill(label, value)
        await act(async () => { await submit() })
        expect(button().props.loading).toBe(false)
        expect(screen!.root.findAllByType('Text' as never).some((node) => node.props.children === 'Request failed')
            || screen!.root.findAllByType('Input' as never).some((node) => node.props.error === 'Request failed')).toBe(true)
        await act(async () => { await submit() })
        expect(request).toHaveBeenCalledTimes(2)
    })
})
