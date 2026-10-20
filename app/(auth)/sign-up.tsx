import { useRef, useState } from 'react'
import { getErrorMessage } from '@/lib/shared/errors'
import { signUp } from '@/lib/auth'
import { SignUpForm } from '@/components/auth/AuthForms'
import { useAuthRouteReady } from '@/components/auth/AuthHydrationFrame'

export default function SignUpScreen() {
    useAuthRouteReady()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [username, setUsername] = useState('')
    const [displayName, setDisplayName] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const submittingRef = useRef(false)

    async function handleSignUp() {
        if (submittingRef.current) return
        if (!email || !password || !username || !displayName) {
            setError('Please fill in all fields.')
            return
        }
        if (password.length < 8) {
            setError('Password must be at least 8 characters.')
            return
        }
        if (!/^[a-z0-9_]+$/.test(username)) {
            setError('Username can only contain lowercase letters, numbers, and underscores.')
            return
        }
        submittingRef.current = true
        setLoading(true)
        setError(null)
        try {
            await signUp(email.trim(), password, username.trim(), displayName.trim())
        } catch (e) {
            setError(getErrorMessage(e) ?? 'Something went wrong.')
        } finally {
            submittingRef.current = false
            setLoading(false)
        }
    }

    return (
        <SignUpForm
            email={email}
            password={password}
            username={username}
            displayName={displayName}
            loading={loading}
            error={error}
            setEmail={setEmail}
            setPassword={setPassword}
            setUsername={setUsername}
            setDisplayName={setDisplayName}
            onSubmit={handleSignUp}
        />
    )
}
