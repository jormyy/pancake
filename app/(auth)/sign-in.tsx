import { useRef, useState } from 'react'
import { getErrorMessage } from '@/lib/shared/errors'
import { signIn } from '@/lib/auth'
import { useAuth } from '@/hooks/use-auth'
import { SignInForm } from '@/components/auth/AuthForms'
import { useAuthRouteReady } from '@/components/auth/AuthHydrationFrame'

export default function SignInScreen() {
    useAuthRouteReady()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const submittingRef = useRef(false)
    const { restorationStatus, loading: authLoading } = useAuth()
    const restorationNotice = authLoading ? null : restorationStatus === 'expired'
        ? 'Your session expired. Reconnect or sign in to continue.'
        : restorationStatus === 'unavailable'
            ? 'Your session cannot be checked. Reconnect or sign in to continue.'
            : restorationStatus === 'invalid' ? 'Sign in again to restore your session.' : null

    async function handleSignIn() {
        if (submittingRef.current) return
        if (!email || !password) {
            setError('Please fill in all fields.')
            return
        }
        submittingRef.current = true
        setLoading(true)
        setError(null)
        try {
            await signIn(email.trim(), password)
        } catch (e) {
            setError(getErrorMessage(e) ?? 'Something went wrong.')
        } finally {
            submittingRef.current = false
            setLoading(false)
        }
    }

    return (
        <SignInForm
            email={email}
            password={password}
            loading={loading}
            error={error}
            restorationNotice={restorationNotice}
            setEmail={setEmail}
            setPassword={setPassword}
            onSubmit={handleSignIn}
        />
    )
}
