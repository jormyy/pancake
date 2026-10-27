import { vi } from 'vitest'

Object.assign(globalThis, {
    __DEV__: false,
    matchMedia: () => ({ matches: false }),
    MutationObserver: class {
        observe() {}
        disconnect() {}
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
})

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'test' } } }))
