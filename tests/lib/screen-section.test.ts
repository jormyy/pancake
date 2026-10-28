import { beforeEach, expect, it, vi } from 'vitest'
import { readScreenSection, saveScreenSection } from '@/lib/screen-section'
import { clearPersistentCaches } from '@/lib/persistent-cache'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
beforeEach(() => clearPersistentCaches())
it.each([['players', 'waivers'], ['trades', 'block'], ['trades', 'history']])('restores the last %s section within its own account and membership', (screen, section) => {
    saveScreenSection('account', 'member', screen, section)
    expect(readScreenSection('account', 'member', screen)).toBe(section)
    expect(readScreenSection('other', 'member', screen)).toBeUndefined()
    expect(readScreenSection('account', 'other', screen)).toBeUndefined()
    clearPersistentCaches()
    expect(readScreenSection('account', 'member', screen)).toBeUndefined()
})
