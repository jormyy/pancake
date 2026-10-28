import { SignInForm, SignUpForm } from '@/components/auth/AuthForms'
import { AUTH_DOCUMENT_ID } from '@/components/auth/AuthHydrationFrame'
import { colors, spacing } from '@/constants/tokens'

const ignoreChange = () => {}
const releaseOnError = `
(function () {
    var release = function () { document.getElementById('${AUTH_DOCUMENT_ID}')?.remove(); };
    window.addEventListener('error', release, { once: true, capture: true });
    window.addEventListener('unhandledrejection', release, { once: true });
})();
`

export function AuthDocumentForm({ pathname }: { pathname: string }) {
    if (pathname !== '/sign-in' && pathname !== '/sign-up') return null
    const fields = {
        email: '', password: '', loading: false, error: null,
        setEmail: ignoreChange, setPassword: ignoreChange, onSubmit: ignoreChange,
    }
    return (
        <>
            <div id={AUTH_DOCUMENT_ID} inert aria-busy style={{ position: 'fixed', inset: spacing.none, display: 'flex', flexDirection: 'column', backgroundColor: colors.bgScreen, zIndex: 1 }}>
                {pathname === '/sign-in'
                    ? <SignInForm {...fields} restorationNotice={null} />
                    : <SignUpForm {...fields} username="" displayName="" setUsername={ignoreChange} setDisplayName={ignoreChange} />}
            </div>
            <script dangerouslySetInnerHTML={{ __html: releaseOnError }} />
        </>
    )
}
