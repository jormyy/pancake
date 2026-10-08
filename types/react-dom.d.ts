// react-dom ships with react-native-web but without typings here; only the
// portal API is used (the web shell's league menu renders on document.body).
declare module 'react-dom' {
    import type { ReactNode, ReactPortal } from 'react'
    export function createPortal(children: ReactNode, container: Element | DocumentFragment): ReactPortal
}
