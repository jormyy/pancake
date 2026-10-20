import { expect, it, vi } from 'vitest'

vi.mock('@expo-google-fonts/outfit', () => ({ Outfit_500Medium: 500, Outfit_600SemiBold: 600, Outfit_700Bold: 700 }))
vi.mock('expo-font', () => ({ FontDisplay: { OPTIONAL: 'optional', SWAP: 'swap', BLOCK: 'block' } }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))

it('forbids late display-font swaps', async () => {
    const { criticalFonts } = await import('@/constants/fonts')
    expect(Object.keys(criticalFonts).sort()).toEqual(['Outfit_500Medium', 'Outfit_600SemiBold', 'Outfit_700Bold'])
    for (const name of ['Outfit_500Medium', 'Outfit_600SemiBold', 'Outfit_700Bold'] as const) {
        expect(criticalFonts[name].display).toBe('optional')
    }
})
